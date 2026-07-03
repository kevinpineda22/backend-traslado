import { calcularSugeridoGeneral, calcularSugeridoABC } from "./sugerido.service.js";
import { leerBodegas, leerBodegasItems } from "./snapshot.service.js";
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
  { id: "007", label: "Temporada" },
  { id: "MUA", label: "U. Medida" },
  { id: "TLD", label: "Tipo Producto" },
  { id: "SP", label: "Segmento" },
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
    const rows = await leerBodegas([origen, destino]);

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
      const periodoCubrimiento = d
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
 * Deriva la clase de un ítem desde el campo `referencia` de SIESA.
 * Formato "A-0000571": la letra inicial es la clase. Sin match → "ninguno".
 */
function claseDeReferencia(referencia) {
  const letra = String(referencia ?? "").trim().charAt(0).toUpperCase();
  return ["A", "B", "C"].includes(letra) ? letra : "ninguno";
}

/**
 * Productos del flujo Llano. El Excel define el set de ítems (item, unidad,
 * capacidad); los cruzamos con SIESA (stock origen/destino, consumo) y con la
 * clase (referencia) para calcular el sugerido A/B/C.
 *
 * @param {object} opts
 * @param {string} opts.origen   - Bodega origen (00301)
 * @param {string} opts.destino  - Bodega destino (PV004)
 * @param {Array<{item, unidad, capacidad}>} opts.items - Filas del Excel
 * @param {object} [opts.cadencias] - { A, B, C } días (opcional)
 */
export async function getProductosLlano({ origen, destino, items, cadencias }) {
  try {
    const codigos = items.map((i) => String(i.item).trim()).filter(Boolean);
    const rows = await leerBodegasItems([origen, destino], codigos);

    const oMap = new Map();
    const dMap = new Map();
    for (const r of rows) {
      if (r.bodega === origen) oMap.set(String(r.codigo_item), r);
      else if (r.bodega === destino) dMap.set(String(r.codigo_item), r);
    }

    const productos = items.map((ex) => {
      const codigo = String(ex.item).trim();
      const o = oMap.get(codigo);
      const d = dMap.get(codigo);

      const clase = claseDeReferencia(o?.referencia || d?.referencia);
      const capacidad = num(ex.capacidad);
      const inventarioOrigen = o ? num(o.inventario) : 0;
      const disponibleOrigen = o ? num(o.disponible) : 0;
      const inventarioDestino = d ? num(d.inventario) : 0;
      const consumoDestino = d ? num(d.consumo_promedio) : 0;

      const bruto = calcularSugeridoABC({
        clase,
        capacidad,
        consumoDiario: consumoDestino,
        inventario: inventarioDestino,
        ...(cadencias ? { cadencias } : {}),
      });
      // No enviar más de lo disponible en el origen
      const sugerido = Math.min(bruto, Math.max(0, Math.floor(disponibleOrigen)));

      return {
        codigo_item: codigo,
        descripcion: trim(o?.descripcion || d?.descripcion || ex.descripcion || ""),
        clase,
        capacidad,
        unidad_medida: trim(ex.unidad || o?.um || ""),
        unidades: o ? buildUnidades(o) : [{ unidad: trim(ex.unidad || "UND"), factor: 1 }],
        inventario_origen: inventarioOrigen,
        disponible_origen: disponibleOrigen,
        inventario_destino: inventarioDestino,
        consumo_destino: consumoDestino,
        sugerido,
        encontrado: !!(o || d), // false = el ítem del Excel no existe en SIESA
      };
    });

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
