import { supabase } from "../config/supabase.js";
import { createError } from "../middleware/errorHandler.js";

const TABLE = "traslados_items";

/** Motivos válidos de faltante (espejo del CHECK de la migración 004). */
export const MOTIVOS_FALTANTE = ["sin_stock", "surtido_parcial", "inventario_inflado"];

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
 * @param {string} itemId
 * @param {number} cantidad  - Cantidad real recolectada
 * @param {boolean} [agotado] - true si no hubo stock suficiente en bodega
 * @param {string|null} [motivo] - motivo del faltante: uno de MOTIVOS_FALTANTE, o null
 */
export async function updateCantidadDespachador(itemId, cantidad, agotado = false, motivo = null, nueva_um = null, nueva_cant_admin = null, nuevo_factor = null) {
  // Traer cantidad_admin para validar el tope superior contra el valor real en BD.
  const { data: item, error: errGet } = await supabase
    .from(TABLE)
    .select("cantidad_admin, unidad_medida")
    .eq("id", itemId)
    .single();

  if (errGet || !item) throw createError(404, "Item no encontrado");

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
 * Insertar un ítem que el auditor recibió pero NO venía en la lista original del
 * despachador. Queda marcado con `agregado_por_auditor = true`, sin cantidad del
 * admin/despachador (0), y con la diferencia = lo que contó el auditor (todo sobrante).
 *
 * @param {string} despachoId
 * @param {object} item - { codigo_item, descripcion, unidad_medida, cantidad_auditor }
 */
export async function insertItemAuditor(despachoId, item) {
  const cantidadAuditor = Number(item.cantidad_auditor) || 0;
  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      despacho_id: despachoId,
      codigo_item: String(item.codigo_item || "").trim() || "S/COD",
      descripcion: item.descripcion || null,
      unidad_medida: item.unidad_medida || null,
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
 * Actualizar cantidad_auditor y diferencia de un item.
 */
export async function updateCantidadAuditor(itemId, cantidadAuditor) {
  // Primero obtenemos el item para calcular diferencia
  const { data: item } = await supabase
    .from(TABLE)
    .select("cantidad_despachador")
    .eq("id", itemId)
    .single();

  if (!item) throw new Error("Item no encontrado");

  const diferencia = (cantidadAuditor || 0) - (item.cantidad_despachador || 0);

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
