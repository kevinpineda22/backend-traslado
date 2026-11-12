/**
 * Entry point del refresh del CATÁLOGO de ítems para correr FUERA de Vercel
 * (GitHub Actions). Mismo esquema que scripts/refresh-snapshot.js.
 *
 * El pull son ~24 páginas de Connekta (~23.000 ítems). Reutiliza EXACTAMENTE la
 * lógica del endpoint POST /api/catalogo/refresh (refrescarCatalogoUnico): lock
 * distribuido en Supabase y guardas de completitud/regresión antes de borrar nada.
 *
 * Ver .github/workflows/catalogo-refresh.yml y docs/CONSULTA_CATALOGO_CONNEKTA.md.
 */
import {
  refrescarCatalogoUnico,
  CatalogoRefreshEnCursoError,
  CatalogoIncompletoError,
} from "../src/services/catalogo.service.js";

const inicio = Date.now();
const seg = () => Math.round((Date.now() - inicio) / 1000);

try {
  const r = await refrescarCatalogoUnico("github-actions");
  console.log(
    `[catalogo] OK ${r.total} items (${r.crudas}/${r.totalDeclarado} filas SIESA, ${r.borradas ?? "?"} borrados) en ${seg()}s`,
  );
  process.exit(0);
} catch (error) {
  // Otro refresh ya lo estaba corriendo (el lock hizo su trabajo) → no es un fallo.
  if (error instanceof CatalogoRefreshEnCursoError) {
    console.log("[catalogo] ya hay un refresh en curso — se omite este run");
    process.exit(0);
  }
  // La red de seguridad abortó un pull incompleto para NO pisar el catálogo bueno.
  if (error instanceof CatalogoIncompletoError) {
    console.warn(`[catalogo] pull incompleto, catálogo anterior intacto: ${error.message}`);
    process.exit(0);
  }
  console.error(`[catalogo] FALLO en ${seg()}s:`, error);
  process.exit(1);
}
