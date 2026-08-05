import { supabase } from "../config/supabase.js";
import { createError } from "../middleware/errorHandler.js";

const TABLE = "traslados_despachadores";

/* =============================================
   Maestro de despachadores (migración 016)

   Quién despacha — el equivalente al "titular del manifiesto" del documento
   oficial. Va en su propio maestro y NO se deriva de la sesión: el login
   identifica por correo, y el manifiesto necesita cédula y teléfono, que la
   sesión no tiene.

   Si algún día se les carga el correo acá, el modal puede preseleccionar al
   usuario logueado en vez de pedir que se elija.
   ============================================= */

export async function listarActivos() {
  const { data, error } = await supabase
    .from(TABLE)
    .select("*")
    .eq("activo", true)
    .order("nombre", { ascending: true });

  if (error) throw new Error(`Error al listar despachadores: ${error.message}`);
  return data || [];
}

export async function listarTodos() {
  const { data, error } = await supabase
    .from(TABLE)
    .select("*")
    .order("activo", { ascending: false })
    .order("nombre", { ascending: true });

  if (error) throw new Error(`Error al listar despachadores: ${error.message}`);
  return data || [];
}

export async function obtener(id) {
  const { data, error } = await supabase.from(TABLE).select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`Error al leer el despachador: ${error.message}`);
  return data;
}

/**
 * Sede de una persona, buscada por su correo de sesión. `null` = sin sede
 * cargada, o sea sin restricción: ve todas las bodegas (migración 025).
 *
 * LA RESUELVE EL SERVIDOR, no el cliente. El panel manda "soy este correo" y acá
 * se decide qué puede ver; si el front mandara la sede directamente, cambiarla
 * sería cuestión de editar la URL. No es una barrera real —este backend todavía
 * no autentica a nadie— pero es la forma correcta, y el día que haya auth el
 * filtro ya está del lado que corresponde.
 *
 * Un correo que no está en el maestro también devuelve `null`: no se le esconde
 * nada a alguien solo por no estar cargado, que dejaría a una persona nueva
 * mirando una pantalla vacía sin explicación.
 *
 * @param {string} correo
 * @returns {Promise<string|null>} código de bodega (PV001, 00201, …) o null
 */
export async function sedeDe(correo) {
  const clave = normalizarCorreo(correo);
  if (!clave) return null;

  const { data, error } = await supabase
    .from(TABLE)
    .select("sede")
    .eq("correo", clave)
    .eq("activo", true)
    .maybeSingle();

  if (error) {
    // No se propaga: quedarse sin sede degrada a "ve todo", que es el
    // comportamiento previo. Tumbar el panel entero por no poder acotarlo sería
    // peor que mostrarlo completo.
    console.error(`[traslados] no se pudo resolver la sede de ${clave}:`, error.message);
    return null;
  }
  return data?.sede || null;
}

/**
 * El correo va en MINÚSCULAS y sin espacios, siempre.
 *
 * No es cosmética: este valor se compara contra el correo de la sesión para
 * decidir si un despacho es tuyo (`assertPuedeRecolectar`). Un "Luis@..." cargado
 * a mano contra un "luis@..." de la sesión es una comparación que falla y deja el
 * despacho sin dueño visible, sin ningún error a la vista.
 */
const normalizarCorreo = (v) => {
  const c = String(v ?? "").trim().toLowerCase();
  return c || null;
};

const CORREO_VALIDO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Bodega donde trabaja la persona. Vacío → `null`, nunca "": el filtro compara
 * contra `despachos.origen` / `despachos.destino`, y una cadena vacía no
 * matchearía nada, dejando el panel en blanco en vez de sin restricción.
 */
const normalizarSede = (v) => String(v ?? "").trim().toUpperCase() || null;

const normalizar = (d) => ({
  // Sede opcional (migración 025). NULL = ve todas las bodegas.
  sede: normalizarSede(d.sede),
  // Cédula OPCIONAL desde la 021: va `null` y no "" cuando está vacía, porque el
  // índice único trata cada NULL como distinto pero dos cadenas vacías chocarían
  // entre sí — el segundo despachador sin cédula fallaría con un "duplicado" que
  // no tiene nada que ver con lo que la persona cargó.
  documento: String(d.documento || "").trim() || null,
  nombre: String(d.nombre || "").trim().toUpperCase().replace(/\s+/g, " "),
  telefono: d.telefono?.trim() || null,
  // Correo con el que esta persona se loguea. OBLIGATORIO: es lo que se guarda en
  // `despachador_id` al asignar un despacho y lo que el panel del despachador
  // compara para encontrarlo. Sin correo, el despacho asignado no lo ve nadie.
  correo: normalizarCorreo(d.correo),
});

/**
 * Valida lo que el maestro exige hoy: nombre y correo. La cédula y el teléfono son
 * opcionales (migración 021) — sin cédula el manifiesto sale con ese campo en
 * blanco, pero sin correo el despacho asignado no lo ve nadie.
 */
function validar(fila) {
  if (!fila.nombre) throw createError(422, "El nombre es obligatorio");
  if (!fila.correo) {
    throw createError(
      422,
      "El correo es obligatorio: es con el que la persona inicia sesión y con el " +
        "que se le asignan los despachos",
    );
  }
  if (!CORREO_VALIDO.test(fila.correo)) {
    throw createError(422, `El correo "${fila.correo}" no tiene un formato válido`);
  }
}

/**
 * Traduce el choque de clave única al campo que REALMENTE chocó. Hay dos índices
 * (documento y correo): decir siempre "documento repetido" mandaría a corregir el
 * campo equivocado y la persona daría vueltas sobre un dato que estaba bien.
 */
function choqueUnico(fila, error) {
  const detalle = `${error?.message || ""} ${error?.details || ""}`;
  if (/correo/i.test(detalle)) {
    return `El correo ${fila.correo} ya está asignado a otro despachador activo`;
  }
  return `Ya hay un despachador activo con el documento ${fila.documento}`;
}

export async function crear(payload) {
  const fila = normalizar(payload);
  validar(fila);

  const { data, error } = await supabase.from(TABLE).insert(fila).select().single();

  if (error?.code === "23505") {
    throw createError(409, choqueUnico(fila, error));
  }
  if (error) throw new Error(`Error al crear el despachador: ${error.message}`);
  return data;
}

export async function actualizar(id, payload) {
  const fila = { ...normalizar(payload), updated_at: new Date().toISOString() };
  validar(fila);

  const { data, error } = await supabase
    .from(TABLE)
    .update(fila)
    .eq("id", id)
    .select()
    .single();

  if (error?.code === "23505") {
    throw createError(409, choqueUnico(fila, error));
  }
  if (error || !data) throw createError(404, "Despachador no encontrado");
  return data;
}

/** Baja lógica: los manifiestos viejos lo siguen referenciando. */
export async function setActivo(id, activo) {
  const { data, error } = await supabase
    .from(TABLE)
    .update({ activo: !!activo, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();

  if (error || !data) throw createError(404, "Despachador no encontrado");
  return data;
}
