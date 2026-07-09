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

  // Dedup por codigo_item: el Excel suele traer el mismo ítem repetido y un
  // upsert con dos filas de la misma clave en el mismo batch rompe con
  // "ON CONFLICT DO UPDATE command cannot affect row a second time" (500).
  // Gana la última aparición (la fila de más abajo en el Excel).
  const porItem = new Map();
  for (const i of items) {
    const codigo_item = String(i.codigo_item ?? i.item ?? "").trim();
    if (!codigo_item) continue;
    const fila = { codigo_item, capacidad: num(i.capacidad), updated_at: ts };
    const desc = i.descripcion != null ? String(i.descripcion).trim() : "";
    if (desc) fila.descripcion = desc; // solo si viene, para no pisar la existente
    porItem.set(codigo_item, fila);
  }
  const filas = Array.from(porItem.values());

  // Separar filas CON y SIN descripción y upsertarlas en tandas distintas.
  // Clave: PostgREST arma el set de columnas del UNIÓN de keys del batch, y en
  // el ON CONFLICT solo actualiza esas columnas. Así, re-subir un Excel SIN
  // columna descripción no borra las descripciones ya guardadas.
  const conDesc = filas.filter((f) => f.descripcion != null);
  const sinDesc = filas.filter((f) => f.descripcion == null);

  const CHUNK = 500;
  const upsertLote = async (arr) => {
    for (let i = 0; i < arr.length; i += CHUNK) {
      const chunk = arr.slice(i, i + CHUNK);
      const { error } = await supabase
        .from(TABLE)
        .upsert(chunk, { onConflict: "codigo_item" });
      if (error) throw new Error(`Error al guardar capacidades: ${error.message}`);
    }
  };
  await upsertLote(conDesc);
  await upsertLote(sinDesc);

  return filas.length;
}

/**
 * Actualiza (o crea) la capacidad de un solo ítem. Sirve para editar y para
 * CREAR un ítem nuevo a mano (el upsert lo inserta si no existe).
 * `descripcion` es opcional: si no viene, no se toca la existente.
 */
export async function actualizar(codigoItem, capacidad, descripcion) {
  const fila = {
    codigo_item: String(codigoItem).trim(),
    capacidad: num(capacidad),
    updated_at: new Date().toISOString(),
  };
  if (descripcion != null) fila.descripcion = String(descripcion).trim();

  const { data, error } = await supabase
    .from(TABLE)
    .upsert(fila, { onConflict: "codigo_item" })
    .select()
    .single();
  if (error) throw new Error(`Error al actualizar capacidad: ${error.message}`);
  return data;
}
