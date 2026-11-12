import { supabase } from "../config/supabase.js";
import { porCodigos, normCodigoCatalogo } from "./Catalogo.model.js";

/* =============================================
   Portafolio EXTRA por sede (tabla `traslados_portafolio_extra`, migración 043)

   Un administrador agrega a mano un producto (destino + código de ítem) al
   portafolio de UNA sede. El producto aparece en la lista de esa sede en TODOS los
   flujos aunque no tenga capacidad, no se haya movido nunca allí o no exista en el
   origen (ver `getProductosLlano` y `getProductosTraslado` en siesa.service.js).

   VIVE SOLO EN SUPABASE. Agregar un extra no escribe nada en SIESA.

   La clave es (destino, codigo_item) y `codigo_item` es el código de SIESA como
   texto sin espacios, igual que en `traslados_snapshot` y `traslados_catalogo`.
   ============================================= */

const TABLE = "traslados_portafolio_extra";

const normDestino = (d) => String(d ?? "").trim();

/** Lotes de `.in()` para no exceder la URL de Supabase. */
const LOTE = 300;

/**
 * ¿El error es "la tabla no existe"? Pasa si el backend se despliega antes de correr
 * la migración 043. En ese caso NO hay extras y el resto del sistema tiene que seguir
 * funcionando; cualquier otro error (red, permisos) sí se propaga: un extra que
 * desaparece en silencio por un fallo transitorio sería un producto que "se esfumó".
 */
function tablaInexistente(error, { estricto = false } = {}) {
  const porCodigo = error?.code === "42P01" || error?.code === "PGRST205";
  // Modo estricto (la guardia del ajuste): SOLO los códigos. Un mensaje que casualmente diga
  // "does not exist" (una columna, una función, un permiso) NO prueba que no haya extras, y
  // tomarlo por "no hay extras" deja pasar un ajuste de inventario.
  if (estricto) return porCodigo;
  return porCodigo || /does not exist|could not find the table/i.test(String(error?.message ?? ""));
}

function avisarSinTabla() {
  console.warn("[portafolio-extra] la tabla traslados_portafolio_extra no existe: ¿falta la migración 043?");
}

/**
 * Códigos extra de UNA sede. Sin la tabla (migración 043 pendiente) devuelve vacío.
 * @returns {Promise<Set<string>>}
 */
export async function codigosDe(destino) {
  const PAGE = 1000;
  const codigos = new Set();
  for (let desde = 0; ; desde += PAGE) {
    const { data, error } = await supabase
      .from(TABLE)
      .select("codigo_item")
      .eq("destino", normDestino(destino))
      .order("codigo_item")
      .range(desde, desde + PAGE - 1);
    if (error) {
      if (tablaInexistente(error)) {
        avisarSinTabla();
        return new Set();
      }
      throw new Error(`Error al leer el portafolio extra: ${error.message}`);
    }
    for (const r of data || []) codigos.add(normCodigoCatalogo(r.codigo_item));
    if (!data || data.length < PAGE) break;
  }
  return codigos;
}

/**
 * De los códigos dados, los que son extra de `destino` Y NO tienen fila en el snapshot
 * de la bodega `origen`. Es la consulta del guardia del ajuste automático de inventario
 * (requisicion.service.js): un extra sin fila en el origen tiene disponible 0 allí, y
 * despacharlo dispararía un ajuste que CREA inventario en SIESA de producción.
 *
 * Sin la tabla de extras (SOLO por código 42P01 / PGRST205) devuelve [] (no hay extras).
 * Cualquier otro error se propaga: el guardia tiene que fallar cerrado, no adivinar.
 *
 * `codigos` llegan crudos (tal como los dio SIESA): acá se normalizan con el normalizador
 * único. `noParseables` avisa que algún faltante no tenía un código interpretable.
 *
 * @returns {Promise<string[]>} códigos
 */
export async function extrasSinOrigen(destino, origen, codigos, { noParseables = false } = {}) {
  const ESTRICTO = { estricto: true };
  const dest = normDestino(destino);

  // Un faltante cuyo código no se pudo interpretar no se puede cruzar con nada. Si la sede
  // no tiene extras da igual; si tiene alguno, no hay forma de descartar que sea uno de
  // ellos → se corta (falla cerrado) en vez de dejar pasar el ajuste.
  if (noParseables) {
    const { count, error } = await supabase
      .from(TABLE)
      .select("*", { count: "exact", head: true })
      .eq("destino", dest);
    if (error) {
      if (tablaInexistente(error, ESTRICTO)) {
        avisarSinTabla();
        return [];
      }
      throw new Error(`Error al leer el portafolio extra: ${error.message}`);
    }
    if ((count || 0) > 0) {
      throw new Error(
        "Hay códigos de faltante que no se pudieron interpretar y la sede tiene productos extra: " +
          "no se puede descartar que alguno lo sea.",
      );
    }
  }

  // Formas crudas de cada código (tal como llegó de SIESA), agrupadas por su forma normalizada.
  // El snapshot guarda el código tal cual lo dio SIESA, así que contra él se prueban las dos.
  const crudasDe = new Map();
  for (const c of codigos || []) {
    const crudo = String(c ?? "").trim();
    const norm = normCodigoCatalogo(crudo);
    if (!norm) continue;
    if (!crudasDe.has(norm)) crudasDe.set(norm, new Set());
    crudasDe.get(norm).add(crudo);
  }
  const unicos = [...crudasDe.keys()];

  const extras = [];
  for (let i = 0; i < unicos.length; i += LOTE) {
    const { data, error } = await supabase
      .from(TABLE)
      .select("codigo_item")
      .eq("destino", dest)
      .in("codigo_item", unicos.slice(i, i + LOTE));
    if (error) {
      if (tablaInexistente(error, ESTRICTO)) {
        avisarSinTabla();
        return [];
      }
      throw new Error(`Error al leer el portafolio extra: ${error.message}`);
    }
    for (const r of data || []) extras.push(normCodigoCatalogo(r.codigo_item));
  }
  if (extras.length === 0) return [];

  const conOrigen = new Set();
  for (let i = 0; i < extras.length; i += LOTE) {
    const lote = extras.slice(i, i + LOTE);
    // Forma normalizada Y formas crudas: si el snapshot lo guardó con ceros, también lo ve.
    const variantes = [...new Set(lote.flatMap((c) => [c, ...(crudasDe.get(c) || [])]))];
    const { data, error } = await supabase
      .from("traslados_snapshot")
      .select("codigo_item")
      .eq("bodega", normDestino(origen))
      .in("codigo_item", variantes);
    if (error) throw new Error(`Error al leer el snapshot del origen: ${error.message}`);
    for (const r of data || []) conOrigen.add(normCodigoCatalogo(r.codigo_item));
  }
  return extras.filter((c) => !conOrigen.has(c));
}

/**
 * Extras de una sede con los datos del catálogo. Sin FK en la base: se leen las dos
 * tablas y se cruzan acá. Un extra cuyo ítem ya salió del catálogo (dejó de estar
 * activo) se devuelve igual, con los campos del catálogo en null: sigue agregado.
 *
 * @returns {Promise<Array<{destino, codigo_item, agregado_por, created_at, descripcion, referencia, um, grupo, subgrupo}>>}
 */
export async function listar(destino) {
  const dest = normDestino(destino);
  const PAGE = 1000;
  const extras = [];
  for (let desde = 0; ; desde += PAGE) {
    const { data, error } = await supabase
      .from(TABLE)
      .select("destino, codigo_item, agregado_por, created_at")
      .eq("destino", dest)
      .order("created_at", { ascending: false })
      .order("codigo_item")
      .range(desde, desde + PAGE - 1);
    if (error) throw new Error(`Error al listar el portafolio extra: ${error.message}`);
    extras.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }

  const catalogo = await porCodigos(extras.map((e) => e.codigo_item));
  return extras.map((e) => {
    const c = catalogo.get(normCodigoCatalogo(e.codigo_item));
    return {
      destino: e.destino,
      codigo_item: e.codigo_item,
      agregado_por: e.agregado_por,
      created_at: e.created_at,
      descripcion: c?.descripcion ?? null,
      referencia: c?.referencia ?? null,
      um: c?.um ?? null,
      grupo: c?.grupo ?? null,
      subgrupo: c?.subgrupo ?? null,
    };
  });
}

/** Una fila del extra o null. */
async function obtener(destino, codigo) {
  const { data, error } = await supabase
    .from(TABLE)
    .select("destino, codigo_item, agregado_por, created_at")
    .eq("destino", normDestino(destino))
    .eq("codigo_item", normCodigoCatalogo(codigo))
    .maybeSingle();
  if (error) throw new Error(`Error al leer el portafolio extra: ${error.message}`);
  return data || null;
}

/**
 * Agrega un ítem al portafolio de una sede. IDEMPOTENTE: si ya estaba, no falla ni
 * pisa quién lo agregó; devuelve la fila existente con `creado: false`.
 *
 * Esta función NO valida que el destino sea una sede ni que el ítem exista en el
 * catálogo: eso lo hace el controlador, que es quien sabe responder 400/404.
 *
 * @returns {Promise<{ creado: boolean, fila: object }>}
 */
export async function agregar({ destino, codigo_item, agregado_por }) {
  const dest = normDestino(destino);
  const codigo = normCodigoCatalogo(codigo_item);

  const previo = await obtener(dest, codigo);
  if (previo) return { creado: false, fila: previo };

  const { data, error } = await supabase
    .from(TABLE)
    .insert({ destino: dest, codigo_item: codigo, agregado_por: String(agregado_por).trim() })
    .select("destino, codigo_item, agregado_por, created_at")
    .single();

  if (error) {
    // Dos administradores agregando lo mismo a la vez: gana uno, el otro lo ve ya
    // agregado. Para quien llama es el mismo resultado que el camino idempotente.
    if (error.code === "23505") {
      const ganador = await obtener(dest, codigo);
      if (ganador) return { creado: false, fila: ganador };
    }
    throw new Error(`Error al agregar al portafolio extra: ${error.message}`);
  }
  return { creado: true, fila: data };
}

/** Quita un ítem del portafolio de una sede. @returns {Promise<boolean>} true si existía. */
export async function quitar(destino, codigo) {
  const { error, count } = await supabase
    .from(TABLE)
    .delete({ count: "exact" })
    .eq("destino", normDestino(destino))
    .eq("codigo_item", normCodigoCatalogo(codigo));
  if (error) throw new Error(`Error al quitar del portafolio extra: ${error.message}`);
  return (count ?? 0) > 0;
}
