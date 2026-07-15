import { supabase } from "../config/supabase.js";
import { createError } from "../middleware/errorHandler.js";

const TABLE = "traslados_items";

/** Motivos válidos de faltante (espejo del CHECK de la migración 004). */
export const MOTIVOS_FALTANTE = ["sin_stock", "surtido_parcial", "inventario_inflado"];

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
export async function updateCantidadDespachador(itemId, cantidad, agotado = false, motivo = null) {
  // Traer cantidad_admin para validar el tope superior contra el valor real en BD.
  const { data: item, error: errGet } = await supabase
    .from(TABLE)
    .select("cantidad_admin")
    .eq("id", itemId)
    .single();

  if (errGet || !item) throw createError(404, "Item no encontrado");

  const cant = Number(cantidad) || 0;
  const pedido = Number(item.cantidad_admin) || 0;
  if (cant > pedido) {
    throw createError(
      422,
      `La cantidad recolectada (${cant}) no puede superar la pedida (${pedido})`,
    );
  }

  const motivoLimpio = motivo && MOTIVOS_FALTANTE.includes(motivo) ? motivo : null;

  const { data, error } = await supabase
    .from(TABLE)
    .update({
      cantidad_despachador: cant,
      agotado: !!agotado,
      motivo: motivoLimpio,
    })
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
