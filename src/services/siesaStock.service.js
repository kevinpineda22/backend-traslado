import axios from "axios";
import "dotenv/config";

/* =============================================
   Stock SIESA EN VIVO (por ítem)

   A diferencia del snapshot (snapshot.service.js, que trae ~76k filas por cron),
   acá consultamos SIESA en tiempo real SOLO por los ítems que pide el despachador,
   usando la consulta ESTÁNDAR PARAMETRIZADA `API_v2_Inventarios_InvFecha`
   (endpoint /api/siesa/v3/ejecutarconsultaestandar, con `parametros=f120_id=<item>`).

   Mismo patrón probado en backend-gestor-ecommerce/services/siesa/siesa.stock.js.

   Credenciales (reusa las que ya tenés; el v3 y el legacy comparten cuenta Connekta):
     CONNEKTA_BASE_URL      (ya requerido por connekta.js)
     CONNEKTA_KEY  | CONNI_KEY     (header conniKey)
     CONNEKTA_TOKEN| CONNI_TOKEN   (header conniToken)
     CONNEKTA_ID_COMPANIA   (ya requerido; fallback 7375)
   ============================================= */

const DESC_INVENTARIO = "API_v2_Inventarios_InvFecha";
const ID_COMPANIA = process.env.CONNEKTA_ID_COMPANIA || "7375";
const CONCURRENCIA = Number(process.env.SIESA_STOCK_CONCURRENCIA) || 8;

// La consulta estándar v3 vive en el HOST raíz (`/api/siesa/v3/...`), NO bajo el
// path de Connekta que trae CONNEKTA_BASE_URL (`.../api/connekta/v3`). Por eso
// tomamos solo el origin. Las credenciales son las mismas de siempre (CONNI_*).
// Overrides opcionales por si el gateway cambia: SIESA_V3_BASE_URL, SIESA_V3_PATH.
function resolverHost() {
  if (process.env.SIESA_V3_BASE_URL) return process.env.SIESA_V3_BASE_URL.replace(/\/$/, "");
  try {
    return new URL(process.env.CONNEKTA_BASE_URL || "").origin;
  } catch {
    return (process.env.CONNEKTA_BASE_URL || "").replace(/\/$/, "");
  }
}

const V3_PATH = process.env.SIESA_V3_PATH || "/api/siesa/v3/ejecutarconsultaestandar";

const siesaApi = axios.create({
  baseURL: resolverHost(),
  timeout: 45000,
  headers: {
    conniKey: process.env.CONNEKTA_KEY || process.env.CONNI_KEY,
    conniToken: process.env.CONNEKTA_TOKEN || process.env.CONNI_TOKEN,
    "Content-Type": "application/json",
  },
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Caché en memoria (TTL 60s: "en vivo" real, pero sin martillar SIESA) ──
const CACHE_TTL = Number(process.env.SIESA_STOCK_TTL_MS) || 60 * 1000;
const _cache = new Map();

function getCache(key) {
  const e = _cache.get(key);
  if (e && Date.now() - e.time < CACHE_TTL) return e.data;
  return undefined;
}
function setCache(key, data) {
  _cache.set(key, { data, time: Date.now() });
  if (_cache.size > 5000) {
    const now = Date.now();
    for (const [k, v] of _cache) if (now - v.time > CACHE_TTL) _cache.delete(k);
  }
}

async function ejecutarConsultaEstandar({ descripcion, parametros }, page = 1) {
  let intento = 0;
  const maxIntentos = 4;
  while (intento < maxIntentos) {
    try {
      const res = await siesaApi.get(V3_PATH, {
        params: {
          idCompania: ID_COMPANIA,
          descripcion,
          parametros,
          paginacion: `numPag=${page}|tamPag=100`,
        },
      });
      if (Array.isArray(res.data)) return res.data;
      if (res.data?.codigo === 0) {
        return res.data.detalle?.Datos || res.data.detalle?.Table || [];
      }
      return [];
    } catch (error) {
      if (error.code === "ECONNABORTED" || error.response?.status === 429) {
        intento++;
        if (intento >= maxIntentos) throw error;
        await wait(1500 * intento + Math.floor(Math.random() * 400));
        continue;
      }
      if (
        error.response?.status === 400 &&
        String(error.response?.data?.detalle || "").includes("No se encontraron registros")
      ) {
        return [];
      }
      throw error;
    }
  }
}

/**
 * Stock en vivo de UN ítem en UNA sede.
 * @param {object} p
 * @param {string} p.item - código de ítem SIESA (f120_id)
 * @param {string} p.sede - bodega (f150_id), ej. 'PV001' / '00301'
 * @returns {Promise<{ existencia:number, pos:number, disponible:number }>}
 */
export async function getLiveStockForItem({ item, sede }) {
  const codigo = String(item || "").trim();
  const bodega = String(sede || "").trim();
  const cacheKey = `${codigo}_${bodega}`;
  const cached = getCache(cacheKey);
  if (cached !== undefined) return cached;

  const rows = await ejecutarConsultaEstandar({
    descripcion: DESC_INVENTARIO,
    parametros: `f120_id=${codigo}`,
  });

  const filtered = (rows || []).filter(
    (r) =>
      Number(r.f120_id_cia ?? 1) === 1 &&
      String(r.f150_id).trim() === bodega,
  );

  let existencia = 0;
  let pos = 0;
  for (const r of filtered) {
    existencia += Number(r.f400_cant_existencia_1 || 0);
    pos += Number(r.f400_cant_pos_1 || 0);
  }

  const result = { existencia, pos, disponible: existencia - pos };
  setCache(cacheKey, result);
  return result;
}

/**
 * Stock en vivo de VARIOS ítems en una sede (con pool de concurrencia).
 * Un ítem que falla individualmente NO tumba el lote (devuelve disponible 0).
 * @param {object} p
 * @param {string} p.sede
 * @param {string[]} p.items - códigos de ítem
 * @returns {Promise<Record<string,{disponible:number, existencia:number}>>}
 */
export async function getStockLote({ sede, items }) {
  const unicos = [...new Set((items || []).map((i) => String(i).trim()).filter(Boolean))];
  const out = {};
  let cursor = 0;

  async function worker() {
    while (cursor < unicos.length) {
      const codigo = unicos[cursor++];
      try {
        const { disponible, existencia } = await getLiveStockForItem({ item: codigo, sede });
        out[codigo] = { disponible, existencia };
      } catch (e) {
        out[codigo] = { disponible: 0, existencia: 0, error: true };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCIA, unicos.length || 1) }, worker),
  );
  return out;
}
