import { supabase } from "../config/supabase.js";
import { createError } from "../middleware/errorHandler.js";
import * as ContenedorModel from "./Contenedor.model.js";

const TABLE = "traslados_items";

/** Motivos válidos de faltante (espejo del CHECK de las migraciones 004 + 031). */
export const MOTIVOS_FALTANTE = [
  "sin_stock",
  "surtido_parcial",
  "inventario_inflado",
  "corta_fecha_vencido",
];

/**
 * Canonicalización a UND de lo que despachó el despachador.
 *
 * El despachador guarda la cantidad EN LA UNIDAD del renglón (un ítem son varios
 * renglones, uno por UM, y cada UM tiene su propio factor), así que el número
 * crudo no es comparable con nada. `cantidad_despachador × factor` da SIEMPRE el
 * total real en UND, que es la unidad en la que el auditor guarda su conteo.
 *
 * Sin esto, un renglón en P48 con cantidad_despachador=2 (96 UND reales) contra un
 * auditor que contó 96 daba diferencia 94 en vez de 0.
 *
 * El fallback a 1 cubre `factor` nulo o 0: la columna es `numeric(12,4) default 1`
 * pero es nullable, y un factor 0 anularía la cantidad. Misma defensa que usan
 * `compararAuditoria` y `filasComparativo`.
 *
 * @param {{cantidad_despachador?: number, factor?: number}} item
 * @returns {number} total despachado en UND
 */
export function despachadoEnUnd(item) {
  return (Number(item?.cantidad_despachador) || 0) * (Number(item?.factor) || 1);
}

/**
 * Estadísticas de motivos de faltante para el dashboard: por cada motivo, cuántas
 * veces ocurrió, cuántos ítems distintos lo tienen, y el ranking de ítems que más
 * lo repiten. Sirve para ver qué productos fallan más y cómo está el inventario.
 */
export async function estadisticasMotivos() {
  const PAGE = 1000;
  const rows = [];
  let desde = 0;
  for (;;) {
    const { data, error } = await supabase
      .from(TABLE)
      .select("codigo_item, descripcion, motivo")
      .not("motivo", "is", null)
      // Orden estable o las páginas se pisan (ver Despacho.findAllWithResumen).
      .order("id", { ascending: true })
      .range(desde, desde + PAGE - 1);
    if (error) throw new Error(`Error al leer motivos: ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE) break;
    desde += PAGE;
  }

  const porMotivo = {};
  const porItemMotivo = new Map();
  const itemsAfectados = new Set();
  for (const m of MOTIVOS_FALTANTE) porMotivo[m] = { ocurrencias: 0, items: new Set() };

  for (const it of rows) {
    const m = it.motivo;
    if (!porMotivo[m]) continue; // motivo desconocido → ignorar
    const codigo = String(it.codigo_item);
    porMotivo[m].ocurrencias++;
    porMotivo[m].items.add(codigo);
    itemsAfectados.add(codigo);

    const key = `${codigo}|${m}`;
    const prev = porItemMotivo.get(key);
    if (prev) prev.count++;
    else
      porItemMotivo.set(key, {
        codigo_item: codigo,
        descripcion: (it.descripcion || "").trim(),
        motivo: m,
        count: 1,
      });
  }

  const topItems = {};
  for (const m of MOTIVOS_FALTANTE) topItems[m] = [];
  for (const v of porItemMotivo.values()) topItems[v.motivo]?.push(v);
  for (const m of MOTIVOS_FALTANTE) {
    topItems[m] = topItems[m].sort((a, b) => b.count - a.count).slice(0, 20);
  }

  const porMotivoResumen = {};
  for (const m of MOTIVOS_FALTANTE) {
    porMotivoResumen[m] = { ocurrencias: porMotivo[m].ocurrencias, items: porMotivo[m].items.size };
  }

  return {
    por_motivo: porMotivoResumen,
    top_items: topItems,
    total_ocurrencias: rows.length,
    total_items: itemsAfectados.size,
  };
}

/**
 * Registrar la recolección de un item por el despachador.
 * Persiste la cantidad real, si quedó agotado y el motivo del faltante (si lo hay).
 * Tope duro: la cantidad recolectada NO puede superar la pedida por el admin.
 *
 * CANDADO POR RENGLÓN (migración 023)
 * Desde que un despacho lo pueden recolectar VARIAS personas a la vez, el renglón
 * queda de quien lo contó primero: `recolectado_por` se sella en la primera
 * escritura y, a partir de ahí, cualquier otra persona recibe 409. Sin esto, dos
 * personas que cuentan el mismo producto se pisan la cantidad y gana el último
 * POST — que es exactamente el accidente que el candado viejo (a nivel despacho)
 * evitaba a costa de dejar trabajar a uno solo.
 *
 * `recolectadoPor` NULO = escritura del SISTEMA, no de una persona: la
 * auto-clasificación del flujo llano marca motivos sobre renglones que nadie tocó.
 * En ese caso NO se valida el dueño y NO se sella ninguno — un renglón que resolvió
 * el sistema no es de nadie, y sellarlo dejaría al despachador sin poder corregirlo.
 *
 * EL RENGLÓN TIENE QUE SER DEL DESPACHO QUE SE ESTÁ RECOLECTANDO (`despachoId`)
 *
 * Antes se escribía por `id` a secas, y eso se comió un traslado real (27/09/2026,
 * ad75f5e5 → parte 2 818290c6): mientras un celular cerraba la recolección (un
 * POST con TODOS los renglones, que se procesa de a uno durante varios segundos),
 * otro apretó "Enviar primera parte" y los pendientes se mudaron al traslado
 * nuevo. El POST en curso siguió escribiendo por id y le estampó cantidad 0 y
 * dueño a 74 renglones que ya eran de la parte 2: el traslado nuevo nació
 * "contado en cero" sin que nadie lo tocara. Con el filtro, un renglón que se
 * mudó a mitad de camino no se toca: vuelve como RENGLON_FUERA_DEL_DESPACHO.
 *
 * ESCRITURA CONDICIONAL (compare-and-swap)
 * Entre leer el renglón y escribirlo pasan milisegundos en los que otra persona
 * puede tomarlo, o un "dividir" puede mudarlo. El UPDATE se ata a lo que se leyó
 * (mismo despacho, mismo dueño): si algo cambió, no escribe, se relee y se decide
 * de nuevo. Sin esto, dos personas que cuentan el mismo producto a la vez pasaban
 * las dos el chequeo del candado y ganaba la última.
 *
 * @param {string} itemId
 * @param {number} cantidad  - Cantidad real recolectada
 * @param {boolean} [agotado] - true si no hubo stock suficiente en bodega
 * @param {string|null} [motivo] - motivo del faltante: uno de MOTIVOS_FALTANTE, o null
 * CONTENEDORES (migración 037)
 * El total del renglón es `cantidad_suelta + Σ contenedores`. Esta escritura toca
 * SOLO la parte suelta:
 *   · con `cantidadSuelta` (el panel nuevo la manda siempre) se guarda tal cual y
 *     el total se arma acá con lo que hay en contenedores AHORA en la base;
 *   · sin ella (panel viejo, o la auto-clasificación del sistema), `cantidad` es el
 *     total de siempre y lo suelto se deduce restando los contenedores.
 * Con producto en contenedores no se puede marcar agotado ni cambiar la unidad:
 * agotado dice "no hay nada" y hay unidades en una canastilla; y las cantidades de
 * las canastillas están en la unidad actual del renglón.
 *
 * @param {string|null} [recolectadoPor] - correo de quien cuenta; null = el sistema
 * @param {string|null} [despachoId] - despacho al que TIENE que pertenecer el renglón
 * @param {number|null} [cantidadSuelta] - parte sin contenedor (UM del renglón)
 * @throws 409 RENGLON_TOMADO si el renglón ya lo está contando otra persona
 * @throws 409 RENGLON_FUERA_DEL_DESPACHO si el renglón no es (o dejó de ser) del despacho
 */
export async function updateCantidadDespachador(itemId, cantidad, agotado = false, motivo = null, nueva_um = null, nueva_cant_admin = null, nuevo_factor = null, recolectadoPor = null, despachoId = null, cantidadSuelta = null) {
  const pedidoEscritura = { itemId, cantidad, agotado, motivo, nueva_um, nueva_cant_admin, nuevo_factor, recolectadoPor, despachoId, cantidadSuelta };

  // Dos vueltas alcanzan: la segunda relee el renglón y, si lo que cambió fue el
  // dueño o el despacho, lanza el error que corresponde. Si vuelve a perder la
  // carrera es porque el renglón se está escribiendo en ráfaga desde otro lado, y
  // lo honesto es decirlo (409) para que el front reintente, no escribir a ciegas.
  for (let intento = 0; intento < 2; intento += 1) {
    const escrito = await intentarEscrituraDespachador(pedidoEscritura);
    if (escrito) return escrito;
  }
  const e = createError(
    409,
    "El producto cambió mientras se guardaba. Se va a reintentar solo.",
  );
  e.codigo = "RENGLON_EN_CARRERA";
  e.item_id = itemId;
  throw e;
}

/** Error de un renglón que no pertenece (o ya no) al despacho de la escritura. */
function renglonFueraDelDespacho(itemId, despachoId) {
  const e = createError(
    409,
    "Este producto ya no es parte de este traslado (se movió a otra parte o se quitó). No se guardó nada sobre él.",
  );
  e.codigo = "RENGLON_FUERA_DEL_DESPACHO";
  e.item_id = itemId;
  e.despacho_id = despachoId;
  return e;
}

/**
 * Un intento de escritura. Devuelve la fila escrita, o `null` si el renglón cambió
 * entre la lectura y la escritura (el llamador reintenta y la relectura decide).
 */
async function intentarEscrituraDespachador({ itemId, cantidad, agotado, motivo, nueva_um, nueva_cant_admin, nuevo_factor, recolectadoPor, despachoId, cantidadSuelta }) {
  // Traer cantidad_admin para validar el tope superior contra el valor real en BD.
  let lectura = supabase
    .from(TABLE)
    .select("cantidad_admin, unidad_medida, recolectado_por, despacho_id, cantidad_despachador")
    .eq("id", itemId);
  if (despachoId) lectura = lectura.eq("despacho_id", despachoId);
  const { data: item, error: errGet } = await lectura.maybeSingle();

  // Un error de lectura NO es "no existe": disfrazarlo de 404 hacía que un corte de
  // red se leyera como un renglón borrado.
  if (errGet) throw new Error(`Error al leer el ítem: ${errGet.message}`);
  if (!item) {
    if (despachoId) throw renglonFueraDelDespacho(itemId, despachoId);
    throw createError(404, "Item no encontrado");
  }

  // El dueño del renglón se compara normalizado: el correo puede venir con otra
  // capitalización según de dónde salga la sesión, y un "Luis@" contra un "luis@"
  // trabaría a la persona sobre su propio conteo.
  const mismoDueno = (a, b) =>
    String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();

  if (recolectadoPor && item.recolectado_por && !mismoDueno(item.recolectado_por, recolectadoPor)) {
    const e = createError(
      409,
      `Este producto lo está contando ${item.recolectado_por}. Elegí otro para no pisar su conteo.`,
    );
    // El front necesita distinguir este choque de un error de red para poder
    // marcar el renglón como ajeno en vez de reintentarlo para siempre.
    e.codigo = "RENGLON_TOMADO";
    e.item_id = itemId;
    e.dueno = item.recolectado_por;
    throw e;
  }

  // Lo que ya está en contenedores (037), leído AHORA de la base.
  const enContenedores =
    (await ContenedorModel.sumaPorItem([itemId])).get(itemId) || 0;
  const cambiaUm = Boolean(nueva_um && nueva_um !== item.unidad_medida);

  if (enContenedores > 0 && agotado) {
    throw createError(
      422,
      `Este producto tiene ${enContenedores} en contenedores: no se puede marcar agotado. Sacalo primero de los contenedores.`,
    );
  }
  if (enContenedores > 0 && cambiaUm) {
    throw createError(
      422,
      "Este producto ya está en contenedores: no se le puede cambiar la unidad. Sacalo primero de los contenedores.",
    );
  }

  // Parte suelta y total. Ver el encabezado.
  const suelta =
    cantidadSuelta !== null && cantidadSuelta !== undefined
      ? Math.max(0, Number(cantidadSuelta) || 0)
      : (Number(cantidad) || 0) - enContenedores;
  if (suelta < 0) {
    throw createError(
      422,
      `Este producto tiene ${enContenedores} en contenedores: el total no puede quedar en ${Number(cantidad) || 0}. Para bajarlo, sacalo del contenedor.`,
    );
  }
  const cant = suelta + enContenedores;

  const pedido = nueva_cant_admin !== null && nueva_cant_admin !== undefined
    ? Number(nueva_cant_admin)
    : Number(item.cantidad_admin) || 0;

  if (cant > pedido) {
    throw createError(
      422,
      `La cantidad recolectada (${cant}) no puede superar la pedida (${pedido})`,
    );
  }

  const motivoLimpio = motivo && MOTIVOS_FALTANTE.includes(motivo) ? motivo : null;

  const updatePayload = {
    cantidad_despachador: cant,
    cantidad_suelta: suelta,
    agotado: !!agotado,
    motivo: motivoLimpio,
  };

  // Se sella al dueño solo cuando cuenta una PERSONA. El sistema no reclama nada
  // (ver el bloque de arriba), y una re-escritura del mismo dueño no cambia nada.
  if (recolectadoPor) updatePayload.recolectado_por = recolectadoPor;

  // Si envían una unidad nueva y es distinta a la actual, la mutamos
  if (nueva_um && nueva_um !== item.unidad_medida) {
    updatePayload.unidad_medida = nueva_um;
    updatePayload.cantidad_admin = pedido;
    if (nuevo_factor) updatePayload.factor = nuevo_factor;
  }

  // UPDATE atado a lo que se leyó: mismo despacho y mismo dueño. Si otra escritura
  // se metió en el medio, no matchea ninguna fila y devolvemos null para releer.
  let escritura = supabase
    .from(TABLE)
    .update(updatePayload)
    .eq("id", itemId)
    .eq("despacho_id", item.despacho_id);
  if (recolectadoPor) {
    escritura =
      item.recolectado_por == null
        ? escritura.is("recolectado_por", null)
        : escritura.eq("recolectado_por", item.recolectado_por);
  }
  const { data, error } = await escritura.select().maybeSingle();

  if (error) throw new Error(`Error al actualizar cantidad despachador: ${error.message}`);
  return data || null;
}

/**
 * Resetear la recolección de TODOS los ítems de un despacho: los deja como
 * "nunca registrados" (cantidad_despachador null, sin agotado ni motivo). Se usa
 * al ABANDONAR una recolección: el despacho vuelve al pool limpio y el próximo
 * despachador cuenta —y firma— todo desde cero (trazabilidad de la firma).
 * NO revierte mutaciones de UM: esas reflejan el empaque real del producto, no
 * el conteo de una persona.
 */
export async function resetRecoleccionByDespacho(despachoId) {
  const { error } = await supabase
    .from(TABLE)
    // `recolectado_por` se limpia con el resto: si se vuelve a contar todo desde
    // cero, los renglones tienen que quedar libres para que los tome quien esté
    // recolectando ahora. Si no, un despacho recontado quedaría trabado por los
    // dueños de la vuelta anterior — gente que quizá ni está en el turno.
    .update({
      cantidad_despachador: null,
      cantidad_suelta: null,
      agotado: false,
      motivo: null,
      recolectado_por: null,
    })
    .eq("despacho_id", despachoId);
  if (error) throw new Error(`Error al resetear la recolección: ${error.message}`);
}

/**
 * Insertar un ítem que el auditor recibió pero NO venía en la lista original del
 * despachador. Queda marcado con `agregado_por_auditor = true`, sin cantidad del
 * admin/despachador (0), y con la diferencia = lo que contó el auditor (todo sobrante).
 *
 * Acá NO hace falta `despachadoEnUnd`: no se despachó nada (cantidad_despachador 0),
 * así que el factor no participa y la diferencia es el conteo del auditor, que ya
 * viene en UND. No "corregir" esto multiplicando por factor.
 *
 * @param {string} despachoId
 * @param {object} item - { codigo_item, descripcion, unidad_medida, cantidad_auditor }
 */
export async function insertItemAuditor(despachoId, item) {
  const cantidadAuditor = Number(item.cantidad_auditor) || 0;
  const codigo = String(item.codigo_item || "").trim() || "S/COD";

  // RED DE SEGURIDAD: no duplicar un renglón que YA está en el despacho.
  //
  // El panel decide si un escaneo es "extra" o no, y ya hubo un bug ahí: cuando
  // el lector daba un EAN, el match fallaba, SIESA resolvía el código bueno y
  // nadie volvía a buscarlo — así el ítem se insertaba como sobrante aunque
  // estuviera en la lista. El renglón quedaba partido en dos: uno con su pedido
  // y otro con pedido 0 y una diferencia en rojo que no era real.
  //
  // Eso se corrigió en el panel, pero la guarda vive acá porque esta es la única
  // puerta por la que entra un renglón agregado: cualquier otro camino que caiga
  // en lo mismo queda cubierto sin depender de que el cliente venga bien.
  //
  // Se SUMA al renglón existente en vez de rechazar: la mercancía se contó de
  // verdad, y perder ese conteo sería peor que el duplicado que estamos evitando.
  // Se comparan NORMALIZADOS y no con un `.eq()`: SIESA muestra los códigos
  // rellenados con ceros a 7 dígitos ("0189202") y nosotros guardamos el número
  // pelado ("189202"). Con la igualdad exacta, un renglón que llegara con el
  // relleno esquivaba esta guarda y se duplicaba igual — que es justo lo que la
  // guarda existe para evitar.
  const sinCeros = (c) => {
    const t = String(c ?? "").trim();
    return t.replace(/^0+/, "") || t;
  };
  const { data: delDespacho } = await supabase
    .from(TABLE)
    .select("id, codigo_item, cantidad_auditor, cantidad_despachador, factor")
    .eq("despacho_id", despachoId);

  const existente = (delDespacho || []).find(
    (r) => sinCeros(r.codigo_item) === sinCeros(codigo),
  );

  if (existente) {
    const total = (Number(existente.cantidad_auditor) || 0) + cantidadAuditor;
    console.warn(
      `[auditoría] ${codigo} ya existe en el despacho ${despachoId}: se suma al renglón ` +
        `(${existente.cantidad_auditor ?? 0} + ${cantidadAuditor} = ${total}) en vez de duplicarlo.`,
    );
    return updateCantidadAuditor(existente.id, total);
  }

  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      despacho_id: despachoId,
      codigo_item: codigo,
      descripcion: item.descripcion || null,
      unidad_medida: item.unidad_medida || null,
      // Grupo y subgrupo del catálogo (los completa `completarFichaItem`). Sin
      // esto el ítem agregado cae al final de la lista, en la bolsa de "Sin
      // grupo", justo donde nadie lo busca: es mercancía que llegó de sorpresa y
      // lo que se quiere es verla junto a sus pares al recorrer el pasillo.
      grupo: item.grupo || null,
      categoria: item.categoria || null,
      cantidad_admin: 0,
      cantidad_despachador: 0,
      cantidad_auditor: cantidadAuditor,
      diferencia: cantidadAuditor,
      agregado_por_auditor: true,
    })
    .select()
    .single();

  if (error) throw new Error(`Error al insertar ítem del auditor: ${error.message}`);
  return data;
}

/**
 * Marcar un ítem como "No recibido" por el auditor (informativo, no toca SIESA).
 * Lee el ítem primero para calcular diferencia correcta, setea cantidad_auditor=0
 * y no_recibido=true. #5.
 */
export async function marcarNoRecibido(itemId, despachoId = null) {
  const item = await leerParaAuditoria(itemId, despachoId);

  // Contado 0 (no llegó) menos lo despachado, ambos en UND.
  const diferencia = 0 - despachadoEnUnd(item);

  let q = supabase
    .from(TABLE)
    .update({
      cantidad_auditor: 0,
      diferencia,
      no_recibido: true,
    })
    .eq("id", itemId);
  if (despachoId) q = q.eq("despacho_id", despachoId);
  const { data, error } = await q.select().single();

  if (error) throw new Error(`Error al marcar no recibido: ${error.message}`);
  return data;
}

/**
 * Lee lo que la auditoría necesita de un renglón para calcular la diferencia.
 * Con `despachoId` exige que el renglón sea de ese despacho: el conteo del auditor
 * de un traslado no puede terminar escrito en otro.
 */
async function leerParaAuditoria(itemId, despachoId) {
  let q = supabase.from(TABLE).select("cantidad_despachador, factor").eq("id", itemId);
  if (despachoId) q = q.eq("despacho_id", despachoId);
  const { data: item, error } = await q.maybeSingle();
  if (error) throw new Error(`Error al leer el ítem: ${error.message}`);
  if (!item) {
    throw createError(
      422,
      despachoId
        ? "Un producto del conteo no pertenece a este traslado. Recargá la recepción."
        : "Item no encontrado",
    );
  }
  return item;
}

/**
 * Actualizar cantidad_auditor y diferencia de un item.
 * `cantidadAuditor` ya viene en UND (el auditor cuenta y envía en UND), así que lo
 * despachado se canonicaliza para comparar en la misma unidad.
 *
 * `no_recibido` se apaga a propósito: si hay un conteo, el producto llegó. Sin
 * esto, un renglón marcado "no recibido" en un intento anterior conservaba la
 * marca aunque el auditor después lo contara.
 */
export async function updateCantidadAuditor(itemId, cantidadAuditor, despachoId = null) {
  // Primero obtenemos el item para calcular diferencia (con factor: ver despachadoEnUnd)
  const item = await leerParaAuditoria(itemId, despachoId);

  const diferencia = (Number(cantidadAuditor) || 0) - despachadoEnUnd(item);

  let q = supabase
    .from(TABLE)
    .update({
      cantidad_auditor: cantidadAuditor,
      diferencia,
      no_recibido: false,
    })
    .eq("id", itemId);
  if (despachoId) q = q.eq("despacho_id", despachoId);
  const { data, error } = await q.select().single();

  if (error) throw new Error(`Error al actualizar cantidad auditor: ${error.message}`);
  return data;
}

/**
 * Actualizar estado aceptado/rechazado de un item.
 */
export async function updateAceptado(itemId, aceptado) {
  const { data, error } = await supabase
    .from(TABLE)
    .update({ aceptado })
    .eq("id", itemId)
    .select()
    .single();

  if (error) throw new Error(`Error al actualizar aceptado: ${error.message}`);
  return data;
}
