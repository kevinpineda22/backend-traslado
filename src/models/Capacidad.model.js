import { supabase } from "../config/supabase.js";

/* =============================================
   Capacidad de góndola por ítem (flujo Llano).

   El admin sube/edita un Excel (item, capacidad) desde un módulo aparte. Esta
   capacidad alimenta el cálculo A/B/C del sugerido en el flujo Llano.
   ============================================= */

const TABLE = "traslados_capacidad";
const num = (v) => Number(v) || 0;

// El Excel suele traer el código con ceros a la izquierda ("0000019"), pero el
// codigo_item del snapshot es numérico sin ceros ("19"). Normalizamos sacando
// los ceros de adelante para que la capacidad matchee con el sugerido.
const normCodigo = (c) => {
  const s = String(c ?? "").trim();
  return s.replace(/^0+/, "") || s;
};

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

/**
 * Devuelve un Map<codigo_item normalizado, Array<{ capacidad, unidad, factor }>>.
 * Un ítem puede tener VARIAS filas (una por UM). La fila "sin UM" (base) usa
 * unidad "". Si tiene UM, la `capacidad` está EN esa unidad (base = cap × factor).
 */
export async function mapaCapacidades() {
  const filas = await listar();
  const mapa = new Map();
  // Normalizamos la clave (sin ceros a la izquierda) para que matchee el
  // codigo_item del snapshot, incluso con filas viejas guardadas con ceros.
  for (const r of filas) {
    const k = normCodigo(r.codigo_item);
    if (!mapa.has(k)) mapa.set(k, []);
    mapa.get(k).push({
      capacidad: num(r.capacidad),
      unidad: r.unidad ? String(r.unidad).trim() : "",
      factor: r.factor != null ? num(r.factor) || null : null,
    });
  }
  return mapa;
}

/**
 * Factores (UND por paquete) de UN ítem, resueltos con una consulta puntual.
 *
 * `mapaCapacidades()` trae la tabla ENTERA — está bien para armar el listado de
 * productos, pero es carísimo para un escaneo de código de barras, que ocurre
 * una vez por producto tomado. Acá filtramos por ítem.
 *
 * @param {string} codigoItem
 * @returns {Promise<Map<string, number>>} unidad → factor (solo filas con UM y factor)
 */
export async function factoresDeItem(codigoItem) {
  const codigo = normCodigo(codigoItem);
  if (!codigo) return new Map();
  const { data, error } = await supabase
    .from(TABLE)
    .select("unidad, factor")
    .eq("codigo_item", codigo);
  if (error) throw new Error(`Error al leer factores del ítem: ${error.message}`);

  const porUnidad = new Map();
  for (const r of data || []) {
    const um = r.unidad ? String(r.unidad).trim() : "";
    const f = num(r.factor);
    if (um && f > 0) porUnidad.set(um, f);
  }
  return porUnidad;
}

/**
 * Upsert masivo desde el Excel. Reemplaza/actualiza la capacidad de cada ítem.
 * @param {Array<{item?, codigo_item?, capacidad}>} items
 * @returns {number} cantidad de filas afectadas
 */
export async function upsertBulk(items) {
  const ts = new Date().toISOString();

  // Dedup por (codigo_item, unidad): el Excel puede traer el MISMO ítem con UM
  // DISTINTAS (ej: CAJA y BULTO) → son filas separadas que NO se deben pisar. Un
  // upsert con dos filas de la MISMA clave en el mismo batch rompe con "ON CONFLICT
  // DO UPDATE command cannot affect row a second time" (500), por eso deduplicamos
  // por la clave compuesta (código|unidad), igual que el alta manual.
  // Sin columna UM en el Excel → unidad "" (fila base), como siempre.
  const porClave = new Map();
  for (const i of items) {
    const codigo_item = normCodigo(i.codigo_item ?? i.item ?? "");
    if (!codigo_item) continue;
    const unidad = String(i.unidad ?? i.um ?? "").trim(); // "" = fila base
    const factor = unidad ? (Number(i.factor) > 0 ? Number(i.factor) : 1) : null;
    const fila = { codigo_item, unidad, capacidad: num(i.capacidad), factor, updated_at: ts };
    const desc = i.descripcion != null ? String(i.descripcion).trim() : "";
    if (desc) fila.descripcion = desc; // solo si viene, para no pisar la existente
    porClave.set(`${codigo_item}|${unidad}`, fila);
  }
  const filas = Array.from(porClave.values());

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
        .upsert(chunk, { onConflict: "codigo_item,unidad" });
      if (error) throw new Error(`Error al guardar capacidades: ${error.message}`);
    }
  };
  await upsertLote(conDesc);
  await upsertLote(sinDesc);

  return filas.length;
}

/**
 * Actualiza (o crea) una fila (ítem + UM). La `unidad` es parte de la CLAVE:
 * "" es la fila base (capacidad en unidades), un valor es una fila de esa UM
 * (capacidad en esa UM). Así el mismo ítem puede tener CAJA + BULTO sin pisarse.
 */
export async function actualizar(codigoItem, capacidad, descripcion, unidad, factor) {
  const um = String(unidad || "").trim(); // "" = fila base
  const fila = {
    codigo_item: normCodigo(codigoItem),
    unidad: um,
    capacidad: num(capacidad),
    factor: um ? (Number(factor) > 0 ? Number(factor) : 1) : null,
    updated_at: new Date().toISOString(),
  };
  if (descripcion != null) fila.descripcion = String(descripcion).trim();

  const { data, error } = await supabase
    .from(TABLE)
    .upsert(fila, { onConflict: "codigo_item,unidad" })
    .select()
    .single();
  if (error) throw new Error(`Error al actualizar capacidad: ${error.message}`);
  return data;
}

/** Elimina una fila (ítem + UM). `unidad` "" = la fila base. */
export async function eliminar(codigoItem, unidad = "") {
  const { error } = await supabase
    .from(TABLE)
    .delete()
    .eq("codigo_item", normCodigo(codigoItem))
    .eq("unidad", String(unidad || "").trim());
  if (error) throw new Error(`Error al eliminar capacidad: ${error.message}`);
  return { ok: true };
}

/** Elimina TODAS las capacidades cargadas. */
export async function eliminarTodos() {
  // Supabase exige un filtro en delete; este matchea todas las filas.
  const { error } = await supabase
    .from(TABLE)
    .delete()
    .not("codigo_item", "is", null);
  if (error) throw new Error(`Error al eliminar capacidades: ${error.message}`);
  return { ok: true };
}
