import { supabase } from "../config/supabase.js";
import { ejecutarConsulta } from "../config/connekta.js";
import { bodegasInvolucradas } from "../config/flujos.js";
import { tomarLock, liberarLock, lockTomado } from "./lock.service.js";

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

  // Concurrencia 3, NO 10. Con 10 empatábamos el rate limit de Connekta
  // (`connekta-rate-limit-limit: 10`) y, peor, el SQL Server detrás se
  // deadlockeaba solo por paralelismo sobre la misma consulta pesada. Más
  // paralelismo no era más rápido: era el refresh entero fallando.
  // `ejecutarConsulta` ya reintenta los transitorios (ver config/connekta.js).
  const CONC = Number(process.env.CONNEKTA_CONCURRENCIA) || 3;
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
    referencia: trim(o.Referencia),
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
      // Plan "CAT" = "CLASIFICACIÓN ABC LLANO". DescMayorCAT = "CATEGORIA TIPO A/B/C".
      // De acá sale la clase A/B/C del flujo Llano (ya NO del campo Referencia).
      CAT: trim(o.DescMayorCAT),
      // Plan "TIP" = "TIPO" (ej: "ABARROTES"). Facet filter de criterios.
      TIP: trim(o.DescMayorTIP),
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

/* ─── Lock: evita dos refresh en paralelo (cron + botón manual) ──────
   El lock vive en Supabase, NO en memoria: en Vercel cada invocación puede caer
   en una instancia distinta, así que una variable de módulo no protege nada
   entre el cron y el botón manual. Dos pulls simultáneos contra Connekta es
   justo lo que dispara los deadlocks de SQL Server.

   TTL = maxDuration de la función (300s, ver vercel.json). Si la instancia
   muere a mitad, el lock se libera solo antes del próximo cron (15 min).
   ────────────────────────────────────────────────────────────────── */

const LOCK_REFRESH = "snapshot:refresh";
const LOCK_TTL_S = 300;

/** Lo devuelve `refrescarSnapshotUnico` cuando otro refresh ya está corriendo. */
export class RefreshEnCursoError extends Error {
  constructor() {
    super("Ya hay un refresh del snapshot en curso");
    this.name = "RefreshEnCursoError";
    this.statusCode = 409;
    this.expose = true;
  }
}

/**
 * Refresca tomando el lock distribuido. Si otro ya lo tiene, NO encola otro pull
 * caro: lanza RefreshEnCursoError (409) y el que llamó decide qué hacer.
 */
export async function refrescarSnapshotUnico(detalle = "") {
  const tomado = await tomarLock(LOCK_REFRESH, LOCK_TTL_S, detalle);
  if (!tomado) throw new RefreshEnCursoError();

  try {
    return await refrescarSnapshot();
  } finally {
    await liberarLock(LOCK_REFRESH);
  }
}

/** ¿Hay un refresh corriendo ahora mismo (en cualquier instancia)? */
export function refreshEnProgreso() {
  return lockTomado(LOCK_REFRESH);
}

/** Timestamp del último refresh (max actualizado_at del snapshot). */
export async function ultimaActualizacion() {
  const { data, error } = await supabase
    .from(TABLE)
    .select("actualizado_at")
    .order("actualizado_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return null;
  return data?.actualizado_at || null;
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

/**
 * Lee del snapshot solo los ítems indicados en las bodegas dadas (flujo Llano:
 * el Excel trae unos cientos de ítems, no queremos leer el catálogo entero).
 * Trocea los códigos para no exceder límites de URL de Supabase.
 */
export async function leerBodegasItems(bodegas, codigos) {
  const LOTE = 300;
  const unicos = [...new Set(codigos.map((c) => String(c).trim()).filter(Boolean))];
  const todas = [];

  for (let i = 0; i < unicos.length; i += LOTE) {
    const lote = unicos.slice(i, i + LOTE);
    const { data, error } = await supabase
      .from(TABLE)
      .select("*")
      .in("bodega", bodegas)
      .in("codigo_item", lote);

    if (error) throw new Error(`Error al leer snapshot (items): ${error.message}`);
    if (data?.length) todas.push(...data);
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
