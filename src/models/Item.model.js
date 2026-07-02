import { supabase } from "../config/supabase.js";

const TABLE = "traslados_items";

/**
 * Actualizar cantidad_despachador de un item.
 */
export async function updateCantidadDespachador(itemId, cantidad) {
  const { data, error } = await supabase
    .from(TABLE)
    .update({
      cantidad_despachador: cantidad,
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
