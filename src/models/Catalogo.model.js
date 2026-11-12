import { supabase } from "../config/supabase.js";

/* =============================================
   Catálogo de ítems activos de SIESA (tabla `traslados_catalogo`, migración 043)

   Es SOLO la identidad del ítem (código, descripción, UM, grupo...): no tiene
   inventario, que sigue viniendo del snapshot. Lo puebla `catalogo.service.js`
   desde la consulta de Connekta `merkahorro_catalogo_activo`.

   Para qué se lee:
     - Buscar el ítem que un administrador va a agregar al portafolio de una sede.
     - Validar que el ítem existe y está activo antes de agregarlo.
     - Dar descripción y UM a un ítem "extra" que no tiene fila en el snapshot.

   Este modelo NO importa nada de Connekta a propósito: `siesa.service.js` lo usa
   para armar la lista de productos, y esa ruta no debe arrastrar el cliente HTTP de
   Connekta (que además aborta el proceso si faltan sus variables de entorno).
   ============================================= */

const TABLE = "traslados_catalogo";
const TABLE_LOG = "traslados_catalogo_log";

// Supabase corta las URL largas: los `.in()` se trocean en lotes de este tamaño.
const LOTE_CODIGOS = 300;

/** Tope de resultados de una búsqueda: más que esto no se lee en un desplegable. */
export const LIMITE_BUSQUEDA_MAX = 100;
export const LIMITE_BUSQUEDA_DEFECTO = 50;
/** Texto mínimo para buscar: con 1 carácter el `ILIKE` devolvería medio catálogo. */
export const MINIMO_BUSQUEDA = 2;

/** Código de ítem en la misma forma en que se guarda (texto, sin espacios). */
export const normCodigoCatalogo = (c) => String(c ?? "").trim();

/**
 * Quita del texto de búsqueda lo que rompería el filtro `.or()` de PostgREST
 * (comas, paréntesis, comodines de `ILIKE`, comillas, barras). El usuario escribe
 * "LECHE 1/2 L, ENTERA" y no debe poder armar un filtro distinto al que quiso.
 */
function limpiarTexto(q) {
  return String(q ?? "")
    .replace(/[%_\,()*"']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Busca ítems por código exacto o por texto parcial en descripción/referencia.
 * El match de código exacto va PRIMERO: si el usuario pega "19", el ítem 19 tiene
 * que salir arriba de los 40 productos cuya descripción contiene "19".
 *
 * @param {string} q - texto (mínimo MINIMO_BUSQUEDA caracteres)
 * @param {number} [limit] - máximo de filas (tope LIMITE_BUSQUEDA_MAX)
 * @returns {Promise<object[]>} filas del catálogo; [] si el texto es muy corto
 */
export async function buscar(q, limit = LIMITE_BUSQUEDA_DEFECTO) {
  const texto = limpiarTexto(q);
  if (texto.length < MINIMO_BUSQUEDA) return [];
  const tope = Math.min(Math.max(Math.floor(Number(limit)) || LIMITE_BUSQUEDA_DEFECTO, 1), LIMITE_BUSQUEDA_MAX);

  const [exacto, parcial] = await Promise.all([
    supabase.from(TABLE).select("*").eq("codigo_item", texto).limit(1),
    supabase
      .from(TABLE)
      .select("*")
      .or(`descripcion.ilike.%${texto}%,referencia.ilike.%${texto}%`)
      .order("descripcion")
      .limit(tope),
  ]);
  if (exacto.error) throw new Error(`Error al buscar en el catálogo: ${exacto.error.message}`);
  if (parcial.error) throw new Error(`Error al buscar en el catálogo: ${parcial.error.message}`);

  const vistos = new Set();
  const salida = [];
  for (const fila of [...(exacto.data || []), ...(parcial.data || [])]) {
    if (vistos.has(fila.codigo_item)) continue;
    vistos.add(fila.codigo_item);
    salida.push(fila);
  }
  return salida.slice(0, tope);
}

/** Una fila del catálogo por código, o null si no existe. */
export async function obtener(codigo) {
  const { data, error } = await supabase
    .from(TABLE)
    .select("*")
    .eq("codigo_item", normCodigoCatalogo(codigo))
    .maybeSingle();
  if (error) throw new Error(`Error al leer el catálogo: ${error.message}`);
  return data || null;
}

/**
 * Filas del catálogo de varios códigos (troceado para no exceder la URL).
 * @returns {Promise<Map<string, object>>} codigo_item → fila (los que no existen no están)
 */
export async function porCodigos(codigos) {
  const unicos = [...new Set((codigos || []).map(normCodigoCatalogo).filter(Boolean))];
  const mapa = new Map();
  for (let i = 0; i < unicos.length; i += LOTE_CODIGOS) {
    const lote = unicos.slice(i, i + LOTE_CODIGOS);
    const { data, error } = await supabase.from(TABLE).select("*").in("codigo_item", lote);
    if (error) throw new Error(`Error al leer el catálogo: ${error.message}`);
    for (const fila of data || []) mapa.set(fila.codigo_item, fila);
  }
  return mapa;
}

/** Cuántas filas tiene el catálogo ahora mismo. Lanza si no se pudo contar. */
export async function contar() {
  const { count, error } = await supabase.from(TABLE).select("*", { count: "exact", head: true });
  if (error) throw new Error(`Error al contar el catálogo: ${error.message}`);
  return count || 0;
}

/** Cuántas filas tiene y cuándo fue el último refresco que escribió algo. */
export async function estado() {
  const [total, ultimo] = await Promise.all([
    contar(),
    supabase
      .from(TABLE)
      .select("sincronizado_at")
      .order("sincronizado_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (ultimo.error) throw new Error(`Error al leer el catálogo: ${ultimo.error.message}`);
  return { total, sincronizado_at: ultimo.data?.sincronizado_at || null };
}

/** Upsert de un lote de filas (clave: codigo_item). */
export async function upsertar(filas) {
  const { error } = await supabase.from(TABLE).upsert(filas, { onConflict: "codigo_item" });
  if (error) throw new Error(`Error al guardar el catálogo: ${error.message}`);
}

/**
 * Borra las filas que el refresco vigente NO vio (su `sincronizado_at` quedó
 * anterior al inicio). Devuelve cuántas borró.
 */
export async function podarAnterioresA(inicioIso) {
  const { error, count } = await supabase
    .from(TABLE)
    .delete({ count: "exact" })
    .lt("sincronizado_at", inicioIso);
  if (error) throw new Error(`Error al limpiar el catálogo: ${error.message}`);
  return count ?? null;
}

/** Una línea en la bitácora de refrescos. Quien llama decide si un fallo importa. */
export async function registrarLog(fila) {
  const { error } = await supabase.from(TABLE_LOG).insert(fila);
  if (error) throw new Error(error.message);
}
