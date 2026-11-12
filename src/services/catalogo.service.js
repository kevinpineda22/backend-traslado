import { ejecutarConsulta } from "../config/connekta.js";
import { tomarLock, liberarLock, lockTomado } from "./lock.service.js";
import { dispararRefreshRemoto } from "./snapshot.service.js";
import * as CatalogoModel from "../models/Catalogo.model.js";
import { normCodigoItem } from "../config/codigoItem.js";

/* =============================================
   Catálogo de ítems activos de SIESA en Supabase

   Mismo patrón que `snapshot.service.js` (leerlo antes de tocar esto): Connekta
   solo expone consultas dinámicas sin parámetros, así que un job trae el catálogo
   completo (~23.000 ítems, ~24 páginas de 1000) y lo persiste en
   `traslados_catalogo`. Los endpoints leen de ahí.

   Diferencias con el snapshot, a propósito:
     - Acá NO hay agregación por bodega: el catálogo es por ÍTEM.
     - El prune NO tiene período de gracia: un ítem que dejó de estar activo en
       SIESA debe dejar de ofrecerse al agregar productos. Lo protegen las mismas
       dos guardas (completitud y regresión), que se evalúan ANTES de borrar nada.
   ============================================= */

// Nombre de la consulta registrada en Connekta (sin parámetros). Ver
// docs/CONSULTA_CATALOGO_CONNEKTA.md.
const QUERY_CATALOGO = process.env.CONNEKTA_QUERY_CATALOGO || "merkahorro_catalogo_activo";
// Connekta LIMITA tamPag a 1000 (devuelve 400 si te pasás). No subir de 1000.
const TAM_PAG = Number(process.env.CONNEKTA_TAM_PAG) || 1000;
const CHUNK = 1000; // filas por upsert a Supabase

/* ─── Red de seguridad ───────────────────────────────────────────────────
   Se evalúan ANTES de borrar. Un pull parcial (red, páginas cortas, alguien que
   rompió la consulta en Connekta) no puede vaciar el catálogo bueno: sin ellas, el
   prune borraría todo lo que el pull parcial no trajo. */

// Filas crudas traídas vs total declarado por Connekta.
const UMBRAL_COMPLETITUD = Number(process.env.CATALOGO_MIN_COMPLETITUD) || 0.95;
// Ítems del pull nuevo vs filas que ya hay en la tabla.
const UMBRAL_REGRESION = Number(process.env.CATALOGO_MIN_REGRESION) || 0.8;

const trim = (v) => String(v ?? "").trim();

/** Se lanza cuando el pull no pasa una guarda: abortamos sin tocar el catálogo. */
export class CatalogoIncompletoError extends Error {
  constructor(mensaje) {
    super(mensaje);
    this.name = "CatalogoIncompletoError";
    this.statusCode = 409;
    this.expose = true;
  }
}

/** Lo lanza `refrescarCatalogoUnico` cuando otro refresco ya está corriendo. */
export class CatalogoRefreshEnCursoError extends Error {
  constructor() {
    super("Ya hay un refresh del catálogo en curso");
    this.name = "CatalogoRefreshEnCursoError";
    this.statusCode = 409;
    this.expose = true;
  }
}

/* ─── Pull desde Connekta ──────────────────────────────────────────── */

async function traerDeConnekta() {
  const primera = await ejecutarConsulta(QUERY_CATALOGO, 1, TAM_PAG);
  const total = primera.totalPaginas;

  // Las páginas se guardan EN SU POSICIÓN, no en orden de llegada. Importa porque
  // un código puede repetirse (una fila por extensión del ítem) y se conserva la
  // PRIMERA: si el orden dependiera de qué página contestó antes, el "primero"
  // cambiaría de un refresco a otro.
  const bloques = new Array(total);
  bloques[0] = primera.datos;

  const paginas = [];
  for (let p = 2; p <= total; p++) paginas.push(p);

  // Concurrencia modesta (3), por la misma razón que el snapshot: con más, el SQL
  // Server detrás de Connekta se deadlockea solo y se pega contra el rate limit.
  const CONC = Number(process.env.CONNEKTA_CONCURRENCIA) || 3;
  let cursor = 0;
  async function worker() {
    while (cursor < paginas.length) {
      const p = paginas[cursor++];
      const pagina = await ejecutarConsulta(QUERY_CATALOGO, p, TAM_PAG);
      bloques[p - 1] = pagina.datos;
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, paginas.length || 1) }, worker));

  const filas = bloques.flat();
  return { filas, crudas: filas.length, totalDeclarado: primera.total };
}

/**
 * Convierte una fila de la consulta al shape de `traslados_catalogo`.
 * El código se guarda con el normalizador único (texto, sin espacios y sin ceros a la
 * izquierda): el mismo que usan el portafolio extra y la guardia del ajuste.
 */
export function aRegistroCatalogo(r, ts) {
  const estado = r.Estado == null || r.Estado === "" ? null : Number(r.Estado);
  const rowid = r.RowidItemExt == null || r.RowidItemExt === "" ? null : Number(r.RowidItemExt);
  return {
    codigo_item: normCodigoItem(r.CodigoItem),
    rowid_item_ext: Number.isFinite(rowid) ? rowid : null,
    descripcion: trim(r.DescItem),
    referencia: trim(r.Referencia),
    um: trim(r.UM),
    um_orden: trim(r.UMOrden),
    estado: Number.isFinite(estado) ? estado : null,
    id_grupo: trim(r.IdGrupo),
    grupo: trim(r.Grupo),
    id_subgrupo: trim(r.IdSubgrupo),
    subgrupo: trim(r.Subgrupo),
    sincronizado_at: ts,
  };
}

/**
 * Un registro por código. Un ítem se repite por extensión (v121a); como el
 * catálogo es por ítem se conserva la primera fila de cada código. Las filas sin
 * código se descartan: no hay con qué identificarlas.
 */
export function dedupePorCodigo(filas, ts) {
  const porCodigo = new Map();
  for (const r of filas) {
    if (r?.CodigoItem == null || trim(r.CodigoItem) === "") continue;
    const codigo = normCodigoItem(r.CodigoItem);
    if (!porCodigo.has(codigo)) porCodigo.set(codigo, aRegistroCatalogo(r, ts));
  }
  return Array.from(porCodigo.values());
}

/* ─── Refresh ──────────────────────────────────────────────────────── */

/**
 * Trae el catálogo de Connekta y lo persiste con "upsert + prune", protegido por
 * dos guardas que se evalúan ANTES de borrar nada:
 *
 *   Guarda 1 — completitud: filas traídas >= 95% de las que Connekta declara.
 *   Guarda 2 — regresión: ítems del pull >= 80% de las filas que ya hay.
 *   Upsert:    refresca `sincronizado_at` de todo lo que vino.
 *   Prune:     borra lo que quedó con `sincronizado_at` anterior al inicio de ESTE
 *              refresco (lo que ya no está activo en SIESA).
 *
 * Si una guarda falla se lanza CatalogoIncompletoError y la tabla queda intacta.
 */
export async function refrescarCatalogo() {
  const inicio = new Date().toISOString();
  const t0 = Date.now();
  const bitacora = { filas_crudas: null, filas_declaradas: null, items: null, borradas: null };

  try {
    const { filas, crudas, totalDeclarado } = await traerDeConnekta();
    bitacora.filas_crudas = crudas;
    bitacora.filas_declaradas = totalDeclarado;

    // Guarda 1 — completitud (páginas faltantes / respuestas cortas).
    if (totalDeclarado > 0 && crudas < totalDeclarado * UMBRAL_COMPLETITUD) {
      const pct = ((crudas / totalDeclarado) * 100).toFixed(1);
      throw new CatalogoIncompletoError(
        `Pull del catálogo incompleto: ${crudas}/${totalDeclarado} filas (${pct}%). Catálogo anterior intacto.`,
      );
    }

    const registros = dedupePorCodigo(filas, inicio);
    bitacora.items = registros.length;

    // Un catálogo vacío NUNCA es un resultado válido: sería borrar todo.
    if (registros.length === 0) {
      throw new CatalogoIncompletoError("El pull del catálogo no trajo ítems. Catálogo anterior intacto.");
    }

    // Guarda 2 — regresión brusca vs lo que ya hay en la tabla.
    const previos = await CatalogoModel.contar();
    if (previos > 0 && registros.length < previos * UMBRAL_REGRESION) {
      const pct = ((registros.length / previos) * 100).toFixed(1);
      throw new CatalogoIncompletoError(
        `Regresión sospechosa del catálogo: ${registros.length} ítems vs ${previos} previos (${pct}%). Catálogo anterior intacto.`,
      );
    }

    // 1. Upsert en chunks.
    for (let i = 0; i < registros.length; i += CHUNK) {
      await CatalogoModel.upsertar(registros.slice(i, i + CHUNK));
    }

    // 2. Prune: lo que este refresco no vio. Se salta (el upsert ya quedó) si:
    //    a) Connekta no declaró total (0 o ausente) con filas traídas: la guarda de
    //       completitud no tuvo contra qué medir, no se puede afirmar que el pull es completo.
    //    b) al RELEER la tabla, lo que quedó escrito por ESTE refresco no alcanza los
    //       umbrales (upsert que no aterrizó, o un refresco paralelo que pisó el estado).
    let podaOmitida = null;
    if (!(totalDeclarado > 0)) {
      podaOmitida = `Connekta no declaró el total de filas (${totalDeclarado}) con ${crudas} filas traídas: no se puede verificar la completitud.`;
    } else {
      const escritas = await CatalogoModel.contarDesde(inicio);
      if (escritas < registros.length * UMBRAL_COMPLETITUD) {
        podaOmitida = `En la base quedaron ${escritas} de ${registros.length} filas de este refresco.`;
      } else if (previos > 0 && escritas < previos * UMBRAL_REGRESION) {
        podaOmitida = `En la base quedaron ${escritas} filas de este refresco vs ${previos} previas.`;
      }
    }

    if (podaOmitida) {
      console.warn(`[catalogo] poda omitida: ${podaOmitida}`);
      bitacora.detalle = `Poda omitida: ${podaOmitida}`;
    } else {
      bitacora.borradas = await CatalogoModel.podarAnterioresA(inicio);
    }

    await registrarRefresh({ ...bitacora, resultado: "ok", duracion_ms: Date.now() - t0 });

    return {
      total: registros.length,
      crudas,
      totalDeclarado,
      borradas: bitacora.borradas,
      ...(podaOmitida && { poda_omitida: podaOmitida }),
      sincronizado_at: inicio,
    };
  } catch (error) {
    await registrarRefresh({
      ...bitacora,
      resultado: error instanceof CatalogoIncompletoError ? "abortado" : "error",
      duracion_ms: Date.now() - t0,
      detalle: error.message,
    });
    throw error;
  }
}

/** Línea en `traslados_catalogo_log`. NUNCA rompe el refresh: avisa y sigue. */
async function registrarRefresh(fila) {
  try {
    await CatalogoModel.registrarLog(fila);
  } catch (e) {
    console.warn(`No se pudo registrar el refresh del catálogo: ${e.message}`);
  }
}

/* ─── Lock: evita dos refresh en paralelo (cron + botón manual) ───────
   Vive en Supabase (ver lock.service.js), no en memoria: en Vercel cada
   invocación puede caer en una instancia distinta. */

const LOCK_REFRESH = "catalogo:refresh";
// 15 min, igual que el timeout del workflow: el pull (~24 páginas a concurrencia 3) más el
// upsert tienen que caber COMPLETOS dentro del lock. Con un TTL corto el lock vence a mitad
// de camino y un segundo refresco arranca en paralelo y pisa el estado del primero.
const LOCK_TTL_S = 900;
const WORKFLOW_CATALOGO = process.env.GITHUB_WORKFLOW_CATALOGO || "catalogo-refresh.yml";

/** Refresca tomando el lock. Si otro ya lo tiene lanza CatalogoRefreshEnCursoError. */
export async function refrescarCatalogoUnico(detalle = "") {
  const tomado = await tomarLock(LOCK_REFRESH, LOCK_TTL_S, detalle);
  if (!tomado) throw new CatalogoRefreshEnCursoError();
  try {
    return await refrescarCatalogo();
  } finally {
    await liberarLock(LOCK_REFRESH);
  }
}

/** ¿Hay un refresh del catálogo corriendo ahora mismo (en cualquier instancia)? */
export function catalogoRefreshEnProgreso() {
  return lockTomado(LOCK_REFRESH);
}

/**
 * Dispara el workflow de GitHub Actions del catálogo (mismo token y repo que el del
 * snapshot, otro archivo de workflow). `{ disponible: false }` si no está
 * configurado: el llamador corre el pull inline como respaldo.
 */
export function dispararRefreshCatalogoRemoto() {
  return dispararRefreshRemoto(WORKFLOW_CATALOGO);
}

/* ─── Lectura (la usan los endpoints) ──────────────────────────────── */

/** Búsqueda por código exacto o texto en descripción/referencia (mín. 2 caracteres). */
export const buscar = CatalogoModel.buscar;
/** Filas del catálogo de varios códigos: Map<codigo_item, fila>. */
export const porCodigos = CatalogoModel.porCodigos;
/** { total, sincronizado_at } del catálogo. */
export const estado = CatalogoModel.estado;
