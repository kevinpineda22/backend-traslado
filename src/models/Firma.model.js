import { supabase } from "../config/supabase.js";

const TABLE = "traslados_firmas";

/**
 * Guardar una firma digital.
 * @param {object} payload - { despacho_id, rol, firma_data }
 */
export async function create(payload) {
  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      despacho_id: payload.despacho_id,
      rol: payload.rol,
      firma_data: payload.firma_data,
    })
    .select()
    .single();

  if (error) throw new Error(`Error al guardar firma: ${error.message}`);
  return data;
}

/**
 * Obtener firmas de un despacho.
 */
export async function findByDespacho(despachoId) {
  const { data, error } = await supabase
    .from(TABLE)
    .select("*")
    .eq("despacho_id", despachoId)
    .order("created_at", { ascending: true });

  if (error) throw new Error(`Error al obtener firmas: ${error.message}`);
  return data;
}
