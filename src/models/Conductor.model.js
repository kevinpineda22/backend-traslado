import { supabase } from "../config/supabase.js";
import { createError } from "../middleware/errorHandler.js";

const TABLE = "traslados_conductores";

/* =============================================
   Maestro de conductores (migración 016)

   A diferencia de los vehículos, el conductor CAMBIA en cada viaje: no se sabe de
   antemano quién maneja qué camión. Por eso este maestro no tiene relación con
   `traslados_vehiculos` — el manifiesto elige uno de cada tabla por separado.

   El maestro existe igual porque escribir a mano cédula, licencia, dirección y
   teléfono en una tablet, con el camión esperando, es donde se cuelan los errores
   de tipeo. Y un manifiesto con la cédula mal no sirve para lo único que tiene que
   servir: saber quién se llevó la carga.
   ============================================= */

export async function listarActivos() {
  const { data, error } = await supabase
    .from(TABLE)
    .select("*")
    .eq("activo", true)
    .order("nombre", { ascending: true });

  if (error) throw new Error(`Error al listar conductores: ${error.message}`);
  return data || [];
}

export async function listarTodos() {
  const { data, error } = await supabase
    .from(TABLE)
    .select("*")
    .order("activo", { ascending: false })
    .order("nombre", { ascending: true });

  if (error) throw new Error(`Error al listar conductores: ${error.message}`);
  return data || [];
}

export async function obtener(id) {
  const { data, error } = await supabase.from(TABLE).select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`Error al leer el conductor: ${error.message}`);
  return data;
}

const normalizar = (c) => ({
  documento: String(c.documento || "").trim(),
  // MAYÚSCULAS igual que el resto de los datos de la app (ver convención del
  // módulo sociodemográfico): el nombre se lee en un documento impreso.
  nombre: String(c.nombre || "").trim().toUpperCase(),
  direccion: c.direccion?.trim() || null,
  telefono: c.telefono?.trim() || null,
  licencia: c.licencia?.trim() || null,
  ciudad: c.ciudad?.trim()?.toUpperCase() || null,
});

export async function crear(payload) {
  const fila = normalizar(payload);
  if (!fila.documento) throw createError(422, "El documento es obligatorio");
  if (!fila.nombre) throw createError(422, "El nombre es obligatorio");

  const { data, error } = await supabase.from(TABLE).insert(fila).select().single();

  if (error?.code === "23505") {
    throw createError(409, `Ya hay un conductor activo con el documento ${fila.documento}`);
  }
  if (error) throw new Error(`Error al crear el conductor: ${error.message}`);
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
    throw createError(409, `Ya hay un conductor activo con el documento ${fila.documento}`);
  }
  if (error || !data) throw createError(404, "Conductor no encontrado");
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

  if (error || !data) throw createError(404, "Conductor no encontrado");
  return data;
}
