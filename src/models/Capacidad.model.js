import { supabase } from "../config/supabase.js";

/* =============================================
   Capacidad de góndola por ítem (flujo Llano).

   El admin sube/edita un Excel (item, capacidad) desde un módulo aparte. Esta
   capacidad alimenta el cálculo A/B/C del sugerido en el flujo Llano.
   ============================================= */

const TABLE = "traslados_capacidad";
const num = (v) => Number(v) || 0;

/** Lista completa de capacidades (para el módulo de gestión). */
export async function listar() {
  const PAGE = 1000;
  const todas = [];
  let desde = 0;
  for (;;) {
    const { data, error } = await supabase
      .from(TABLE)
      .select("*")
      .order("codigo_item")
      .range(desde, desde + PAGE - 1);
    if (error) throw new Error(`Error al listar capacidades: ${error.message}`);
    if (!data || data.length === 0) break;
    todas.push(...data);
    if (data.length < PAGE) break;
    desde += PAGE;
  }
  return todas;
}

/** Devuelve un Map<codigo_item, capacidad> con TODAS las capacidades. */
export async function mapaCapacidades() {
  const filas = await listar();
  const mapa = new Map();
  for (const r of filas) mapa.set(String(r.codigo_item), num(r.capacidad));
  return mapa;
}

/**
 * Upsert masivo desde el Excel. Reemplaza/actualiza la capacidad de cada ítem.
 * @param {Array<{item?, codigo_item?, capacidad}>} items
 * @returns {number} cantidad de filas afectadas
 */
export async function upsertBulk(items) {
  const ts = new Date().toISOString();
  const filas = items
    .map((i) => ({
      codigo_item: String(i.codigo_item ?? i.item ?? "").trim(),
      capacidad: num(i.capacidad),
      updated_at: ts,
    }))
    .filter((f) => f.codigo_item);

  const CHUNK = 500;
  for (let i = 0; i < filas.length; i += CHUNK) {
    const chunk = filas.slice(i, i + CHUNK);
    const { error } = await supabase
      .from(TABLE)
      .upsert(chunk, { onConflict: "codigo_item" });
    if (error) throw new Error(`Error al guardar capacidades: ${error.message}`);
  }
  return filas.length;
}

/** Actualiza (o crea) la capacidad de un solo ítem. */
export async function actualizar(codigoItem, capacidad) {
  const { data, error } = await supabase
    .from(TABLE)
    .upsert(
      {
        codigo_item: String(codigoItem).trim(),
        capacidad: num(capacidad),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "codigo_item" },
    )
    .select()
    .single();
  if (error) throw new Error(`Error al actualizar capacidad: ${error.message}`);
  return data;
}
