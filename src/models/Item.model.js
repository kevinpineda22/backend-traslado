import { supabase } from "../config/supabase.js";
import { createError } from "../middleware/errorHandler.js";

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
 * @param {string} itemId
 * @param {number} cantidad  - Cantidad real recolectada
 * @param {boolean} [agotado] - true si no hubo stock suficiente en bodega
 * @param {string|null} [motivo] - motivo del faltante: uno de MOTIVOS_FALTANTE, o null
 * @param {string|null} [recolectadoPor] - correo de quien cuenta; null = el sistema
 * @throws 409 si el renglón ya lo está contando otra persona
 */
export async function updateCantidadDespachador(itemId, cantidad, agotado = false, motivo = null, nueva_um = null, nueva_cant_admin = null, nuevo_factor = null, recolectadoPor = null) {
  // Traer cantidad_admin para validar el tope superior contra el valor real en BD.
  const { data: item, error: errGet } = await supabase
    .from(TABLE)
    .select("cantidad_admin, unidad_medida, recolectado_por")
    .eq("id", itemId)
    .single();

  if (errGet || !item) throw createError(404, "Item no encontrado");

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

  const cant = Number(cantidad) || 0;
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

  const { data, error } = await supabase
    .from(TABLE)
    .update(updatePayload)
    .eq("id", itemId)
    .select()
    .single();

  if (error) throw new Error(`Error al actualizar cantidad despachador: ${error.message}`);
  return data;
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
    .update({ cantidad_despachador: null, agotado: false, motivo: null, recolectado_por: null })
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
export async function marcarNoRecibido(itemId) {
  const { data: item } = await supabase
    .from(TABLE)
    .select("cantidad_despachador, factor")
    .eq("id", itemId)
    .single();

  if (!item) throw new Error("Item no encontrado");

  // Contado 0 (no llegó) menos lo despachado, ambos en UND.
  const diferencia = 0 - despachadoEnUnd(item);

  const { data, error } = await supabase
    .from(TABLE)
    .update({
      cantidad_auditor: 0,
      diferencia,
      no_recibido: true,
    })
    .eq("id", itemId)
    .select()
    .single();

  if (error) throw new Error(`Error al marcar no recibido: ${error.message}`);
  return data;
}

/**
 * Actualizar cantidad_auditor y diferencia de un item.
 * `cantidadAuditor` ya viene en UND (el auditor cuenta y envía en UND), así que lo
 * despachado se canonicaliza para comparar en la misma unidad.
 */
export async function updateCantidadAuditor(itemId, cantidadAuditor) {
  // Primero obtenemos el item para calcular diferencia (con factor: ver despachadoEnUnd)
  const { data: item } = await supabase
    .from(TABLE)
    .select("cantidad_despachador, factor")
    .eq("id", itemId)
    .single();

  if (!item) throw new Error("Item no encontrado");

  const diferencia = (Number(cantidadAuditor) || 0) - despachadoEnUnd(item);

  const { data, error } = await supabase
    .from(TABLE)
    .update({
      cantidad_auditor: cantidadAuditor,
      diferencia,
    })
    .eq("id", itemId)
    .select()
    .single();

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
