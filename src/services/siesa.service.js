import { calcularSugeridoGeneral, calcularSugeridoABC } from "./sugerido.service.js";
import { leerBodegas } from "./snapshot.service.js";
import { mapaCapacidades } from "../models/Capacidad.model.js";
import { obtener as obtenerConfig } from "../models/Config.model.js";
import { SEDES, nombreSede, getFlujoPorDestino } from "../config/flujos.js";

/* =============================================
   Servicio SIESA (lectura)

   Lee del snapshot en Supabase (poblado por el cron → snapshot.service.js) y
   pivotea por par origen/destino. Nunca toca Connekta en un request de usuario.
   ============================================= */

const num = (v) => Number(v) || 0;
const trim = (v) => String(v ?? "").trim();

const PLANES = [
  { id: "001", label: "Grupo" },
  { id: "002", label: "Subgrupo" },
  { id: "003", label: "Proveedor" },
  { id: "004", label: "Marca" },
  { id: "005", label: "Rotación" },
  { id: "007", label: "Negociaciones Puntuales" }, // antes: Temporada
  { id: "MUA", label: "U. Medida" },
  { id: "TLD", label: "Traslados" }, // antes: Tipo Producto
  { id: "SP", label: "Separata" }, // antes: Segmento
  { id: "TIP", label: "Tipo" }, // DescMayorTIP (ej: "ABARROTES")
];

/* ─── Criterios (para los filtros facetados) ───────────────────────── */

/**
 * Extrae los criterios disponibles desde el catálogo del origen.
 * @param {string} origen - Bodega origen (default: origen del flujo general)
 */
export async function getCriterios(origen = "PV001") {
  try {
    const rows = await leerBodegas([origen]);

    const criterios = PLANES.map((p) => {
      const valores = new Set();
      for (const r of rows) {
        const v = trim(r.criterios?.[p.id]);
        if (v) valores.add(v);
      }
      return {
        id: p.id,
        descripcion: p.label,
        opciones: Array.from(valores).sort((a, b) => a.localeCompare(b, "es")),
        cantidad: valores.size,
      };
    });

    return { data: criterios };
  } catch (error) {
    return { error: error.message };
  }
}

/* ─── Productos pivoteados origen/destino ──────────────────────────── */

/**
 * Productos del ORIGEN cruzados con el DESTINO + sugerido (stock de seguridad).
 * @param {object} opts
 * @param {string} opts.origen  - Bodega origen
 * @param {string} opts.destino - Bodega destino
 */
export async function getProductosTraslado({ origen, destino }) {
  try {
    const [rows, config] = await Promise.all([
      leerBodegas([origen, destino]),
      obtenerConfig(),
    ]);
    // Override global del período de cubrimiento (si se configuró en el admin);
    // si es null, se usa el PeriodoCubrimiento que trae cada ítem de SIESA.
    const periodoOverride = config.general.periodoCubrimiento;

    const oMap = new Map();
    const dMap = new Map();
    for (const r of rows) {
      if (r.bodega === origen) oMap.set(String(r.codigo_item), r);
      else if (r.bodega === destino) dMap.set(String(r.codigo_item), r);
    }

    const productos = [];
    for (const o of oMap.values()) {
      const codigo = String(o.codigo_item);
      const d = dMap.get(codigo);

      const inventarioOrigen = num(o.inventario);
      const disponibleOrigen = num(o.disponible);
      const inventarioDestino = d ? num(d.inventario) : 0;
      const consumoDestino = d ? num(d.consumo_promedio) : 0;
      const periodoCubrimiento =
        periodoOverride != null
          ? periodoOverride
          : d
            ? num(d.periodo_cubrimiento)
            : num(o.periodo_cubrimiento);

      const { stockSeguridad, sugerido } = calcularSugeridoGeneral({
        consumoDestino,
        periodoCubrimiento,
        inventarioDestino,
        disponibleOrigen,
      });

      productos.push({
        codigo_item: codigo,
        descripcion: trim(o.descripcion),
        rotacion: trim(o.rotacion) || "N/A",
        unidad_medida: trim(o.um),
        unidades: buildUnidades(o),
        criterios: o.criterios || {},
        inventario_origen: inventarioOrigen,
        disponible_origen: disponibleOrigen,
        inventario_destino: inventarioDestino,
        consumo_destino: consumoDestino,
        periodo_cubrimiento: periodoCubrimiento,
        stock_seguridad: stockSeguridad,
        sugerido,
      });
    }

    return { data: productos };
  } catch (error) {
    return { error: error.message };
  }
}

/* ─── Flujo Llano — clasificación A/B/C con Excel ──────────────────── */

/**
 * Deriva la clase A/B/C del ítem desde el criterio CAT ("CLASIFICACIÓN ABC LLANO").
 * DescMayorCAT tiene la forma "CATEGORIA TIPO A" → clase "A". Sin match → "ninguno".
 */
function claseDeCategoria(cat) {
  const m = String(cat ?? "").toUpperCase().match(/TIPO\s+([ABC])/);
  return m ? m[1] : "ninguno";
}

/**
 * Productos del flujo Llano — facetado (todos los ítems del origen, como
 * General) con sugerido A/B/C. La clase sale del criterio CAT del DESTINO
 * (Girardota Llano, 00401) y la capacidad de la tabla `traslados_capacidad`.
 * Ítems sin capacidad cargada → capacidad 0 → sugerido 0.
 *
 * Las cadencias A/B/C salen de la config editable (tabla traslados_config);
 * el parámetro `cadencias` las pisa si se pasa explícito.
 *
 * @param {object} opts
 * @param {string} opts.origen   - Bodega origen (00301)
 * @param {string} opts.destino  - Bodega destino (00401)
 * @param {object} [opts.cadencias] - { A, B, C } días (override opcional)
 */
export async function getProductosLlano({ origen, destino, cadencias }) {
  try {
    const [rows, capacidades, config] = await Promise.all([
      leerBodegas([origen, destino]),
      mapaCapacidades(),
      obtenerConfig(),
    ]);
    const cadenciasEfectivas = cadencias || config.llano;

    const oMap = new Map();
    const dMap = new Map();
    for (const r of rows) {
      if (r.bodega === origen) oMap.set(String(r.codigo_item), r);
      else if (r.bodega === destino) dMap.set(String(r.codigo_item), r);
    }

    const productos = [];
    for (const o of oMap.values()) {
      const codigo = String(o.codigo_item);
      const d = dMap.get(codigo);

      // La clase A/B/C debe ser la de Girardota Llano (destino, 00401), no la
      // del origen (Girardota Parque). Por eso se lee el CAT del registro `d`.
      const clase = claseDeCategoria(d?.criterios?.CAT);
      const capacidad = capacidades.get(codigo) || 0;
      const inventarioOrigen = num(o.inventario);
      const disponibleOrigen = num(o.disponible);
      const inventarioDestino = d ? num(d.inventario) : 0;
      const consumoDestino = d ? num(d.consumo_promedio) : 0;

      const bruto = calcularSugeridoABC({
        clase,
        capacidad,
        consumoDiario: consumoDestino,
        inventario: inventarioDestino,
        cadencias: cadenciasEfectivas,
      });
      const sugerido = Math.min(bruto, Math.max(0, Math.floor(disponibleOrigen)));

      productos.push({
        codigo_item: codigo,
        descripcion: trim(o.descripcion),
        clase,
        capacidad,
        rotacion: trim(o.rotacion) || "N/A",
        unidad_medida: trim(o.um),
        unidades: buildUnidades(o),
        criterios: o.criterios || {},
        inventario_origen: inventarioOrigen,
        disponible_origen: disponibleOrigen,
        inventario_destino: inventarioDestino,
        consumo_destino: consumoDestino,
        sugerido,
      });
    }

    return { data: productos };
  } catch (error) {
    return { error: error.message };
  }
}

/**
 * Unidades disponibles para el switch de UM.
 * Con los datos actuales de SIESA hay una unidad base + la de orden (si difiere).
 */
function buildUnidades(row) {
  const base = trim(row.um);
  const orden = trim(row.um_orden);
  const factor = num(row.factor) || 1;

  const unidades = [{ unidad: base, factor: 1 }];
  if (orden && orden !== base && factor !== 1) {
    unidades.push({ unidad: orden, factor });
  }
  return unidades;
}

/* ─── Sedes y flujos ───────────────────────────────────────────────── */

/** Sedes destino disponibles (todas las de los flujos), desde config. */
export async function getSedes() {
  const sedes = Object.keys(SEDES)
    .map((codigo) => ({ id: codigo, descripcion: nombreSede(codigo) }))
    .sort((a, b) => a.descripcion.localeCompare(b.descripcion, "es"));
  return { data: sedes };
}

export { getFlujoPorDestino };
