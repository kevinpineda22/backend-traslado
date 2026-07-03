import { supabase } from "../config/supabase.js";
import { createError } from "../middleware/errorHandler.js";

const TABLE = "traslados_items";

/**
 * Registrar la recolección de un item por el despachador.
 * Persiste la cantidad real y si quedó agotado (faltante distinto de "no tocado").
 * Tope duro: la cantidad recolectada NO puede superar la pedida por el admin.
 *
 * @param {string} itemId
 * @param {number} cantidad  - Cantidad real recolectada
 * @param {boolean} [agotado] - true si no hubo stock suficiente en bodega
 */
export async function updateCantidadDespachador(itemId, cantidad, agotado = false) {
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

  const { data, error } = await supabase
    .from(TABLE)
    .update({
      cantidad_despachador: cant,
      agotado: !!agotado,
    })
    .eq("id", itemId)
    .select()
    .single();

  if (error) throw new Error(`Error al actualizar cantidad despachador: ${error.message}`);
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
