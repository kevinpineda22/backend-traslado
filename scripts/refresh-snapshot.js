/**
 * Entry point del refresh del snapshot para correr FUERA de Vercel (GitHub Actions).
 *
 * El pull de SIESA tarda ~4.5 min y en Vercel muere por el límite de 300s
 * (FUNCTION_INVOCATION_TIMEOUT) → el snapshot quedaba viejo de forma intermitente.
 * Acá, en un runner sin ese límite, corre tranquilo.
 *
 * Reutiliza EXACTAMENTE la misma lógica que el endpoint /api/siesa/refresh
 * (refrescarSnapshotUnico): lock distribuido en Supabase, guardas de completitud
 * y prune con período de gracia incluidos. Las credenciales llegan por variables
 * de entorno (GitHub Secrets), igual que en Vercel.
 *
 * Ver .github/workflows/snapshot-refresh.yml.
 */
import {
  refrescarSnapshotUnico,
  RefreshEnCursoError,
  PullIncompletoError,
} from "../src/services/snapshot.service.js";

const inicio = Date.now();
const seg = () => Math.round((Date.now() - inicio) / 1000);

try {
  const r = await refrescarSnapshotUnico("github-actions");
  console.log(
    `[snapshot] ✅ ${r.total} items (${r.crudas}/${r.totalDeclarado} filas SIESA) en ${seg()}s`,
  );
  process.exit(0);
} catch (error) {
  // Otro refresh ya lo estaba corriendo (el lock hizo su trabajo) → no es un fallo.
  if (error instanceof RefreshEnCursoError) {
    console.log("[snapshot] ya hay un refresh en curso — se omite este run");
    process.exit(0);
  }
  // La red de seguridad abortó un pull incompleto para NO pisar el dato bueno.
  if (error instanceof PullIncompletoError) {
    console.warn(`[snapshot] ⚠️ pull incompleto, snapshot anterior intacto: ${error.message}`);
    process.exit(0);
  }
  console.error(`[snapshot] ❌ falló en ${seg()}s:`, error);
  process.exit(1);
}
