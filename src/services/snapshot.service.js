import { supabase } from "../config/supabase.js";
import { ejecutarConsulta } from "../config/connekta.js";
import { bodegasInvolucradas } from "../config/flujos.js";

/* =============================================
   Snapshot de SIESA en Supabase

   Connekta solo expone consultas dinámicas (sin parámetros) y traer las ~76k
   filas tarda minutos → imposible por request en serverless. Solución: un job
   (cron de Vercel) trae el dataset, lo agrega por (bodega, item) y lo persiste
   en la tabla `traslados_snapshot`. Los endpoints leen de ahí en milisegundos.

   Mismo patrón que el módulo Domicilios con su tabla `items_siesa`.
   ============================================= */

const TABLE = "traslados_snapshot";
const QUERY_TRASLADOS =
  process.env.CONNEKTA_QUERY_TRASLADOS || "merkahorro_traslados_dev";
const TAM_PAG = Number(process.env.CONNEKTA_TAM_PAG) || 1000;
const CHUNK = 1000; // filas por insert a Supabase

const num = (v) => Number(v) || 0;
const trim = (v) => String(v ?? "").trim();

/* ─── Pull desde Connekta ──────────────────────────────────────────── */

async function traerDeConnekta() {
  const primera = await ejecutarConsulta(QUERY_TRASLADOS, 1, TAM_PAG);
  const total = primera.totalPaginas;

  // Páginas 2..total en PARALELO con límite de concurrencia. El fetch secuencial
  // de ~77 páginas tarda minutos y hace timeout en serverless; en paralelo baja
  // a decenas de segundos. Un worker pool respeta el límite para no saturar Connekta.
  const paginas = [];
  for (let p = 2; p <= total; p++) paginas.push(p);

  const CONC = Number(process.env.CONNEKTA_CONCURRENCIA) || 6;
  const bloques = [primera.datos];
  let cursor = 0;

  async function worker() {
    while (cursor < paginas.length) {
      const p = paginas[cursor++];
      const pagina = await ejecutarConsulta(QUERY_TRASLADOS, p, TAM_PAG);
      bloques.push(pagina.datos); // push es atómico entre awaits (single-thread)
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONC, paginas.length || 1) }, worker),
  );

  const todos = bloques.flat();

  // El query ya filtra por bodega (OR), pero recortamos por las dudas.
  const relevantes = new Set(bodegasInvolucradas());
  return todos.filter((r) => relevantes.has(trim(r.IdBodega)));
}

/**
 * Agrega a una fila por (bodega, item), sumando el stock de las instalaciones.
 * Un item se repite por `IdInstalacion` (y los JOINs de criterios duplican más):
 *   1. Dedup por (bodega|item|instalación) → no doblar el mismo stock.
 *   2. Sumar inventario/disponible/comprometido/consumo entre instalaciones.
 */
function agregarPorBodegaItem(rows) {
  const porInstalacion = new Map();
  for (const r of rows) {
    const key = `${trim(r.IdBodega)}|${String(r.CodigoItem)}|${trim(r.IdInstalacion)}`;
    if (!porInstalacion.has(key)) porInstalacion.set(key, r);
  }

  const agg = new Map();
  for (const r of porInstalacion.values()) {
    const key = `${trim(r.IdBodega)}|${String(r.CodigoItem)}`;
    const prev = agg.get(key);
    if (!prev) {
      agg.set(key, {
        ...r,
        _inv: num(r.CantidadInventario),
        _disp: num(r.CantidadDisponible),
        _comp: num(r.CantidadComprometida),
        _consumo: num(r.ConsumoPromedio),
        _periodo: num(r.PeriodoCubrimiento),
      });
    } else {
      prev._inv += num(r.CantidadInventario);
      prev._disp += num(r.CantidadDisponible);
      prev._comp += num(r.CantidadComprometida);
      prev._consumo += num(r.ConsumoPromedio);
      prev._periodo = Math.max(prev._periodo, num(r.PeriodoCubrimiento));
    }
  }
  return agg;
}

/** Convierte una fila agregada al shape de la tabla snapshot. */
function aRegistro(o, ts) {
  return {
    bodega: trim(o.IdBodega),
    codigo_item: String(o.CodigoItem),
    descripcion: trim(o.DescItem),
    um: trim(o.UM),
    um_orden: trim(o.UMOrden),
    factor: num(o.Factor) || 1,
    inventario: o._inv,
    disponible: o._disp,
    comprometido: o._comp,
    consumo_promedio: o._consumo,
    periodo_cubrimiento: o._periodo,
    rotacion: trim(o.DescMayor5),
    criterios: {
      "001": trim(o.DescMayor1),
      "002": trim(o.DescMayor2),
      "003": trim(o.DescMayor3),
      "004": trim(o.DescMayor4),
      "005": trim(o.DescMayor5),
      "007": trim(o.DescMayor7),
      MUA: trim(o.DescMayorMUA),
      TLD: trim(o.DescMayorTLD),
      SP: trim(o.DescMayorSP),
    },
    actualizado_at: ts,
  };
}

/* ─── Refresh (lo llama el cron) ───────────────────────────────────── */

/**
 * Trae SIESA, agrega y persiste el snapshot con patrón "upsert + prune":
 *   1. Upsert de todas las filas actuales (con actualizado_at nuevo).
 *   2. Borra las filas viejas (items que ya no existen en SIESA) sin dejar
 *      una ventana con la tabla vacía.
 */
export async function refrescarSnapshot() {
  const inicio = new Date().toISOString();

  const rows = await traerDeConnekta();
  const agg = agregarPorBodegaItem(rows);
  const registros = Array.from(agg.values()).map((o) => aRegistro(o, inicio));

  // 1. Upsert en chunks
  for (let i = 0; i < registros.length; i += CHUNK) {
    const chunk = registros.slice(i, i + CHUNK);
    const { error } = await supabase
      .from(TABLE)
      .upsert(chunk, { onConflict: "bodega,codigo_item" });
    if (error) throw new Error(`Error al guardar snapshot: ${error.message}`);
  }

  // 2. Prune de filas no refrescadas (desaparecidas de SIESA)
  const bodegas = bodegasInvolucradas();
  const { error: errPrune } = await supabase
    .from(TABLE)
    .delete()
    .in("bodega", bodegas)
    .lt("actualizado_at", inicio);
  if (errPrune) throw new Error(`Error al limpiar snapshot: ${errPrune.message}`);

  return {
    total: registros.length,
    bodegas,
    origenFilas: rows.length,
    actualizado_at: inicio,
  };
}

/* ─── Lectura (la usan los endpoints) ──────────────────────────────── */

/**
 * Devuelve TODAS las filas snapshot de las bodegas indicadas.
 * Supabase corta los SELECT en 1000 filas por defecto; como una bodega puede
 * tener miles de ítems, paginamos por rangos hasta traerlas todas.
 */
export async function leerBodegas(bodegas) {
  const PAGE = 1000;
  const todas = [];
  let desde = 0;

  for (;;) {
    const { data, error } = await supabase
      .from(TABLE)
      .select("*")
      .in("bodega", bodegas)
      .range(desde, desde + PAGE - 1);

    if (error) throw new Error(`Error al leer snapshot: ${error.message}`);
    if (!data || data.length === 0) break;

    todas.push(...data);
    if (data.length < PAGE) break;
    desde += PAGE;
  }

  return todas;
}

/** ¿Hay datos en el snapshot? (para avisar si nunca corrió el refresh) */
export async function snapshotVacio() {
  const { count, error } = await supabase
    .from(TABLE)
    .select("*", { count: "exact", head: true });
  if (error) return true;
  return (count || 0) === 0;
}
