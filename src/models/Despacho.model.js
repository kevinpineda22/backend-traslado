import { supabase } from "../config/supabase.js";
import * as ConteoModel from "./RecepcionConteo.model.js";

const TABLE = "traslados_despachos";

// Estados finales: el traslado ya se cerró (el stock se movió / no aplica).
const ESTADOS_FINALES = ["Auditado", "Rechazado", "Recibido_con_inconsistencia"];

/**
 * Aplica el filtro de visibilidad por `inactivo` a una query.
 *
 * Por DEFECTO oculta los inactivos, y eso es deliberado: los paneles del
 * despachador y del auditor no deben verlos, y ese filtro tiene que vivir acá —
 * en la única puerta por la que salen los despachos — y no en cada panel. Si cada
 * front decidiera por su cuenta, el próximo panel que alguien agregue nace
 * mostrando traslados inactivos y nadie se entera.
 *
 * @param query - query de Supabase
 * @param {object} filters
 * @param {boolean} [filters.inactivo]           - true = SOLO inactivos (panel de alertas)
 * @param {boolean} [filters.incluir_inactivos]  - true = activos + inactivos
 */
function aplicarFiltroInactivo(query, filters = {}) {
  if (filters.inactivo === true) return query.eq("inactivo", true);
  if (filters.incluir_inactivos === true) return query;
  return query.eq("inactivo", false);
}

/**
 * Ítems que están en despachos ACTIVOS (no finalizados). Sirve para avisar al
 * admin que un ítem+origen ya tiene un traslado en curso: el stock todavía no se
 * descontó, así que crear otro puede sobre-asignar inventario.
 * Devuelve una lista plana: { origen, codigo_item, created_at, destino, estado }.
 */
export async function itemsEnDespachosActivos() {
  const { data, error } = await supabase
    .from(TABLE)
    .select("id, origen, destino, created_at, estado, traslados_items(codigo_item)")
    .not("estado", "in", `(${ESTADOS_FINALES.join(",")})`)
    // Un borrador todavía no es un traslado comprometido: es la lista que el admin
    // está armando. Incluirlo haría que el panel le avise de su PROPIO borrador
    // mientras lo llena — un aviso que aparece siempre deja de avisar nada.
    .neq("estado", "Borrador")
    // Un traslado inactivo no va a salir de la bodega, así que no compite por el
    // stock. Avisar por él sería frenar un traslado bueno por uno congelado.
    .eq("inactivo", false)
    .order("created_at", { ascending: false });

  if (error) throw new Error(`Error al leer despachos activos: ${error.message}`);

  const out = [];
  for (const d of data || []) {
    for (const it of d.traslados_items || []) {
      out.push({
        despacho_id: d.id,
        origen: d.origen,
        destino: d.destino,
        estado: d.estado,
        created_at: d.created_at,
        codigo_item: String(it.codigo_item),
      });
    }
  }
  return out;
}

/**
 * Obtener todos los despachos, opcionalmente filtrados por estado.
 * @param {object} filters - { estado, despachador_id, admin_id }
 */
export async function findAll(filters = {}) {
  let query = supabase.from(TABLE).select("*");

  // estado puede venir como string ('Creado') o array (['Creado','En_recoleccion'])
  // — los paneles filtran por varios estados a la vez.
  if (Array.isArray(filters.estado)) query = query.in("estado", filters.estado);
  else if (filters.estado) query = query.eq("estado", filters.estado);

  query = aplicarFiltroInactivo(query, filters);

  // Sede de quien consulta (migración 025). Sale TODO lo que menciona a esa
  // bodega, sea como origen o como destino — no solo lo que arranca ahí.
  //
  // La primera versión miraba solo el `origen`, razonando que despachar es sacar
  // mercancía de la propia bodega. Pero eso dejaba a Llano con el panel vacío
  // aunque tuviera un traslado en camino, y no ver lo que te van a mandar es peor
  // que verlo de más: el traslado te concierne igual.
  //
  // Lo resuelve el controlador desde el correo, nunca lo manda el cliente. Sin
  // sede no filtra: ese es el alcance de quien las ve todas.
  if (filters.sede_origen) {
    const s = filters.sede_origen;
    query = query.or(`origen.eq.${s},destino.eq.${s}`);
  }

  if (filters.sin_asignar) {
    query = query.is("despachador_id", null);
  } else if (filters.despachador_id) {
    query = query.eq("despachador_id", filters.despachador_id);
  }
  if (filters.admin_id) query = query.eq("admin_id", filters.admin_id);

  const { data, error } = await query.order("created_at", { ascending: false });

  if (error) throw new Error(`Error al listar despachos: ${error.message}`);
  return data;
}

/**
 * Obtener un despacho por ID con sus items y firmas.
 */
export async function findById(id) {
  // Ítems agrupados por grupo (proveniente de items_siesa) y ordenados
  // alfabéticamente dentro del grupo. Despachador y auditor leen ambos por acá.
  // Los sin grupo caen al final (null ordena último en ascendente).
  const { data: despacho, error } = await supabase
    .from(TABLE)
    .select("*, traslados_items(*), traslados_firmas(*)")
    .eq("id", id)
    .order("grupo", { referencedTable: "traslados_items", ascending: true })
    .order("descripcion", { referencedTable: "traslados_items", ascending: true })
    // `maybeSingle` y no `single`: un id que no existe es `null` (los llamadores
    // responden 404), no un error de base que sale como 500.
    .maybeSingle();

  if (error) throw new Error(`Error al obtener despacho: ${error.message}`);
  return despacho;
}

/** Mapea un ítem del payload del admin a la fila de `traslados_items`. */
function aFilaItem(despachoId, item) {
  return {
    despacho_id: despachoId,
    codigo_item: item.codigo_item,
    descripcion: item.descripcion,
    unidad_medida: item.unidad_medida,
    factor: item.factor ?? 1,
    rotacion: item.rotacion,
    grupo: item.grupo || null,
    // Snapshot de la categoría: si SIESA reclasifica el producto mañana, el
    // despacho ya cerrado debe seguir contando la historia que vio el admin.
    categoria: item.categoria || null,
    stock_origen: item.stock_origen,
    stock_destino: item.stock_destino,
    consumo_destino: item.consumo_destino,
    stock_seguridad: item.stock_seguridad,
    sugerido: item.sugerido,
    cantidad_admin: item.cantidad,
    // Peso de UNA unidad base, en gramos (migración 017). Llega como `volumen`
    // porque así se llama la columna del snapshot, pero el dato es peso — ver el
    // comentario de la 017. Se copia acá, como el resto del snapshot del ítem: el
    // cron pisa `traslados_snapshot` todos los días, y el manifiesto tiene que
    // poder reconstruirse igual dentro de un año.
    peso_unitario: item.volumen ?? item.peso_unitario ?? null,
  };
}

/**
 * Crear un despacho con sus items.
 *
 * `estado` decide si nace listo para el despachador ("Creado", el caso normal) o
 * como lista en construcción ("Borrador", los dos flujos — ver
 * agregarItemsBorrador). `disponible_at` solo se sella cuando nace en "Creado":
 * es el reloj de las alertas de inactividad, y un borrador todavía no espera a nadie.
 *
 * @param {object} payload - { origen, destino, despachador_id, admin_id, criterios, items[], estado? }
 */
export async function create(payload) {
  const { items, estado, ...cabecera } = payload;
  const estadoInicial = estado === "Borrador" ? "Borrador" : "Creado";
  const ahora = new Date().toISOString();

  // 1. Insertar cabecera
  const { data: despacho, error: errCab } = await supabase
    .from(TABLE)
    .insert({
      flujo: cabecera.flujo || "general",
      origen: cabecera.origen || "PV001",
      destino: cabecera.destino,
      despachador_id: cabecera.despachador_id,
      admin_id: cabecera.admin_id,
      criterios: cabecera.criterios,
      estado: estadoInicial,
      disponible_at: estadoInicial === "Creado" ? ahora : null,
      // Hito (no reloj): cuándo quedó a la vista del despachador. Ver migración 039.
      publicado_at: estadoInicial === "Creado" ? ahora : null,
    })
    .select()
    .single();

  if (errCab) {
    // El índice parcial `idx_despachos_borrador_unico` garantiza un solo borrador
    // abierto por (origen, destino). Traducimos el choque a un 409 legible: el
    // caso real es el admin con dos pestañas abiertas, no un bug.
    if (errCab.code === "23505" && estadoInicial === "Borrador") {
      const e = new Error(
        "Ya existe un listado en curso para esta ruta. Recargá la página para verlo.",
      );
      e.statusCode = 409;
      e.expose = true;
      throw e;
    }
    throw new Error(`Error al crear despacho: ${errCab.message}`);
  }

  // 2. Insertar items (con snapshot de lo que vio el admin)
  if (items?.length > 0) {
    const { error: errItems } = await supabase
      .from("traslados_items")
      .insert(items.map((item) => aFilaItem(despacho.id, item)));

    if (errItems) {
      // Sin los ítems, la cabecera es un traslado fantasma: aparece en el pool del
      // despachador como una lista vacía (o bloquea la ruta, si es un borrador) y
      // el admin cree que se guardó. Se borra para que el reintento empiece limpio.
      const { error: errLimpiar } = await supabase.from(TABLE).delete().eq("id", despacho.id);
      if (errLimpiar) {
        console.error(
          `[despacho] quedó la cabecera ${despacho.id} sin ítems y no se pudo borrar: ${errLimpiar.message}`,
        );
      }
      throw new Error(`Error al insertar items: ${errItems.message}`);
    }
  }

  // Respondemos con la cabecera (rápido). NO hacemos read-back con join de todos
  // los items: con despachos grandes eso demora la respuesta aunque el insert ya
  // terminó, y el front solo necesita confirmación.
  return { ...despacho, items_creados: items?.length || 0 };
}

/**
 * Actualizar el estado de un despacho validando la transición.
 *
 * @param {string} id
 * @param {string} nuevoEstado
 * @param {object} [opts]
 * @param {string} [opts.despachadorId] - Si se pasa, exige que el despacho sea
 *   de ese despachador (candado de propiedad). Se usa al CERRAR la recolección
 *   (En_recoleccion → Recolectado): impide que un segundo despachador — lista
 *   vieja, otra pestaña, el monitor — cierre un despacho que no reclamó. El
 *   auditor y el admin llaman sin este opt y conservan el comportamiento previo.
 *
 * Atómico: el UPDATE se ata al estado leído (`.eq("estado", actual.estado)`), así
 * dos cierres concurrentes no pasan los dos — el segundo no matchea y recibe 409.
 */
export async function updateStatus(id, nuevoEstado, { despachadorId } = {}) {
  const TRANSICIONES = {
    // Borrador = lista en construcción (General y Llano). Su única salida es
    // "Creado" (finalizar el despacho), y la hace `finalizarBorrador`.
    Borrador: ["Creado"],
    Creado: ["En_recoleccion"],
    // Terminar de contar ya NO cierra el despacho: queda esperando el camión.
    // Se permite volver a `En_recoleccion` porque finalizar de más es un error
    // barato de cometer y caro de arreglar: sin la vuelta, un despachador que se
    // equivocó en una cantidad tendría que abandonar y contar todo de nuevo.
    En_recoleccion: ["Pendiente_carga"],
    Pendiente_carga: ["En_recoleccion", "Recolectado"],
    Recolectado: ["En_recepcion", "Auditado", "Rechazado", "Recibido_con_inconsistencia"],
    En_recepcion: ["Auditado", "Rechazado", "Recibido_con_inconsistencia"],
    Auditado: [],
    Rechazado: [],
    Recibido_con_inconsistencia: [],
  };

  // Leer estado + dueño actuales
  const { data: actual } = await supabase
    .from(TABLE)
    .select("estado, despachador_id, inactivo")
    .eq("id", id)
    .single();

  if (!actual) {
    const e = new Error("Despacho no encontrado");
    e.statusCode = 404;
    e.expose = true;
    throw e;
  }

  // Un traslado inactivo está congelado: no avanza hasta que alguien lo reactive
  // desde el panel. El chequeo va acá, en la única puerta por la que se avanza el
  // estado, y no en cada llamador — un panel con la lista vieja en pantalla puede
  // intentar cerrarlo después de que el barrido lo inactivó.
  if (actual.inactivo) {
    const e = new Error(
      "Este traslado está inactivo. Reactivalo desde el panel de alertas para continuar.",
    );
    e.statusCode = 409;
    e.expose = true;
    throw e;
  }

  const permitidos = TRANSICIONES[actual.estado] ?? [];
  if (!permitidos.includes(nuevoEstado)) {
    const e = new Error(
      `Transición inválida: ${actual.estado} → ${nuevoEstado}. Permitidas: ${permitidos.join(", ") || "ninguna"}`,
    );
    e.statusCode = 409;
    e.expose = true;
    throw e;
  }

  // Candado de propiedad: si se exige dueño y el despacho ya tiene uno distinto,
  // no lo dejamos avanzar (403). No es autenticación real — el despachador_id
  // viaja en el body y es falsificable — pero frena el choque ACCIDENTAL entre
  // dos despachadores legítimos, que es el caso real. Blindaje contra spoofing
  // llega con la auth real (ver roadmap del sistema).
  if (despachadorId && actual.despachador_id && actual.despachador_id !== despachadorId) {
    const e = new Error("Este despacho lo está gestionando otro despachador");
    e.statusCode = 403;
    e.expose = true;
    throw e;
  }

  // UPDATE atómico: atado al estado leído (cierra la ventana TOCTOU) y, si se
  // exige dueño, también al despachador_id.
  const ahora = new Date().toISOString();
  const patch = { estado: nuevoEstado, updated_at: ahora };
  // Trazabilidad de tiempos (#1): estampamos el hito según el estado destino.
  //
  // `recoleccion_finalizada_at` va en `Pendiente_carga`, NO en `Recolectado`: el
  // hito es "cuándo terminó de contar", y desde la 017 esas son dos cosas
  // distintas (contar termina antes; el camión puede llegar horas después). Medir
  // la recolección hasta la carga del camión inflaría el tiempo del despachador
  // con la espera del transporte.
  if (nuevoEstado === "Pendiente_carga") patch.recoleccion_finalizada_at = ahora;
  // Publicación por la puerta genérica (hoy la hace `finalizarBorrador`, pero la
  // transición está permitida acá y el hito no puede depender de por dónde entró).
  if (nuevoEstado === "Creado" && actual.estado === "Borrador") patch.publicado_at = ahora;
  // Arranque REAL de la recepción (migración 039): la entrada a En_recepcion la
  // hace `senalarRecepcionActiva` con el primer conteo guardado — escaneo suelto o
  // canastilla, los tres caminos de recepción pasan por ahí. De En_recepcion no se
  // vuelve, así que esto ocurre UNA vez por traslado sin necesitar `.is(null)`.
  //
  // Se marca acá y no en `auditoria_iniciada_at` porque esa columna cambió de
  // definición en la 036 (antes: primer Comparar; después: primer escaneo) y mezcla
  // las dos según la fecha. Esta tiene una sola. Un panel viejo, que no guarda
  // escaneos, pasa de Recolectado a la firma sin entrar a En_recepcion: no recibe
  // la marca y queda fuera de las medianas en vez de contaminarlas.
  if (nuevoEstado === "En_recepcion") patch.recepcion_iniciada_at = ahora;
  if (["Auditado", "Rechazado", "Recibido_con_inconsistencia"].includes(nuevoEstado)) {
    patch.auditoria_finalizada_at = ahora;
  }

  // Entrega de posta al auditor: se re-sella el reloj de inactividad y se limpia
  // la marca de la alerta de la etapa anterior. Sin el reset, un traslado que ya
  // disparó la alerta de recolección arrastraría esa marca y —si vuelve a
  // estancarse esperando auditoría— la alerta del auditor saldría sobre un reloj
  // viejo. Cada etapa mide su propia espera.
  //
  // `disponible_at` arranca igual a `recoleccion_finalizada_at` acá, pero NO son
  // lo mismo: el hito es historial y no se toca más; el reloj se reinicia si
  // alguien reactiva el traslado (ver setActivo).
  if (nuevoEstado === "Recolectado") {
    patch.disponible_at = ahora;
    patch.alerta_recoleccion_at = null;
  }
  let q = supabase
    .from(TABLE)
    .update(patch)
    .eq("id", id)
    .eq("estado", actual.estado);
  if (despachadorId) q = q.eq("despachador_id", despachadorId);

  const { data, error } = await q.select().single();

  if (error || !data) {
    const e = new Error("El despacho cambió de estado o de dueño mientras se cerraba");
    e.statusCode = 409;
    e.expose = true;
    throw e;
  }
  return data;
}

/**
 * Estampa `auditoria_iniciada_at` la PRIMERA vez que el auditor compara (empieza
 * a contar). Idempotente: el `.is(..., null)` hace que reintentos NO lo pisen, así
 * queda el primer comparar y no el último. Trazabilidad (#1). Best-effort. */
export async function marcarAuditoriaIniciada(id) {
  await supabase
    .from(TABLE)
    .update({ auditoria_iniciada_at: new Date().toISOString() })
    .eq("id", id)
    .is("auditoria_iniciada_at", null);
}

/**
 * Señal de actividad: "un auditor está trabajando en este traslado AHORA".
 *
 * A diferencia de `marcarAuditoriaIniciada`, esta NO es idempotente: se re-sella
 * en cada toque, a propósito. Lo que interesa no es si alguna vez lo abrieron,
 * sino hace cuánto — un traslado abierto hace 10 minutos tiene a alguien contando;
 * uno abierto anteayer y nunca confirmado está abandonado, y ese sí hay que
 * alertarlo. Ver migración 015.
 *
 * Best-effort: la llama una LECTURA (`obtenerDetalle`), así que nunca puede hacer
 * fallar la respuesta que el auditor está esperando para ponerse a contar.
 */
export async function marcarAuditoriaAbierta(id) {
  const { error } = await supabase
    .from(TABLE)
    .update({ auditoria_abierta_at: new Date().toISOString() })
    .eq("id", id);
  if (error) console.error(`[auditoria] no se pudo marcar actividad en ${id}:`, error.message);
}

/**
 * Guarda de las escrituras de recolección (`POST /recolectar`): verifica que el
 * despacho exista, no esté inactivo y esté En_recoleccion.
 *
 * NO valida propiedad. Desde la 023 el despacho es COMPARTIDO: cualquier cantidad
 * de personas puede recolectarlo a la vez. Quién puede escribir cada producto lo
 * decide el candado por renglón (`ItemModel.updateCantidadDespachador`), no esta
 * función. Ver el comentario al final del cuerpo.
 *
 * @param {string} id
 * @param {string} [despachadorId] - se acepta por compatibilidad; ya no se usa acá
 * @throws 404 si no existe, 409 si está inactivo o no está En_recoleccion
 */
export async function assertPuedeRecolectar(id, despachadorId) {
  const { data: d, error } = await supabase
    .from(TABLE)
    .select("estado, despachador_id, inactivo")
    .eq("id", id)
    .single();

  if (error || !d) {
    const e = new Error("Despacho no encontrado");
    e.statusCode = 404;
    e.expose = true;
    throw e;
  }
  if (d.inactivo) {
    const e = new Error(
      "Este traslado está inactivo. Reactivalo desde el panel de alertas para continuar.",
    );
    e.statusCode = 409;
    e.expose = true;
    throw e;
  }
  if (d.estado !== "En_recoleccion") {
    const e = new Error(`No se puede recolectar: el despacho está en estado ${d.estado}`);
    e.statusCode = 409;
    e.expose = true;
    throw e;
  }
  // ACÁ YA NO HAY CANDADO DE PROPIEDAD (migración 023).
  //
  // Hasta la 022 esto devolvía 403 si el despacho era de otro despachador. Un
  // traslado grande no lo cuenta una persona sola, y ese 403 dejaba al segundo sin
  // poder ni escanear: la operación lo resolvía compartiendo un mismo usuario, y
  // con eso se perdía quién contó qué.
  //
  // El candado no se quitó, se BAJÓ DE NIVEL: ahora vive en el renglón
  // (`traslados_items.recolectado_por`, ver `ItemModel.updateCantidadDespachador`).
  // El despacho es compartido; el producto es de quien lo contó primero. Lo que
  // esta función protege sigue igual de firme: que exista, que no esté inactivo y
  // que esté En_recoleccion.
  return d;
}

/**
 * Candado para CARGAR EL CAMIÓN (`POST /cargar`). Hermano de
 * `assertPuedeRecolectar`, pero exige `Pendiente_carga` en vez de
 * `En_recoleccion`: cargar es el paso siguiente a haber terminado de contar.
 *
 * Se mantiene separado a propósito y no se generaliza el otro: `assertPuedeRecolectar`
 * está probado en producción y protege otra escritura (`/recolectar`). Un estado
 * distinto es toda la diferencia, y duplicar 15 líneas es más barato que arriesgar
 * el guard que ya funciona.
 *
 * @throws 404 si no existe, 409 si no está Pendiente_carga (ej: ya se cargó y está
 *   en Recolectado — un reintento tardío).
 */
export async function assertPuedeCargar(id, despachadorId) {
  const { data: d, error } = await supabase
    .from(TABLE)
    .select("estado, despachador_id, inactivo")
    .eq("id", id)
    .single();

  if (error || !d) {
    const e = new Error("Despacho no encontrado");
    e.statusCode = 404;
    e.expose = true;
    throw e;
  }
  if (d.inactivo) {
    const e = new Error(
      "Este traslado está inactivo. Reactivalo desde el panel de alertas para continuar.",
    );
    e.statusCode = 409;
    e.expose = true;
    throw e;
  }
  if (d.estado !== "Pendiente_carga") {
    const e = new Error(
      `No se puede cargar el camión: el despacho está en estado ${d.estado}. ` +
        "Primero hay que finalizar la recolección.",
    );
    e.statusCode = 409;
    e.expose = true;
    throw e;
  }
  // Sin candado de propiedad, por lo mismo que `assertPuedeRecolectar` (023): si
  // el despacho lo contaron tres personas, cargar el camión le toca a la que esté
  // cuando llega el camión, no necesariamente a la que apretó "Iniciar" primero.
  //
  // Que dos lo cierren a la vez ya lo impide el estado: el primero lo mueve a
  // `Recolectado` y el segundo choca contra el 409 de arriba. El manifiesto además
  // es idempotente (`cargarCamion` reusa el existente).
  return d;
}

/**
 * Iniciar recolección — o SUMARSE a una ya empezada (modelo pool + multiusuario).
 *
 * Dos caminos, y el segundo es nuevo desde la 023:
 *   · `Creado`        → se reclama con un UPDATE atómico (`.eq("estado","Creado")`)
 *                       y queda como `despachador_id` quien lo arrancó.
 *   · `En_recoleccion`→ ya lo empezó un compañero: se entra igual, sin pisar nada.
 *
 * Solo lanza cuando entrar NO tiene sentido: el despacho se inactivó o ya avanzó
 * más allá de la recolección.
 */
export async function iniciarRecoleccion(id, despachadorId) {
  const patch = {
    estado: "En_recoleccion",
    updated_at: new Date().toISOString(),
    recoleccion_iniciada_at: new Date().toISOString(), // trazabilidad (#1)
  };
  if (despachadorId) patch.despachador_id = despachadorId;

  const { data, error } = await supabase
    .from(TABLE)
    .update(patch)
    .eq("id", id)
    .eq("estado", "Creado")
    // Un inactivo no se puede reclamar. Va atado al mismo UPDATE atómico y no en
    // un chequeo previo: entre leer y escribir, el barrido pudo inactivarlo.
    .eq("inactivo", false)
    .select()
    .single();

  if (data) return data;

  // NO SE PUDO RECLAMAR — falta distinguir dos casos que hasta la 022 eran uno.
  //
  // El UPDATE exige `estado = 'Creado'`, así que no haber podido significa que
  // alguien ya lo movió. Antes eso era siempre un 409 ("ya fue tomado"), y estaba
  // bien cuando el despacho tenía un solo dueño posible. Con la recolección
  // multiusuario (023) el caso más común pasó a ser el contrario: el compañero ya
  // lo inició y esta persona viene a SUMARSE, no a reclamarlo.
  //
  // Así que se relee: si está `En_recoleccion` y activo, entrar es legítimo y se
  // devuelve el despacho tal cual — sin pisar `despachador_id` (queda quien lo
  // inició, que es el dato honesto) ni `recoleccion_iniciada_at` (el hito es el
  // arranque real, no cuándo se sumó el tercero).
  const { data: actual } = await supabase
    .from(TABLE)
    .select("*")
    .eq("id", id)
    .single();

  if (actual && actual.estado === "En_recoleccion" && !actual.inactivo) {
    return actual;
  }

  const err = new Error(
    actual?.inactivo
      ? "Este traslado está inactivo. Reactivalo desde el panel de alertas para continuar."
      : `El despacho ya no se puede tomar: está en estado ${actual?.estado || "desconocido"}`,
  );
  err.statusCode = 409;
  err.expose = true;
  return Promise.reject(err);
}

/**
 * Abandonar la recolección: devuelve el despacho al POOL (estado Creado, sin
 * despachador) para que otra persona lo tome. Atómico y con candado de propiedad:
 * solo avanza si SIGUE En_recoleccion Y el que llama es el dueño — así nadie
 * suelta un despacho ajeno ni pisa un cambio de estado concurrente.
 * El reset de las cantidades de los ítems lo hace el service, tras este flip.
 */
export async function abandonarRecoleccion(id, despachadorId) {
  const ahora = new Date().toISOString();
  const { data, error } = await supabase
    .from(TABLE)
    .update({
      estado: "Creado",
      despachador_id: null,
      updated_at: ahora,
      // Vuelve al pool ⇒ el reloj de inactividad arranca de nuevo y la alerta
      // puede volver a salir. Si conserváramos el `disponible_at` original, un
      // traslado tomado y soltado a las 4 horas dispararía la alerta al instante,
      // culpando al pool por el tiempo que estuvo en manos de alguien.
      disponible_at: ahora,
      alerta_recoleccion_at: null,
    })
    .eq("id", id)
    .eq("estado", "En_recoleccion")
    .eq("despachador_id", despachadorId)
    .select()
    .single();

  if (error || !data) {
    // Leer el estado real para devolver el código correcto (403 vs 409 vs 404).
    const { data: actual } = await supabase
      .from(TABLE)
      .select("estado, despachador_id")
      .eq("id", id)
      .single();
    if (!actual) {
      const e = new Error("Despacho no encontrado");
      e.statusCode = 404;
      e.expose = true;
      throw e;
    }
    if (actual.estado !== "En_recoleccion") {
      const e = new Error(`No se puede abandonar: el despacho está en estado ${actual.estado}`);
      e.statusCode = 409;
      e.expose = true;
      throw e;
    }
    const e = new Error("Solo el despachador que reclamó el despacho puede abandonarlo");
    e.statusCode = 403;
    e.expose = true;
    throw e;
  }
  return data;
}

/**
 * ¿Este renglón se mudaría a la parte 2?
 *
 * "Sin tocar" = nadie pasó por ese producto: no anotó cantidad, no lo marcó
 * agotado y no le puso motivo. Un renglón CON motivo sí fue atendido —alguien
 * fue al pasillo y decidió algo— así que se queda en la primera parte.
 *
 * EL MOTIVO SIGNIFICA COSAS DISTINTAS ANTES Y DESPUÉS DE CERRAR, y por eso el
 * criterio cambia con el estado:
 *
 *   · EN RECOLECCIÓN — el motivo lo puso UNA PERSONA que fue al pasillo y
 *     decidió. Ese renglón fue atendido: se queda, y su dato viaja hoy.
 *
 *   · DESPUÉS DE CERRAR — los motivos los puso la AUTO-CLASIFICACIÓN del Llano
 *     (ver `cambiarEstado`), que no sabe si la persona fue al pasillo o si se
 *     quedó sin turno. Cuando fue lo segundo, "Inventario Fantasma" es una
 *     conclusión falsa (ver el encabezado de sql/032: es el error que la segunda
 *     parte vino a evitar). Ahí el único criterio honesto es más simple: lo que
 *     NO VIAJÓ se puede volver a mandar, haya tenido motivo automático o no.
 *
 * Generar la parte 2 después del cierre RETRACTA esos motivos automáticos: la
 * mudanza limpia `motivo` y `agotado` para que la parte 2 nazca en blanco. Eso
 * borra novedades que Compras e Inventarios ya pudieron ver por
 * `/api/integraciones`, y cambia hacia atrás la analítica de confiabilidad de
 * inventario de ese traslado. Es el precio de poder corregir una clasificación
 * equivocada, y lo decide el admin apretando el botón — no pasa solo.
 *
 * EN RECOLECCIÓN EL PREDICADO SE ESCRIBE DOS VECES Y LAS DOS TIENEN QUE DECIR
 * LO MISMO:
 *   1. acá, en JS, para CONTAR (el `movibles` del resumen del monitor y la cerca
 *      de `dividirEnPartes`);
 *   2. en el filtro PostgREST del UPDATE que hace la mudanza:
 *      `.is("motivo", null).not("agotado", "is", true)
 *      .or("cantidad_despachador.is.null,cantidad_despachador.eq.0")`.
 *
 * La segunda no se puede reusar desde acá: es un filtro que evalúa la base, no
 * una función. Si se cambia una, HAY QUE CAMBIAR LAS DOS —
 * `test/despacho.envio-por-partes.test.js` las ata y falla si se separan.
 *
 * YA CERRADO la mudanza va por ids (ver `dividirEnPartes`), así que esta función
 * es la ÚNICA definición del criterio y no hay nada que mantener en paralelo.
 *
 * POR QUÉ IMPORTA QUE COINCIDAN
 * Desde que partir es una acción del ADMIN y no del despachador, la decisión se
 * toma mirando un número en el monitor, no la lista renglón por renglón. Si el
 * número que se ve y el que se mueve no son el mismo, la primera vez que alguien
 * lo note deja de confiar en el panel — y con razón.
 *
 * OJO: NO es lo mismo que el `pendientes` del resumen. Ese cuenta "sin cantidad
 * anotada" y no mira el motivo, así que incluye renglones con motivo (que NO se
 * mudan) y excluye los que quedaron en 0 sin motivo (que SÍ se mudan). Son dos
 * preguntas distintas, las dos son correctas, y por eso conviven.
 *
 * @param {object} item - con `motivo`, `agotado` y `cantidad_despachador`
 * @param {string} [estado] - estado del despacho; "En_recoleccion" aplica la
 *   regla estricta (respeta los motivos puestos a mano). Cualquier otro aplica
 *   la de "no viajó".
 * @returns {boolean}
 */
export function esMovibleAParte2(item, estado = "En_recoleccion") {
  // Lo que no viajó: no hay nada físico que esté en el camión ni en SIESA (la
  // requisición solo lleva `cantidad_despachador > 0`), así que mandarlo de nuevo
  // no contradice ningún documento ya emitido.
  const noViajo =
    item.cantidad_despachador == null || Number(item.cantidad_despachador) === 0;
  if (!noViajo) return false;
  if (estado === "En_recoleccion") return !item.motivo && !item.agotado;
  return true;
}

/** Estados en los que NO se puede partir: todavía no salió nada que dejar atrás. */
const NO_PARTIBLES = ["Borrador", "Creado"];

/**
 * DIVIDIR EN PARTES — manda lo que ya está listo y pasa el resto a un traslado
 * nuevo (ver sql/032).
 *
 * QUÉ SE QUEDA Y QUÉ SE VA
 *   · Se QUEDA lo que la persona atendió: contado (> 0) o con un motivo puesto a
 *     mano. Un fantasma marcado por alguien que fue al pasillo es un dato real y
 *     viaja en el cierre de hoy.
 *   · Se VA lo que nadie tocó: sin motivo, sin `agotado`, en 0 o en null.
 *
 * Es EXACTAMENTE el mismo criterio con el que la auto-clasificación del flujo
 * llano decide a quién ponerle motivo (ver `cambiarEstado`). Tiene que ser el
 * mismo: lo que se lleva la parte 2 es justo lo que, de quedarse, se llevaría un
 * motivo inventado.
 *
 * POR QUÉ SE MUEVEN LAS FILAS EN VEZ DE COPIARLAS
 * Se reapunta `despacho_id`. Copiar obligaría a reconstruir la foto del ítem
 * (stock de origen y destino, consumo, sugerido, peso) que se tomó cuando el
 * admin armó el traslado, y cualquier campo que se olvide sale como un dato
 * plausible pero falso. Moviendo, la foto viaja intacta.
 *
 * `recolectado_por` se limpia en los que se mueven: el candado por renglón
 * (migración 023) dice quién lo está contando AHORA, y en la parte 2 no lo está
 * contando nadie todavía. Si quedara sellado, el que la tome mañana se comería
 * un "lo está contando otra persona" sobre un renglón que nadie tiene.
 *
 * `cantidad_despachador` también vuelve a null: lo que se muda es por definición
 * lo que nadie recolectó, y un 0 sin motivo es eso mismo. Si viajara el 0, la
 * parte 2 nacería "contada en cero" — el despachador la vería como faltantes ya
 * registrados, no como productos por recorrer.
 *
 * EL MOVIMIENTO ES UNA SOLA ESCRITURA CONDICIONAL
 * No se mudan "los ids que se leyeron": se mudan las filas que, AL MOMENTO DE
 * ESCRIBIR, siguen en este despacho y siguen sin tocar. Entre la lectura y el
 * UPDATE alguien puede estar contando: si registró un producto en ese instante,
 * ese producto ya no cumple la condición y se queda en la primera parte con su
 * conteo. Leer la lista y mudar por id se llevaba a la parte 2 renglones recién
 * contados (con su cantidad adentro) sin que nadie lo notara.
 *
 * @param {string} id - despacho a dividir
 * @returns {Promise<{ despacho: object, parte2: object, movidos: number }>}
 */
export async function dividirEnPartes(id) {
  const { data: cab } = await supabase
    .from(TABLE)
    .select("estado, origen, destino, flujo, criterios, admin_id, inactivo, parte_num")
    .eq("id", id)
    .single();

  if (!cab) {
    const e = new Error("Despacho no encontrado");
    e.statusCode = 404;
    e.expose = true;
    throw e;
  }
  if (cab.inactivo) {
    const e = new Error("Este traslado está inactivo. Reactivalo desde el panel de alertas.");
    e.statusCode = 409;
    e.expose = true;
    throw e;
  }
  // Se puede partir EN CUALQUIER MOMENTO desde que empezó la recolección, incluso
  // con el traslado ya cerrado o recibido. Antes solo se podía en "En_recoleccion"
  // porque después los motivos automáticos ensuciaban la parte 2; ahora la mudanza
  // los limpia (ver `esMovibleAParte2`), así que el caso real —el despachador se
  // quedó sin turno, cerró, y lo que no alcanzó quedó marcado Fantasma— tiene
  // arreglo en vez de obligar a armar un listado nuevo a mano.
  //
  // Borrador y Creado quedan afuera: ahí todavía no salió NADA, así que no hay una
  // "primera parte" que dejar atrás. Lo que se quiere ahí es editar la lista o
  // descartarla, y para eso están `editarItems` y `descartarListado`.
  if (NO_PARTIBLES.includes(cab.estado)) {
    const e = new Error(
      `Este traslado está en ${cab.estado}: todavía no salió nada. Editá la lista en vez de partirla.`,
    );
    e.statusCode = 409;
    e.expose = true;
    throw e;
  }

  const { data: items, error: errItems } = await supabase
    .from("traslados_items")
    .select("id, cantidad_despachador, motivo, agotado")
    .eq("despacho_id", id);
  if (errItems) throw new Error(`Error al leer los ítems: ${errItems.message}`);

  // Mismo predicado que el `movibles` del monitor — ver `esMovibleAParte2`.
  const sinTocar = (items || []).filter((it) => esMovibleAParte2(it, cab.estado));
  const atendidos = (items || []).length - sinTocar.length;

  if (sinTocar.length === 0) {
    const e = new Error(
      "No hay productos pendientes: todos los renglones de este traslado salieron.",
    );
    e.statusCode = 409;
    e.expose = true;
    throw e;
  }
  if (atendidos === 0) {
    const e = new Error(
      "No salió ningún producto en este traslado, así que no hay una primera parte que dejar atrás: " +
        "se partiría en dos dejando uno vacío. Si no se recolectó nada, lo que corresponde es reasignarlo.",
    );
    e.statusCode = 409;
    e.expose = true;
    throw e;
  }

  const ahora = new Date().toISOString();

  // Cerca: el despacho tiene que seguir EN EL MISMO ESTADO con el que se calculó
  // qué se mueve. La lectura de arriba puede tener segundos, y el criterio cambia
  // con el estado (ver `esMovibleAParte2`): si en el medio alguien cerró la
  // recolección, los renglones que acá contamos como "sin tocar" ya recibieron sus
  // motivos automáticos y la lista a mudar sería otra. Se ata a un UPDATE
  // condicional para que verificar y seguir sean la misma operación.
  const { data: sigue, error: errCerca } = await supabase
    .from(TABLE)
    .update({ updated_at: ahora })
    .eq("id", id)
    .eq("estado", cab.estado)
    .eq("inactivo", false)
    .select("id")
    .maybeSingle();
  if (errCerca) throw new Error(`Error al verificar el traslado: ${errCerca.message}`);
  if (!sigue) {
    const e = new Error(
      "El traslado cambió de estado mientras se enviaba la primera parte (alguien lo cerró o lo inactivó). No se partió nada.",
    );
    e.statusCode = 409;
    e.expose = true;
    throw e;
  }

  // La parte 2 nace en "Creado" y SIN dueño: va al pool. El que empezó puede
  // estar de descanso o en otra sede mañana, y un traslado reservado a alguien
  // que no viene es un traslado que no sale.
  const { data: parte2, error: errCab } = await supabase
    .from(TABLE)
    .insert({
      flujo: cab.flujo || "general",
      origen: cab.origen,
      destino: cab.destino,
      criterios: cab.criterios,
      admin_id: cab.admin_id,
      despachador_id: null,
      estado: "Creado",
      disponible_at: ahora,
      publicado_at: ahora, // la parte 2 entra al pool: es una publicación
      parte_de: id,
      // Si ya era una parte 2, la siguiente es la 3: dividir puede pasar de nuevo.
      parte_num: (Number(cab.parte_num) || 1) + 1,
    })
    .select()
    .single();
  if (errCab) throw new Error(`Error al crear la parte 2: ${errCab.message}`);

  // Mover los pendientes — UNA escritura condicional (ver el encabezado). La
  // condición es la misma de `sinTocar`, re-evaluada por la base al escribir.
  // Tampoco se pasa la lista de ids: además de estar vieja, con cientos de
  // renglones rompía el largo máximo de la URL.
  //
  // `motivo` y `agotado` se limpian SIEMPRE. En recolección es un no-op (el
  // predicado ya excluye los que tienen motivo), pero después del cierre es el
  // punto: esos renglones llegan marcados Agotado o Inventario Fantasma por la
  // auto-clasificación, y la parte 2 tiene que nacer en blanco — si no, el que la
  // tome mañana abre 187 renglones que ya dicen "no estaba" sin que nadie los
  // haya caminado.
  //
  // EL FILTRO DE ABAJO ES EL MISMO PREDICADO QUE `esMovibleAParte2`, escrito en
  // PostgREST porque lo evalúa la base. Si se cambia uno hay que cambiar el otro;
  // `test/despacho.envio-por-partes.test.js` los ata y falla si se separan.
  // `cantidad_suelta` acompaña al total (037): un renglón sin tocar no tiene nada
  // suelto, y nada en contenedores (un contenedor nunca guarda un 0).
  const CAMBIOS = {
    despacho_id: parte2.id,
    recolectado_por: null,
    cantidad_despachador: null,
    cantidad_suelta: null,
    motivo: null,
    agotado: false,
  };

  let movidos = null;
  let errMover = null;

  if (cab.estado === "En_recoleccion") {
    // EN RECOLECCIÓN: una sola escritura condicional, con el predicado evaluado
    // por la base AL MOMENTO DE ESCRIBIR. Acá la carrera es real —alguien está
    // contando mientras se parte— y mudar "los ids que se leyeron" se llevaría a
    // la parte 2 renglones recién contados, con su cantidad adentro.
    ({ data: movidos, error: errMover } = await supabase
      .from("traslados_items")
      .update(CAMBIOS)
      .eq("despacho_id", id)
      .is("motivo", null)
      .not("agotado", "is", true)
      .or("cantidad_despachador.is.null,cantidad_despachador.eq.0")
      .select("id"));
  } else {
    // YA CERRADO: se mudan los ids que se leyeron arriba, de a tandas.
    //
    // POR QUÉ ACÁ SÍ Y EN RECOLECCIÓN NO
    // La carrera que obliga al filtro condicional es "alguien está contando en
    // este momento". En un traslado cerrado eso no puede pasar: nadie recolecta
    // más. El `.eq("despacho_id", id)` se conserva igual, así que si otra pestaña
    // ya partió este traslado, la segunda pasada no mueve nada (y el guard de
    // abajo lo convierte en 409 en vez de en una parte 2 vacía).
    //
    // Y POR QUÉ NO SE REUSÓ EL FILTRO CONDICIONAL
    // Sin los `.is("motivo", null)` y `.not("agotado", "is", true)` que lo
    // acompañaban, PostgREST rechaza el `.or()` con "column
    // traslados_items.cantidad_despachador does not exist" (visto en producción,
    // 09/10/2026, traslado 47895efd). Ese filtro no se puede usar solo; por ids
    // no hace falta y además se lee mejor.
    //
    // De a TANDAS porque los ids viajan en la URL: con cientos de renglones, una
    // sola pasada rompe el largo máximo.
    const TANDA = 50;
    const ids = sinTocar.map((it) => it.id);
    movidos = [];
    for (let i = 0; i < ids.length; i += TANDA) {
      const { data, error } = await supabase
        .from("traslados_items")
        .update(CAMBIOS)
        .eq("despacho_id", id)
        .in("id", ids.slice(i, i + TANDA))
        .select("id");
      if (error) {
        errMover = error;
        break;
      }
      movidos.push(...(data || []));
    }
  }

  // Si esto falla o no movió nada, la parte 2 quedó vacía: se borra para no dejar
  // un traslado fantasma de 0 renglones en el pool de mañana.
  if (errMover || !movidos?.length) {
    await supabase.from(TABLE).delete().eq("id", parte2.id);
    if (errMover) throw new Error(`Error al mover los pendientes: ${errMover.message}`);
    const e = new Error(
      "Mientras se enviaba la primera parte se registraron los productos que faltaban: ya no queda nada pendiente. Cerrá la recolección normalmente.",
    );
    e.statusCode = 409;
    e.expose = true;
    throw e;
  }

  // La lectura exigía al menos un renglón atendido, pero eso se miró ANTES de
  // mudar. Si en el medio alguien devolvió a 0 lo único que había contado, la
  // mudanza se llevó todo y la primera parte quedó vacía: un traslado de 0
  // renglones que igual se cerraría y subiría a SIESA. Se deshace entera.
  const { data: quedan, error: errQuedan } = await supabase
    .from("traslados_items")
    .select("id")
    .eq("despacho_id", id)
    .limit(1);
  if (!errQuedan && !quedan?.length) {
    await supabase.from("traslados_items").update({ despacho_id: id }).eq("despacho_id", parte2.id);
    await supabase.from(TABLE).delete().eq("id", parte2.id);
    const e = new Error(
      "La primera parte quedaría vacía: no hay ningún producto registrado. No se partió nada.",
    );
    e.statusCode = 409;
    e.expose = true;
    throw e;
  }

  return { despacho: await findById(id), parte2, movidos: movidos.length };
}

/**
 * Reasignar (o quitar) el despachador de un despacho.
 */
export async function updateDespachador(id, despachadorId) {
  const { data, error } = await supabase
    .from(TABLE)
    .update({ despachador_id: despachadorId || null, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();
  if (error) throw new Error(`Error al reasignar despachador: ${error.message}`);
  return data;
}

/** Estados en los que la lista de ítems todavía se puede tocar (nadie recolectó). */
const ESTADOS_EDITABLES = ["Borrador", "Creado"];

/**
 * Editar los ítems de un despacho — solo mientras nadie recolectó
 * ("Borrador" o "Creado"). Hace tres cosas:
 *   - actualiza la cantidad de los ítems que ya estaban (traen `id`),
 *   - elimina los que ya no vienen en la lista,
 *   - INSERTA los ítems nuevos (sin `id` pero con `codigo_item`). Los agrega el
 *     admin desde el monitor buscando por código, código de barras o descripción.
 *
 * @param {string} id
 * @param {Array<object>} items - ítems que quedan. Existentes: { id, cantidad }.
 *   Nuevos: { codigo_item, descripcion, unidad_medida, factor, cantidad, ... }.
 */
export async function editarItems(id, items) {
  const { data: cab } = await supabase.from(TABLE).select("estado").eq("id", id).single();
  if (!cab) {
    const e = new Error("Despacho no encontrado");
    e.statusCode = 404;
    e.expose = true;
    throw e;
  }
  if (!ESTADOS_EDITABLES.includes(cab.estado)) {
    const e = new Error(
      `Solo se pueden editar los ítems de un despacho en ${ESTADOS_EDITABLES.join(" o ")}`,
    );
    e.statusCode = 409;
    e.expose = true;
    throw e;
  }

  const { data: actuales, error: errLeer } = await supabase
    .from("traslados_items")
    .select("id")
    .eq("despacho_id", id);
  // Sin la lista actual no se puede calcular qué se quitó: seguir con `[]` era
  // seguro de casualidad; se corta explícito.
  if (errLeer) throw new Error(`Error al leer los ítems: ${errLeer.message}`);

  // Los ids llegan del cliente: solo cuentan los que SON de este despacho. Un id
  // de otro traslado (pantalla vieja, dos pestañas) no puede editar un renglón ajeno.
  const propios = new Set((actuales || []).map((r) => r.id));
  const keep = new Set(items.map((i) => i.id).filter((x) => x && propios.has(x)));
  const removidos = [...propios].filter((x) => !keep.has(x));

  // Una lista que no deja nada no es "editar": borraría todos los renglones y
  // dejaría un traslado de 0 productos circulando. Para eso está Eliminar. Se
  // cuenta DESPUÉS de filtrar los ids ajenos: una lista hecha solo de ids de otro
  // traslado también vaciaría este.
  const nuevosValidos = items.filter(
    (it) => !it.id && it.codigo_item != null && String(it.codigo_item).trim() !== "",
  );
  if (keep.size === 0 && nuevosValidos.length === 0) {
    const e = new Error(
      "El traslado quedaría sin productos. Si ya no se necesita, eliminalo en vez de vaciarlo.",
    );
    e.statusCode = 422;
    e.expose = true;
    throw e;
  }

  if (removidos.length) {
    const { error } = await supabase
      .from("traslados_items")
      .delete()
      .eq("despacho_id", id)
      .in("id", removidos);
    if (error) throw new Error(`Error al quitar ítems: ${error.message}`);
  }

  // Ítems existentes: solo se toca la cantidad del admin.
  for (const it of items) {
    if (!it.id || !propios.has(it.id)) continue;
    const { error } = await supabase
      .from("traslados_items")
      .update({ cantidad_admin: Number(it.cantidad) || 0 })
      .eq("id", it.id)
      .eq("despacho_id", id);
    if (error) throw new Error(`Error al actualizar ítem: ${error.message}`);
  }

  // Ítems nuevos (sin id): se insertan con el snapshot que trae el catálogo. Se
  // exige codigo_item para no crear filas basura. Mismo shape que `create`.
  const nuevos = items
    .filter((it) => !it.id && it.codigo_item != null && String(it.codigo_item).trim() !== "")
    .map((it) => ({
      despacho_id: id,
      codigo_item: String(it.codigo_item).trim(),
      descripcion: it.descripcion ?? null,
      unidad_medida: it.unidad_medida ?? "UND",
      factor: it.factor ?? 1,
      rotacion: it.rotacion ?? null,
      grupo: it.grupo ?? null,
      categoria: it.categoria ?? null,
      stock_origen: it.stock_origen ?? null,
      stock_destino: it.stock_destino ?? null,
      consumo_destino: it.consumo_destino ?? null,
      stock_seguridad: it.stock_seguridad ?? null,
      sugerido: it.sugerido ?? null,
      // Peso de UNA unidad base, en gramos (migración 017). Llega como `volumen`
      // desde el catálogo (herencia del nombre en SIESA). Sin esto el ítem agregado
      // desde el monitor sale "sin dato" en la columna Peso.
      peso_unitario: it.volumen ?? it.peso_unitario ?? null,
      cantidad_admin: Number(it.cantidad) || 0,
    }));

  if (nuevos.length) {
    const { error } = await supabase.from("traslados_items").insert(nuevos);
    if (error) throw new Error(`Error al agregar ítems: ${error.message}`);
  }

  return { id, items: items.length, agregados: nuevos.length };
}


/* =============================================
   MARCA "NO SUBIDO A SIESA" — ver sql/029
   ============================================= */

// Estados donde se puede marcar un renglón como "no va a SIESA".
//
// Arranca en "En_recoleccion", NO en "Recolectado": el objetivo es EXCLUIR el
// renglón del plano ANTES de que se suba, para que no lo tumbe. La subida ocurre
// al pasar a "Recolectado", así que hay que poder marcar antes.
//
// Quedan afuera "Borrador" y "Creado" a propósito: ahí el despacho todavía es
// editable (ESTADOS_EDITABLES) y si el admin no quiere un renglón, lo QUITA. La
// marca es para cuando ya no se puede editar pero el plano aún no cerró (o ya se
// intentó, para reintentar sin él).
const ESTADOS_MARCA_SIESA = [
  "En_recoleccion",
  "Pendiente_carga",
  "Recolectado",
  "En_recepcion",
  "Auditado",
  "Rechazado",
  "Recibido_con_inconsistencia",
];

/**
 * Marca (o desmarca) renglones que NO deben ir a SIESA.
 *
 * Dos usos, mismo campo:
 *   1. ANTES de subir — excluir del plano el renglón que rompe la importación,
 *      para que el resto entre solo (ver itemsRecolectados en siesaRequisicion).
 *   2. DESPUÉS de un fallo — dejar registro de lo que se subió a mano aparte.
 *
 * NO TOCA NINGUNA CANTIDAD, a propósito. El estado visible del renglón se DERIVA
 * de `cantidad_despachador`; ponerla en 0 para que "se vea distinto" borraría lo
 * que el despachador recogió y le bajaría el cumplimiento a una sede que no hizo
 * nada mal (ver el encabezado de sql/029). La mercancía salió del camión igual;
 * lo único que cambia es que no la registra el ERP por el plano automático.
 *
 * @param {string} id        - despacho
 * @param {string[]} itemIds - renglones a marcar
 * @param {boolean} omitido  - true marca, false levanta la marca
 * @param {string|null} correo - quién lo hace (queda como constancia)
 */
export async function marcarItemsSiesaOmitido(id, itemIds, omitido, correo = null) {
  const { data: cab } = await supabase.from(TABLE).select("estado").eq("id", id).single();
  if (!cab) {
    const e = new Error("Despacho no encontrado");
    e.statusCode = 404;
    e.expose = true;
    throw e;
  }
  if (!ESTADOS_MARCA_SIESA.includes(cab.estado)) {
    const e = new Error(
      `Este despacho está en ${cab.estado}. En Borrador o Creado, quita el producto en vez de marcarlo — todavía es editable.`,
    );
    e.statusCode = 409;
    e.expose = true;
    throw e;
  }

  // Los ids llegan del cliente: se acotan a ESTE despacho antes de escribir. Sin
  // este filtro, un id de otro traslado se marcaría igual y la anotación
  // aparecería en un despacho que nadie tocó.
  const { data: propios, error: errLeer } = await supabase
    .from("traslados_items")
    .select("id")
    .eq("despacho_id", id)
    .in("id", itemIds);
  if (errLeer) throw new Error(`Error al leer los ítems: ${errLeer.message}`);

  const validos = (propios || []).map((r) => r.id);
  if (!validos.length) {
    const e = new Error("Ninguno de los ítems pertenece a este despacho");
    e.statusCode = 400;
    e.expose = true;
    throw e;
  }

  const parche = omitido
    ? { siesa_omitido: true, siesa_omitido_at: new Date().toISOString(), siesa_omitido_por: correo }
    : { siesa_omitido: false, siesa_omitido_at: null, siesa_omitido_por: null };

  const { data, error } = await supabase
    .from("traslados_items")
    .update(parche)
    .in("id", validos)
    .select("id, siesa_omitido, siesa_omitido_at, siesa_omitido_por");
  if (error) throw new Error(`Error al marcar los ítems: ${error.message}`);

  return { actualizados: data?.length || 0, items: data || [] };
}

/**
 * Estados en los que un despacho se puede ELIMINAR: nadie contó nada todavía.
 *
 * Borrar es irreversible y arrastra por cascade los renglones, las firmas y el
 * manifiesto. Desde `En_recoleccion` en adelante eso es trabajo de personas
 * (conteos, firmas) y, desde `Recolectado`, un movimiento que ya existe en SIESA:
 * borrarlo deja al ERP con un documento que el sistema ya no puede explicar. Para
 * sacar de circulación un traslado que ya arrancó está Inactivar, que no borra
 * nada y se puede revertir.
 */
const ESTADOS_ELIMINABLES = ["Borrador", "Creado"];

/**
 * Eliminar un despacho (los items y firmas se borran por FK ON DELETE CASCADE).
 * Solo en `ESTADOS_ELIMINABLES`, y atado al mismo DELETE: si alguien lo inicia
 * entre que el admin abrió el diálogo y confirmó, no se borra.
 */
export async function eliminar(id) {
  const { data, error } = await supabase
    .from(TABLE)
    .delete()
    .eq("id", id)
    .in("estado", ESTADOS_ELIMINABLES)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`Error al eliminar despacho: ${error.message}`);

  if (!data) {
    const { data: actual } = await supabase
      .from(TABLE)
      .select("estado")
      .eq("id", id)
      .maybeSingle();
    const e = new Error(
      actual
        ? `No se puede eliminar un traslado en ${actual.estado}: ya tiene trabajo registrado. Usá Inactivar para sacarlo de circulación sin perder nada.`
        : "Despacho no encontrado",
    );
    e.statusCode = actual ? 409 : 404;
    e.expose = true;
    throw e;
  }
  return { id, eliminado: true };
}

/**
 * Deja la requisición de SIESA marcada como 'pendiente' de envío.
 *
 * El `.is("siesa_estado", null)` es el punto: solo marca si NUNCA se tocó. Si ya
 * dice 'enviado', pisarlo con 'pendiente' haría que el cron la mande de nuevo y
 * duplique la requisición en el ERP. Un estado terminal no se revive.
 */
export async function marcarSiesaPendiente(id) {
  const { error } = await supabase
    .from(TABLE)
    .update({ siesa_estado: "pendiente" })
    .eq("id", id)
    .is("siesa_estado", null);

  if (error) console.error(`[despacho] no se pudo marcar siesa_estado: ${error.message}`);
}

/**
 * Registrar qué auditor cerró el despacho.
 */
export async function updateAuditor(id, auditorId) {
  const { error } = await supabase
    .from(TABLE)
    .update({ auditor_id: auditorId })
    .eq("id", id);

  if (error) throw new Error(`Error al asignar auditor: ${error.message}`);
}

/**
 * Obtener despachos con resumen de items para el monitor.
 * Devuelve los despachos con conteo de completos/incompletos/agotados/pendientes
 * y `movibles` (cuántos renglones se irían a la parte 2 si el admin partiera
 * ahora — ver `esMovibleAParte2`; NO es lo mismo que `pendientes`).
 * Acepta los mismos filtros que findAll.
 */
/**
 * Columnas de la LISTA del monitor. Se enumeran en vez de usar `*` porque cuatro
 * campos JSONB pesan casi todo y no los mira nadie en una lista:
 *
 *   siesa_payload         742 KB   59.7%  ← el plano completo que se manda al ERP
 *   siesa_salida_payload  443 KB   35.7%  ← el mismo, de la salida
 *   siesa_ajuste_payload  ...
 *   siesa_intentos_log    ...
 *
 * Medido en producción: la lista pesaba 1277 KB para 48 traslados y lo que las
 * tarjetas realmente muestran eran 17 KB. El 99% viajaba sin que nadie lo leyera,
 * y a ~26 KB por traslado eso se vuelve inmanejable solo: con 300 serían 8 MB.
 *
 * Esos payloads SÍ se necesitan, pero en el DETALLE (`findById`, que sigue con
 * `*`): es donde vive el "Detalle técnico" de EstadoSiesa, y ahí se pide un
 * traslado por vez.
 *
 * Al enumerar hay que acordarse de sumar acá una columna nueva que la lista
 * necesite. Es el costo de esto, y se paga una vez; el `*` cobraba en cada carga.
 */
const COLUMNAS_LISTA = [
  "id",
  "flujo",
  "origen",
  "destino",
  "estado",
  "despachador_id",
  "admin_id",
  "auditor_id",
  "criterios",
  "created_at",
  "updated_at",
  "disponible_at",
  "inactivo",
  "inactivo_at",
  "inactivo_motivo",
  "recoleccion_finalizada_at",
  "auditoria_iniciada_at",
  "auditoria_abierta_at",
  "auditoria_finalizada_at",
  "alerta_recoleccion_at",
  "alerta_auditoria_at",
  // Estado del envío: la tarjeta lo pinta. El PAYLOAD no, y es lo que pesa.
  "siesa_estado",
  "siesa_docto",
  "siesa_intentos",
  "siesa_enviado_at",
  // Traslado por partes (sql/032): el badge "Parte N" sale de acá.
  "parte_de",
  "parte_num",
].join(", ");

export async function findAllWithResumen(filters = {}) {
  // 1. Obtener cabeceras (reusa lógica de findAll)
  let query = supabase.from(TABLE).select(COLUMNAS_LISTA);

  if (Array.isArray(filters.estado)) query = query.in("estado", filters.estado);
  else if (filters.estado) query = query.eq("estado", filters.estado);

  query = aplicarFiltroInactivo(query, filters);

  // Sede de quien consulta (migración 025). Sale TODO lo que menciona a esa
  // bodega, sea como origen o como destino — no solo lo que arranca ahí.
  //
  // La primera versión miraba solo el `origen`, razonando que despachar es sacar
  // mercancía de la propia bodega. Pero eso dejaba a Llano con el panel vacío
  // aunque tuviera un traslado en camino, y no ver lo que te van a mandar es peor
  // que verlo de más: el traslado te concierne igual.
  //
  // Lo resuelve el controlador desde el correo, nunca lo manda el cliente. Sin
  // sede no filtra: ese es el alcance de quien las ve todas.
  if (filters.sede_origen) {
    const s = filters.sede_origen;
    query = query.or(`origen.eq.${s},destino.eq.${s}`);
  }

  if (filters.sin_asignar) {
    query = query.is("despachador_id", null);
  } else if (filters.despachador_id) {
    query = query.eq("despachador_id", filters.despachador_id);
  }
  if (filters.admin_id) query = query.eq("admin_id", filters.admin_id);

  const { data: despachos, error } = await query.order("created_at", { ascending: false });
  if (error) throw new Error(`Error al listar despachos: ${error.message}`);
  if (!despachos?.length) return [];

  // 2. Obtener agregación de items, PAGINANDO.
  //
  // Supabase corta en 1000 filas por consulta. Sin paginar, con 46 traslados de
  // ~130 renglones se piden 6050 y llegan 5000: los últimos traslados vuelven SIN
  // un solo ítem y su resumen queda en 0. En el monitor eso se ve como una barra
  // vacía y un "0/0" en traslados que sí se recolectaron completos — un dato falso
  // que hace dudar del trabajo de la gente.
  //
  // El corte no avisa: la consulta responde OK con menos filas. Por eso se nota
  // recién cuando alguien mira la pantalla y no cuadra.
  //
  // PAGINAR EXIGE ORDEN ESTABLE. Sin `.order("id")` Postgres devuelve las filas en
  // el orden físico del heap, y ese orden CAMBIA cada vez que un renglón se
  // actualiza (un UPDATE escribe una versión nueva de la fila en otro lugar). Con
  // gente recolectando, cada poll de 10 s del monitor partía las páginas distinto:
  // unos renglones salían dos veces y otros ninguna, y el "completos/total" de la
  // tarjeta bailaba de un número a otro sin que nadie tocara el traslado. Es el
  // mismo bug que tuvo la paginación de Connekta (CONTEXTO-Y-PENDIENTES §4.1).
  const ids = despachos.map((d) => d.id);
  const PAGINA = 1000;
  const items = [];
  for (let desde = 0; ; desde += PAGINA) {
    const { data, error: errItems } = await supabase
      .from("traslados_items")
      .select("id, despacho_id, cantidad_despachador, agotado, cantidad_admin, motivo, siesa_omitido")
      .in("despacho_id", ids)
      .order("id", { ascending: true })
      .range(desde, desde + PAGINA - 1);

    if (errItems) throw new Error(`Error al obtener resumen de items: ${errItems.message}`);
    if (!data?.length) break;
    items.push(...data);
    // Una página incompleta es la última: evita una consulta de más por cada lista.
    if (data.length < PAGINA) break;
  }

  // 3. Armar resumen por despacho
  //
  // El estado hace falta para `movibles`: el criterio de qué se mudaría a una
  // parte 2 cambia según si el traslado sigue en recolección o ya se cerró (ver
  // `esMovibleAParte2`). Se arma el mapa antes del bucle para no buscarlo por cada
  // renglón — un monitor con 40 traslados son miles de iteraciones.
  const estadoPorDespacho = new Map(despachos.map((d) => [d.id, d.estado]));
  const agg = {};
  for (const item of items || []) {
    if (!agg[item.despacho_id]) {
      // `motivos` viaja con la lista para que el Monitor pueda filtrar por
      // "agotados" o "inventario fantasma" sin pedir el detalle de CADA
      // despacho: con 40 traslados en pantalla serían 40 requests por filtro.
      agg[item.despacho_id] = {
        total: 0, completos: 0, incompletos: 0, agotados: 0, pendientes: 0, movibles: 0,
        motivos: {},
      };
    }
    agg[item.despacho_id].total++;
    // Cuántos renglones se irían a la parte 2 si el admin partiera AHORA. Va
    // aparte de la cadena de abajo porque responde otra pregunta: `pendientes`
    // describe el avance de la recolección, `movibles` describe el efecto de una
    // acción. No son el mismo número y no se pueden derivar uno del otro
    // (ver `esMovibleAParte2`).
    if (esMovibleAParte2(item, estadoPorDespacho.get(item.despacho_id))) {
      agg[item.despacho_id].movibles++;
    }
    if (item.motivo) {
      const m = agg[item.despacho_id].motivos;
      m[item.motivo] = (m[item.motivo] || 0) + 1;
    }
    if (item.agotado) {
      agg[item.despacho_id].agotados++;
    } else if (item.cantidad_despachador == null) {
      agg[item.despacho_id].pendientes++;
    } else if (Number(item.cantidad_despachador) >= Number(item.cantidad_admin)) {
      agg[item.despacho_id].completos++;
    } else {
      agg[item.despacho_id].incompletos++;
    }
  }

  const recepcion = await avanceRecepcion(despachos, items);

  return despachos.map((d) => ({
    ...d,
    resumen: agg[d.id] || {
      total: 0, completos: 0, incompletos: 0, agotados: 0, pendientes: 0, motivos: {},
    },
    // Solo los que están esperando o en recepción; el resto no lo trae.
    ...(recepcion[d.id] && { recepcion: recepcion[d.id] }),
  }));
}

/** Estados en los que el monitor muestra el avance de la recepción. */
const ESTADOS_RECEPCION = ["Recolectado", "En_recepcion"];

/**
 * Avance de la recepción por despacho (migración 036): cuántos de los productos
 * que el auditor tiene en su lista ya se contaron (o se declararon no recibidos)
 * y quiénes están contando.
 *
 * El denominador es lo que el AUDITOR ve, no el despacho entero: los agotados,
 * los recolectados en 0 y los excluidos no le llegan (misma regla que
 * `DespachoService.ocultoParaAuditor`, repetida acá porque el servicio importa
 * este modelo). Contra el total del despacho, una recepción terminada se vería
 * a medias para siempre.
 *
 * Best-effort: si la tabla no existe todavía (migración sin correr) o la lectura
 * falla, el monitor sigue mostrando todo lo demás.
 *
 * @returns {Promise<Record<string,{visibles:number, contados:number, auditores:string[]}>>}
 */
async function avanceRecepcion(despachos, items) {
  const ids = despachos.filter((d) => ESTADOS_RECEPCION.includes(d.estado)).map((d) => d.id);
  if (!ids.length) return {};

  let filas;
  try {
    filas = await ConteoModel.listarResumenPorDespachos(ids);
  } catch (err) {
    console.error("[monitor] no se pudo leer el avance de recepción:", err.message);
    return {};
  }

  const oculto = (it) =>
    it.agotado === true ||
    (it.cantidad_despachador != null && Number(it.cantidad_despachador) === 0) ||
    it.siesa_omitido === true;

  const salida = {};
  for (const id of ids) salida[id] = { visibles: 0, contados: 0, auditores: [] };

  const visibles = new Set();
  for (const it of items) {
    if (!salida[it.despacho_id] || oculto(it)) continue;
    salida[it.despacho_id].visibles++;
    visibles.add(it.id);
  }

  // Por renglón: suma de todos los auditores y si alguien lo declaró no recibido.
  const porRenglon = new Map();
  const auditores = {};
  for (const f of filas) {
    (auditores[f.despacho_id] ||= new Set()).add(f.contado_por);
    if (!f.item_id || !visibles.has(f.item_id)) continue;
    const acc = porRenglon.get(f.item_id) || { despacho_id: f.despacho_id, cantidad: 0, noRec: false };
    acc.cantidad += Number(f.cantidad) || 0;
    if (f.no_recibido) acc.noRec = true;
    porRenglon.set(f.item_id, acc);
  }
  for (const acc of porRenglon.values()) {
    if (acc.cantidad > 0 || acc.noRec) salida[acc.despacho_id].contados++;
  }
  for (const [id, set] of Object.entries(auditores)) {
    if (salida[id]) salida[id].auditores = [...set].filter(Boolean).sort();
  }

  // Canastillas recibidas (038): "2 de 5" dice más que el conteo de productos
  // cuando el camión se descarga canastilla por canastilla.
  try {
    const { data: canastillas } = await supabase
      .from("traslados_contenedores")
      .select("despacho_id, recepcion_estado")
      .in("despacho_id", ids);
    for (const c of canastillas || []) {
      const s = salida[c.despacho_id];
      if (!s) continue;
      s.canastillas = (s.canastillas || 0) + 1;
      if (["cerrado", "no_recibido"].includes(c.recepcion_estado)) {
        s.canastillas_recibidas = (s.canastillas_recibidas || 0) + 1;
      }
    }
  } catch (err) {
    console.error("[monitor] no se pudo leer las canastillas:", err.message);
  }
  return salida;
}

/**
 * Obtener despachos para el panel del auditor: SOLO la cabecera.
 *
 * Deliberadamente NO trae ítems ni firmas. El sidebar solo pinta ruta, estado y
 * fecha; los ítems se piden aparte por `/auditor/despachos/:id`, que es donde
 * vive el filtro de la auditoría ciega (oculta los que no salieron de origen y
 * la firma del despachador).
 *
 * Si acá devolviéramos los ítems, ese filtro no serviría de nada: bastaría con
 * comparar ambas respuestas en la pestaña de red para deducir cuáles se
 * ocultaron — o sea, cuáles mandó el despachador en cero. Un dato que no viaja
 * es el único que no se puede espiar.
 */
/**
 * Despachos esperando recibo.
 *
 * @param {object} [opts]
 * @param {string} [opts.sede] - bodega de quien mira: solo lo que llega ACÁ.
 *   Sin sede (los usuarios previos, o alguien fuera del maestro) se ve todo,
 *   que es el comportamiento anterior a la 025 — nadie se queda sin panel por
 *   no tener el dato cargado.
 */
export async function findForAuditor({ sede } = {}) {
  let query = supabase
    .from(TABLE)
    // `parte_num` viaja para que el recibidor sepa CUÁL parte tiene enfrente: dos
    // partes de la misma ruta se ven idénticas en la lista (mismo origen, mismo
    // destino, mismo día) y recibir la equivocada es un error fácil de cometer.
    .select("id, origen, destino, estado, created_at, updated_at, parte_num")
    .in("estado", ["Recolectado", "En_recepcion"])
    // Los inactivos desaparecen también del auditor (ver aplicarFiltroInactivo).
    .eq("inactivo", false);

  // Sale todo lo que menciona a la bodega, de los dos lados: lo que llega ACÁ y
  // lo que salió DE ACÁ. Mismo criterio que en `findAll`.
  //
  // Que Girardota Parque vea en esta lista el traslado que él mismo despachó a
  // Llano es a propósito: le sirve para saber si ya lo recibieron. Confirmarlo
  // sigue siendo del destino — el botón de confirmar no cambia por esto.
  if (sede) query = query.or(`origen.eq.${sede},destino.eq.${sede}`);

  const { data, error } = await query;

  if (error) throw new Error(`Error al listar despachos para auditoría: ${error.message}`);
  return data;
}

/* =============================================
   BORRADOR — la lista que el admin arma durante la semana (los dos flujos)
   ============================================= */

/**
 * El borrador abierto de una ruta, con sus ítems. `null` si no hay ninguno.
 * El índice parcial garantiza que sea a lo sumo uno (ver migración 013).
 */
export async function findBorrador(origen, destino) {
  const { data, error } = await supabase
    .from(TABLE)
    .select("*, traslados_items(*)")
    .eq("estado", "Borrador")
    .eq("origen", origen)
    .eq("destino", destino)
    .maybeSingle();

  if (error) throw new Error(`Error al buscar el listado en curso: ${error.message}`);
  return data;
}

/** Todos los borradores abiertos (para mostrarlos en el panel del admin). */
export async function findBorradores() {
  const { data, error } = await supabase
    .from(TABLE)
    .select("*, traslados_items(id, codigo_item, descripcion, unidad_medida, cantidad_admin)")
    .eq("estado", "Borrador")
    .order("created_at", { ascending: false });

  if (error) throw new Error(`Error al listar los listados en curso: ${error.message}`);
  return data || [];
}

/**
 * Agrega ítems a un borrador con semántica REEMPLAZAR (decisión del negocio):
 * si el ítem ya está en la lista, la cantidad nueva pisa la anterior; si no está,
 * se inserta. Devuelve qué se hizo con cada uno para que el panel pueda decir
 * "3 agregados, 2 actualizados".
 *
 * La identidad del ítem dentro del despacho es `(codigo_item, unidad_medida)`, la
 * misma con la que el admin arma el carrito: el mismo producto en CAJA y en BULTO
 * son dos renglones distintos, y pisar uno con el otro perdería la presentación.
 *
 * @param {string} id - despacho en Borrador
 * @param {Array<object>} items - ítems del payload del admin
 * @returns {Promise<{agregados:number, actualizados:number}>}
 */
export async function agregarItemsBorrador(id, items) {
  const { data: cab } = await supabase.from(TABLE).select("estado").eq("id", id).single();
  if (!cab) {
    const e = new Error("Listado no encontrado");
    e.statusCode = 404;
    e.expose = true;
    throw e;
  }
  if (cab.estado !== "Borrador") {
    const e = new Error(
      `Este despacho ya se finalizó (estado ${cab.estado}): no se le pueden agregar ítems`,
    );
    e.statusCode = 409;
    e.expose = true;
    throw e;
  }

  const { data: actuales, error: errLeer } = await supabase
    .from("traslados_items")
    .select("id, codigo_item, unidad_medida")
    .eq("despacho_id", id);
  if (errLeer) throw new Error(`Error al leer el listado: ${errLeer.message}`);

  const clave = (codigo, um) => `${String(codigo ?? "").trim()}|${String(um ?? "").trim()}`;
  const existentes = new Map(
    (actuales || []).map((it) => [clave(it.codigo_item, it.unidad_medida), it.id]),
  );

  const nuevos = [];
  let actualizados = 0;

  for (const item of items) {
    const itemId = existentes.get(clave(item.codigo_item, item.unidad_medida));
    if (itemId) {
      // REEMPLAZAR: la cantidad nueva pisa la anterior. También se refresca el
      // snapshot de inventario, porque es el que el admin vio HOY al decidir —
      // conservar el del lunes contaría una historia que ya no es cierta.
      const { error } = await supabase
        .from("traslados_items")
        .update({
          cantidad_admin: item.cantidad,
          sugerido: item.sugerido,
          stock_origen: item.stock_origen,
          stock_destino: item.stock_destino,
          consumo_destino: item.consumo_destino,
          stock_seguridad: item.stock_seguridad,
          // Igual que el resto del snapshot del ítem: se refresca con el valor de
          // HOY. Si no se actualizara, un ítem cargado el lunes y re-agregado el
          // jueves conservaría un peso que puede haber cambiado en el maestro, y
          // el manifiesto saldría con el número viejo.
          peso_unitario: item.volumen ?? item.peso_unitario ?? null,
          factor: item.factor ?? 1,
          // Grupo/subgrupo del catálogo de HOY, por el mismo motivo que el peso: es
          // parte del snapshot del ítem. Además repuebla los renglones viejos que
          // quedaron con `grupo` en null y por eso salían al final de la lista del
          // despachador, fuera del orden por grupo.
          grupo: item.grupo ?? null,
          categoria: item.categoria ?? null,
        })
        .eq("id", itemId);
      if (error) throw new Error(`Error al actualizar el ítem del listado: ${error.message}`);
      actualizados += 1;
    } else {
      nuevos.push(aFilaItem(id, item));
    }
  }

  if (nuevos.length) {
    const { error } = await supabase.from("traslados_items").insert(nuevos);
    if (error) throw new Error(`Error al agregar ítems al listado: ${error.message}`);
  }

  await supabase.from(TABLE).update({ updated_at: new Date().toISOString() }).eq("id", id);

  return { agregados: nuevos.length, actualizados };
}

/**
 * Finaliza el borrador: pasa a "Creado" y recién ahí aparece en el panel del
 * despachador. Sella `disponible_at` — es el instante desde el que corre la
 * alerta de "nadie inició la recolección", no la fecha en que se abrió la lista.
 *
 * Atómico contra el estado leído: dos clicks en "Finalizar" no lo pasan dos veces.
 * Rechaza un borrador vacío: un despacho sin ítems no es nada que recolectar, y
 * llegaría al despachador como una lista en blanco.
 */
export async function finalizarBorrador(id, { despachadorId } = {}) {
  const { data: cab } = await supabase
    .from(TABLE)
    .select("estado, traslados_items(id)")
    .eq("id", id)
    .single();

  if (!cab) {
    const e = new Error("Listado no encontrado");
    e.statusCode = 404;
    e.expose = true;
    throw e;
  }
  if (cab.estado !== "Borrador") {
    const e = new Error(`Este despacho ya está en estado ${cab.estado}`);
    e.statusCode = 409;
    e.expose = true;
    throw e;
  }
  if ((cab.traslados_items || []).length === 0) {
    const e = new Error("El listado está vacío: agregá al menos un producto antes de finalizar");
    e.statusCode = 422;
    e.expose = true;
    throw e;
  }

  const ahora = new Date().toISOString();
  // `publicado_at` se re-sella si el listado se había reabierto ("Volver a
  // listado"): mientras estuvo en Borrador el despachador no lo veía, así que la
  // espera real arranca en la ÚLTIMA publicación, no en la primera.
  const patch = { estado: "Creado", updated_at: ahora, disponible_at: ahora, publicado_at: ahora };
  if (despachadorId) patch.despachador_id = despachadorId;

  const { data, error } = await supabase
    .from(TABLE)
    .update(patch)
    .eq("id", id)
    .eq("estado", "Borrador")
    .select()
    .single();

  if (error || !data) {
    const e = new Error("El listado ya se había finalizado");
    e.statusCode = 409;
    e.expose = true;
    throw e;
  }
  return data;
}

/**
 * Reabre un despacho: "Creado" → "Borrador". El inverso exacto de
 * `finalizarBorrador` — deshace lo que hizo "Enviar a despacho" para que el admin
 * pueda seguir sumándole productos al listado.
 *
 * SOLO DESDE "Creado", y no es un detalle: en "Creado" nadie tocó la mercancía.
 * Desde `En_recoleccion` en adelante hay un despachador contando con el celular en
 * la mano, y sacarle el despacho de la pantalla a mitad del recorrido le borra el
 * trabajo hecho. Por eso el guard no es "no está cerrado" sino "está exactamente
 * en Creado".
 *
 * EL CHOQUE CON EL LISTADO ABIERTO — la parte que no es obvia.
 * Hay un índice único parcial `(origen, destino) WHERE estado='Borrador'` (migración
 * 013): una ruta puede tener UN solo listado abierto a la vez. Si alguien ya empezó
 * un listado nuevo para esa misma ruta, reabrir este chocaría contra el índice y la
 * base devolvería un 23505 ilegible. Se chequea antes y se explica en castellano,
 * y además se atrapa el 23505 por si otro admin abre un listado en el medio.
 *
 * Se revierten también los campos que selló el envío: `disponible_at` (el reloj de
 * "nadie inició la recolección"), su marca de alerta, y el despachador asignado —
 * un listado en armado no está asignado a nadie. Los hitos de trazabilidad no se
 * tocan: reabrir no cambia el pasado.
 */
export async function reabrirBorrador(id) {
  const { data: cab } = await supabase
    .from(TABLE)
    .select("estado, origen, destino, inactivo")
    .eq("id", id)
    .single();

  if (!cab) {
    const e = new Error("Despacho no encontrado");
    e.statusCode = 404;
    e.expose = true;
    throw e;
  }
  // SIN GUARDA DE FLUJO. Hubo una que rechazaba todo lo que no fuera General,
  // porque el panel de armado ocultaba el listado en Llano y un Llano reabierto
  // quedaba sin pantalla donde agregarle productos. Eso ya no pasa: el listado
  // se habilitó para los dos flujos (`usaListado = !!destino`), así que reabrir
  // un Llano lo devuelve a una pantalla que sí sabe atenderlo.
  if (cab.inactivo) {
    const e = new Error(
      "Este traslado está inactivo. Reactivalo desde el panel de alertas para continuar.",
    );
    e.statusCode = 409;
    e.expose = true;
    throw e;
  }
  if (cab.estado !== "Creado") {
    const e = new Error(
      cab.estado === "Borrador"
        ? "Este despacho ya es un listado sin enviar"
        : `No se puede volver a listado: el despacho está en ${cab.estado} y ya hay trabajo de recolección hecho`,
    );
    e.statusCode = 409;
    e.expose = true;
    throw e;
  }

  const abierto = await findBorrador(cab.origen, cab.destino);
  if (abierto) {
    const e = new Error(
      "Esa ruta ya tiene un listado sin enviar. Enviá o descartá ese listado antes de reabrir este despacho.",
    );
    e.statusCode = 409;
    e.expose = true;
    throw e;
  }

  const ahora = new Date().toISOString();
  const { data, error } = await supabase
    .from(TABLE)
    .update({
      estado: "Borrador",
      disponible_at: null,
      alerta_recoleccion_at: null,
      despachador_id: null,
      updated_at: ahora,
    })
    .eq("id", id)
    .eq("estado", "Creado")
    .select()
    .single();

  if (error?.code === "23505") {
    const e = new Error(
      "Otro listado sin enviar se abrió para esa ruta en este momento. Volvé a intentar.",
    );
    e.statusCode = 409;
    e.expose = true;
    throw e;
  }
  if (error || !data) {
    const e = new Error("El despacho ya no está en Creado: alguien lo movió mientras tanto");
    e.statusCode = 409;
    e.expose = true;
    throw e;
  }
  return data;
}

/** Descarta un borrador entero (ítems por cascade). Solo si sigue en Borrador. */
export async function descartarBorrador(id) {
  const { data, error } = await supabase
    .from(TABLE)
    .delete()
    .eq("id", id)
    .eq("estado", "Borrador")
    .select("id")
    .maybeSingle();

  if (error) throw new Error(`Error al descartar el listado: ${error.message}`);
  if (!data) {
    const e = new Error("El listado no existe o ya se finalizó");
    e.statusCode = 409;
    e.expose = true;
    throw e;
  }
  return { id, descartado: true };
}

/* =============================================
   INACTIVAR / REACTIVAR
   ============================================= */

/**
 * Marca un traslado como inactivo o lo devuelve a la circulación.
 *
 * Al REACTIVAR se re-sella `disponible_at` y se limpian las marcas de alerta: el
 * traslado vuelve a la cola como si recién llegara. Sin eso, un traslado
 * reactivado ya viene con el reloj vencido y el barrido lo inactivaría de nuevo en
 * la pasada siguiente — el botón "Reactivar" no serviría para nada.
 *
 * Los hitos de trazabilidad (`recoleccion_finalizada_at` y compañía) NO se tocan:
 * son historial de lo que pasó, y reactivar no cambia el pasado.
 *
 * @param {string} id
 * @param {boolean} activo - true = reactivar, false = inactivar
 * @param {string} [motivo] - por qué se inactivó (queda para el panel)
 * @param {object} [opts]
 * @param {string} [opts.soloSiEstado] - inactiva SOLO si el despacho sigue en este
 *   estado y activo. Lo usa el barrido: entre que leyó "estancado en Creado" y que
 *   escribe, alguien pudo iniciar la recolección, y congelar un traslado con una
 *   persona contando la deja sin poder guardar. Si no matchea devuelve `null`.
 */
export async function setActivo(id, activo, motivo = null, { soloSiEstado } = {}) {
  const ahora = new Date().toISOString();
  const patch = activo
    ? {
        inactivo: false,
        inactivo_at: null,
        inactivo_motivo: null,
        disponible_at: ahora,
        alerta_recoleccion_at: null,
        alerta_auditoria_at: null,
        updated_at: ahora,
      }
    : {
        inactivo: true,
        inactivo_at: ahora,
        inactivo_motivo: motivo,
        updated_at: ahora,
      };

  let q = supabase.from(TABLE).update(patch).eq("id", id);
  if (soloSiEstado) q = q.eq("estado", soloSiEstado).eq("inactivo", false);
  const { data, error } = await q.select().maybeSingle();

  if (error) {
    throw new Error(`Error al cambiar la actividad del traslado: ${error.message}`);
  }
  if (!data) {
    if (soloSiEstado) return null;
    throw new Error("Error al cambiar la actividad del traslado: despacho no encontrado");
  }
  return data;
}

/* =============================================
   CONSULTAS DEL BARRIDO DE ALERTAS
   ============================================= */

/**
 * Traslados estancados en una etapa desde antes del corte.
 *
 * @param {object} opts
 * @param {string[]} opts.estados - etapas donde el traslado ESPERA a alguien
 * @param {string} opts.corte     - ISO; `disponible_at` anterior a esto = vencido
 * @param {string|null} [opts.campoAlerta] - columna de la marca de aviso; se pide
 *   `IS NULL` para no volver a avisar. `null` = sin deduplicar (usado por la
 *   inactivación, cuyo "ya se hizo" es la bandera `inactivo` misma).
 * @param {string|null} [opts.auditorInactivoDesde] - ISO. Excluye los traslados
 *   que un auditor abrió DESPUÉS de ese instante, o sea los que alguien está
 *   atendiendo ahora mismo.
 *
 *   POR QUÉ NO ALCANZA EL ESTADO NI `auditoria_iniciada_at`: el auditor cuenta
 *   entero en el navegador y no toca el backend hasta que aprieta Comparar, así
 *   que durante todo el conteo el traslado se ve idéntico a uno abandonado. Y
 *   marcarlo como "ya abierto" para siempre sería peor: el que abre y se va
 *   quedaría inmune a las tres reglas. Por eso se mide la FRESCURA de la última
 *   apertura (ver migración 015).
 */
export async function findEstancados({
  estados,
  corte,
  campoAlerta = null,
  auditorInactivoDesde = null,
}) {
  let q = supabase
    .from(TABLE)
    .select(
      "id, origen, destino, estado, created_at, disponible_at, despachador_id, " +
        "auditoria_iniciada_at, auditoria_abierta_at",
    )
    .in("estado", estados)
    .eq("inactivo", false)
    // `disponible_at` nulo = sin reloj. No debería pasar (la migración hace
    // backfill), pero un NULL colado no puede convertirse en "vencido hace
    // infinito" y disparar una avalancha de correos.
    .not("disponible_at", "is", null)
    .lt("disponible_at", corte);

  if (campoAlerta) q = q.is(campoAlerta, null);

  // "Nunca lo abrieron" O "lo abrieron hace rato y lo dejaron". Los dos casos son
  // desatención; el que queda afuera es el único que importa proteger: el que
  // alguien tiene abierto ahora.
  if (auditorInactivoDesde) {
    q = q.or(
      `auditoria_abierta_at.is.null,auditoria_abierta_at.lt.${auditorInactivoDesde}`,
    );
  }

  const { data, error } = await q.order("disponible_at", { ascending: true });
  if (error) throw new Error(`Error al buscar traslados estancados: ${error.message}`);
  return data || [];
}

/** Sella la marca de "esta alerta ya se avisó" para no repetir el correo. */
export async function marcarAlertaEnviada(id, campoAlerta) {
  const { error } = await supabase
    .from(TABLE)
    .update({ [campoAlerta]: new Date().toISOString() })
    .eq("id", id);
  if (error) console.error(`[alertas] no se pudo marcar ${campoAlerta} en ${id}:`, error.message);
}
