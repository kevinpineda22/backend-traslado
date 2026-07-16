import { supabase } from "../config/supabase.js";

/* =============================================
   Lock distribuido sobre Supabase

   En serverless NO existe "el proceso": cada request puede caer en una
   instancia nueva, con su propia memoria. Cualquier lock en una variable de
   módulo protege contra concurrencia dentro de UNA instancia y contra nada
   más. Lo único compartido entre instancias es la base de datos, así que el
   lock vive ahí.

   Mecanismo: la PRIMARY KEY de `traslados_locks`. Dos INSERT del mismo
   `nombre` no pueden ganar los dos — Postgres decide, y esa decisión ES el
   lock. No hace falta nada más exótico.

   TTL obligatorio: si una instancia muere a mitad de la tarea (timeout de
   Vercel, OOM), nadie corre el release. Sin expiración el lock queda tomado
   para siempre y el sistema no se recupera nunca. Ver migración 006.
   ============================================= */

const TABLE = "traslados_locks";

/**
 * Intenta tomar el lock. NO espera: si otro lo tiene, devuelve false en el acto.
 * Esa es la semántica que queremos para el snapshot — si ya hay un refresh
 * corriendo, el segundo no debe encolarse a hacer el mismo trabajo caro.
 *
 * @param {string} nombre - identificador del lock (ej: "snapshot:refresh")
 * @param {number} ttlSegundos - a los cuántos segundos se considera abandonado
 * @param {string} [detalle] - texto libre para diagnóstico (quién lo tomó)
 * @returns {Promise<boolean>} true si lo tomamos nosotros
 */
export async function tomarLock(nombre, ttlSegundos, detalle = "") {
  const ahora = new Date();

  // Barrer vencidos primero. Si dos instancias barren a la vez no pasa nada:
  // el INSERT de abajo sigue siendo el único árbitro.
  await supabase.from(TABLE).delete().eq("nombre", nombre).lt("expira_at", ahora.toISOString());

  const { error } = await supabase.from(TABLE).insert({
    nombre,
    tomado_at: ahora.toISOString(),
    expira_at: new Date(ahora.getTime() + ttlSegundos * 1000).toISOString(),
    detalle,
  });

  // Conflicto de PK (23505) = otro lo tiene. Es el camino esperado, no un fallo.
  if (error) {
    if (error.code === "23505") return false;
    // Cualquier otro error (red, permisos) NO es "lock tomado". Propagamos: es
    // preferible fallar ruidoso que correr sin protección creyendo que hay lock.
    throw new Error(`Error al tomar lock "${nombre}": ${error.message}`);
  }

  return true;
}

/**
 * Libera el lock. Best-effort: si falla, el TTL lo va a limpiar igual.
 * @param {string} nombre
 */
export async function liberarLock(nombre) {
  const { error } = await supabase.from(TABLE).delete().eq("nombre", nombre);
  if (error) console.error(`[lock] no se pudo liberar "${nombre}":`, error.message);
}

/**
 * ¿Hay alguien con el lock tomado (y vigente)?
 * Solo informativo — no lo uses para decidir si correr: entre el check y la
 * acción hay una ventana de carrera. Para eso está `tomarLock`.
 * @param {string} nombre
 */
export async function lockTomado(nombre) {
  const { data, error } = await supabase
    .from(TABLE)
    .select("expira_at")
    .eq("nombre", nombre)
    .gt("expira_at", new Date().toISOString())
    .maybeSingle();

  if (error) return false;
  return data != null;
}
