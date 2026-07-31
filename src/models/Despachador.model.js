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

const normalizar = (d) => ({
  documento: String(d.documento || "").trim(),
  nombre: String(d.nombre || "").trim().toUpperCase().replace(/\s+/g, " "),
  telefono: d.telefono?.trim() || null,
});

export async function crear(payload) {
  const fila = normalizar(payload);
  if (!fila.documento) throw createError(422, "El documento es obligatorio");
  if (!fila.nombre) throw createError(422, "El nombre es obligatorio");

  const { data, error } = await supabase.from(TABLE).insert(fila).select().single();

  if (error?.code === "23505") {
    throw createError(409, `Ya hay un despachador activo con el documento ${fila.documento}`);
  }
  if (error) throw new Error(`Error al crear el despachador: ${error.message}`);
  return data;
}

export async function actualizar(id, payload) {
  const fila = { ...normalizar(payload), updated_at: new Date().toISOString() };
  if (!fila.documento) throw createError(422, "El documento es obligatorio");
  if (!fila.nombre) throw createError(422, "El nombre es obligatorio");

  const { data, error } = await supabase
    .from(TABLE)
    .update(fila)
    .eq("id", id)
    .select()
    .single();

  if (error?.code === "23505") {
    throw createError(409, `Ya hay un despachador activo con el documento ${fila.documento}`);
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
