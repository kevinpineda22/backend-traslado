import { supabase } from "../config/supabase.js";

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
    .single();

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
 * como lista en construcción ("Borrador", solo flujo General — ver
 * agregarItemsBorrador). `disponible_at` solo se sella cuando nace en "Creado":
 * es el reloj de las alertas de inactividad, y un borrador todavía no espera a nadie.
 *
 * @param {object} payload - { origen, destino, despachador_id, admin_id, criterios, items[], estado? }
 */
export async function create(payload) {
  const { items, estado, ...cabecera } = payload;
  const estadoInicial = estado === "Borrador" ? "Borrador" : "Creado";

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
      disponible_at: estadoInicial === "Creado" ? new Date().toISOString() : null,
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

    if (errItems) throw new Error(`Error al insertar items: ${errItems.message}`);
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
    // Borrador = lista en construcción del flujo General. Su única salida es
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
 * Candado de propiedad para las escrituras de recolección (`POST /recolectar`).
 * Verifica que el despacho esté EN recolección y sea del despachador que llama.
 * Impide que un segundo despachador (lista vieja, otra pestaña, el monitor, o el
 * syncer offline de otra sesión) pise las cantidades de un despacho que no reclamó.
 *
 * Mismo alcance que updateStatus: frena el choque accidental entre despachadores
 * legítimos; el spoofing lo cubre la auth real cuando llegue.
 *
 * @param {string} id
 * @param {string} [despachadorId] - dueño esperado (correo del despachador)
 * @throws 404 si no existe, 409 si no está En_recoleccion, 403 si no es el dueño
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
  if (despachadorId && d.despachador_id && d.despachador_id !== despachadorId) {
    const e = new Error("Este despacho lo está recolectando otro despachador");
    e.statusCode = 403;
    e.expose = true;
    throw e;
  }
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
 *   en Recolectado — un reintento tardío), 403 si no es el dueño.
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
  if (despachadorId && d.despachador_id && d.despachador_id !== despachadorId) {
    const e = new Error("Este despacho lo está gestionando otro despachador");
    e.statusCode = 403;
    e.expose = true;
    throw e;
  }
  return d;
}

/**
 * Iniciar recolección reclamando el despacho (modelo pool).
 * Atómico: solo avanza a "En_recoleccion" si SIGUE en "Creado" (`.eq("estado","Creado")`),
 * así dos despachadores no lo toman a la vez. Setea el despachador que lo reclama.
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

  if (error || !data) {
    const err = new Error("El despacho ya fue tomado, se inactivó o cambió de estado");
    err.statusCode = 409;
    err.expose = true;
    return Promise.reject(err);
  }
  return data;
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

  const { data: actuales } = await supabase
    .from("traslados_items")
    .select("id")
    .eq("despacho_id", id);

  const keep = new Set(items.map((i) => i.id).filter(Boolean));
  const removidos = (actuales || []).map((r) => r.id).filter((x) => !keep.has(x));

  if (removidos.length) {
    const { error } = await supabase.from("traslados_items").delete().in("id", removidos);
    if (error) throw new Error(`Error al quitar ítems: ${error.message}`);
  }

  // Ítems existentes: solo se toca la cantidad del admin.
  for (const it of items) {
    if (!it.id) continue;
    const { error } = await supabase
      .from("traslados_items")
      .update({ cantidad_admin: Number(it.cantidad) || 0 })
      .eq("id", it.id);
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

/**
 * Eliminar un despacho (los items y firmas se borran por FK ON DELETE CASCADE).
 */
export async function eliminar(id) {
  const { error } = await supabase.from(TABLE).delete().eq("id", id);
  if (error) throw new Error(`Error al eliminar despacho: ${error.message}`);
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
 * Devuelve los despachos con conteo de completos/incompletos/agotados/pendientes.
 * Acepta los mismos filtros que findAll.
 */
export async function findAllWithResumen(filters = {}) {
  // 1. Obtener cabeceras (reusa lógica de findAll)
  let query = supabase.from(TABLE).select("*");

  if (Array.isArray(filters.estado)) query = query.in("estado", filters.estado);
  else if (filters.estado) query = query.eq("estado", filters.estado);

  query = aplicarFiltroInactivo(query, filters);

  if (filters.sin_asignar) {
    query = query.is("despachador_id", null);
  } else if (filters.despachador_id) {
    query = query.eq("despachador_id", filters.despachador_id);
  }
  if (filters.admin_id) query = query.eq("admin_id", filters.admin_id);

  const { data: despachos, error } = await query.order("created_at", { ascending: false });
  if (error) throw new Error(`Error al listar despachos: ${error.message}`);
  if (!despachos?.length) return [];

  // 2. Obtener agregación de items
  const ids = despachos.map((d) => d.id);
  const { data: items, error: errItems } = await supabase
    .from("traslados_items")
    .select("despacho_id, cantidad_despachador, agotado, cantidad_admin")
    .in("despacho_id", ids);

  if (errItems) throw new Error(`Error al obtener resumen de items: ${errItems.message}`);

  // 3. Armar resumen por despacho
  const agg = {};
  for (const item of items || []) {
    if (!agg[item.despacho_id]) {
      agg[item.despacho_id] = { total: 0, completos: 0, incompletos: 0, agotados: 0, pendientes: 0 };
    }
    agg[item.despacho_id].total++;
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

  return despachos.map((d) => ({
    ...d,
    resumen: agg[d.id] || { total: 0, completos: 0, incompletos: 0, agotados: 0, pendientes: 0 },
  }));
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
export async function findForAuditor() {
  const { data, error } = await supabase
    .from(TABLE)
    .select("id, origen, destino, estado, created_at, updated_at")
    .in("estado", ["Recolectado", "En_recepcion"])
    // Los inactivos desaparecen también del auditor (ver aplicarFiltroInactivo).
    .eq("inactivo", false);

  if (error) throw new Error(`Error al listar despachos para auditoría: ${error.message}`);
  return data;
}

/* =============================================
   BORRADOR — la lista que el admin arma durante la semana (flujo General)
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
          // despachador, fuera del orden por pasillo.
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
  const patch = { estado: "Creado", updated_at: ahora, disponible_at: ahora };
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
    .select("estado, origen, destino, inactivo, flujo")
    .eq("id", id)
    .single();

  if (!cab) {
    const e = new Error("Despacho no encontrado");
    e.statusCode = 404;
    e.expose = true;
    throw e;
  }
  // El listado es una función del flujo General y nada más: el panel de armado lo
  // oculta cuando el destino es Llano (`usaListado = !esLlano`). Un Llano devuelto
  // a Borrador quedaría en un estado que ninguna pantalla sabe atender — no
  // aparecería en el panel donde se agregan productos, que es justo para lo que
  // sirve reabrir. Y no hace falta: en Llano los ítems ya se editan en "Creado"
  // desde el Monitor.
  if ((cab.flujo || "general") !== "general") {
    const e = new Error(
      "El listado es del flujo General. En Llano los productos se editan directo desde el Monitor, sin reabrir.",
    );
    e.statusCode = 409;
    e.expose = true;
    throw e;
  }
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
 */
export async function setActivo(id, activo, motivo = null) {
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

  const { data, error } = await supabase
    .from(TABLE)
    .update(patch)
    .eq("id", id)
    .select()
    .single();

  if (error || !data) {
    throw new Error(`Error al cambiar la actividad del traslado: ${error?.message}`);
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
