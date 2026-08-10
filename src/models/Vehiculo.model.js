import { supabase } from "../config/supabase.js";
import { createError } from "../middleware/errorHandler.js";
import { PLACA_MAX, ERROR_PLACA_LARGA, normalizarPlaca } from "../config/placa.js";

const TABLE = "traslados_vehiculos";

/* =============================================
   Maestro de vehículos (migración 016)

   Los camiones son estables: siempre los mismos datos (placa, marca, clase, tipo,
   color, carrocería). Por eso vive en un maestro y el despachador solo elige — no
   reescribe esos datos en cada traslado.

   Los campos salen del maestro real de Merkahorro, que es flota PROPIA de camiones
   rígidos: no hay poseedor, empresa transportadora ni configuración "2S2" — eso
   pertenece al manifiesto de una transportadora tercera, no a este caso.

   NO tiene relación con `traslados_conductores`: no se sabe de antemano qué
   conductor maneja qué camión, así que el manifiesto elige uno de cada tabla por
   separado.
   ============================================= */

/** Vehículos activos, para el selector del manifiesto. */
export async function listarActivos() {
  const { data, error } = await supabase
    .from(TABLE)
    .select("*")
    .eq("activo", true)
    .order("placa", { ascending: true });

  if (error) throw new Error(`Error al listar vehículos: ${error.message}`);
  return data || [];
}

/** Todos, incluidos los dados de baja (panel de administración). */
export async function listarTodos() {
  const { data, error } = await supabase
    .from(TABLE)
    .select("*")
    .order("activo", { ascending: false })
    .order("placa", { ascending: true });

  if (error) throw new Error(`Error al listar vehículos: ${error.message}`);
  return data || [];
}

export async function obtener(id) {
  const { data, error } = await supabase.from(TABLE).select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`Error al leer el vehículo: ${error.message}`);
  return data;
}

const normalizar = (v) => ({
  // La placa se guarda en mayúsculas: el índice único es sobre `upper(placa)`, así
  // que "gtx 302" y "GTX 302" son el mismo camión y no se puede dar de alta dos veces.
  // La regla vive en config/placa.js porque el manifiesto la necesita igual.
  placa: normalizarPlaca(v.placa),
  marca: v.marca?.trim() || null,
  clase: v.clase?.trim() || null,           // Camión, Camioneta
  tipo: v.tipo?.trim()?.toUpperCase() || null, // NQR, FRR, NHR
  color: v.color?.trim()?.toUpperCase() || null,
  carroceria: v.carroceria?.trim() || null, // Estacas, Furgón
});

export async function crear(payload) {
  const fila = normalizar(payload);
  if (!fila.placa) throw createError(422, "La placa es obligatoria");
  if (fila.placa.length > PLACA_MAX) throw createError(422, ERROR_PLACA_LARGA);

  const { data, error } = await supabase.from(TABLE).insert(fila).select().single();

  // 23505 = unique_violation. El mensaje crudo de Postgres no le dice nada a quien
  // está cargando un camión desde el panel.
  if (error?.code === "23505") {
    throw createError(409, `Ya hay un vehículo activo con la placa ${fila.placa}`);
  }
  if (error) throw new Error(`Error al crear el vehículo: ${error.message}`);
  return data;
}

export async function actualizar(id, payload) {
  const fila = { ...normalizar(payload), updated_at: new Date().toISOString() };
  if (!fila.placa) throw createError(422, "La placa es obligatoria");
  if (fila.placa.length > PLACA_MAX) throw createError(422, ERROR_PLACA_LARGA);

  const { data, error } = await supabase
    .from(TABLE)
    .update(fila)
    .eq("id", id)
    .select()
    .single();

  if (error?.code === "23505") {
    throw createError(409, `Ya hay un vehículo activo con la placa ${fila.placa}`);
  }
  if (error || !data) throw createError(404, "Vehículo no encontrado");
  return data;
}

/**
 * Baja lógica. No se borra: los manifiestos viejos referencian este vehículo y
 * borrarlo rompería el historial (o dejaría el FK colgando).
 */
export async function setActivo(id, activo) {
  const { data, error } = await supabase
    .from(TABLE)
    .update({ activo: !!activo, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();

  if (error || !data) throw createError(404, "Vehículo no encontrado");
  return data;
}
