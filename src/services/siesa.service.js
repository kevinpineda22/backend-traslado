import { ejecutarConsulta } from "../config/connekta.js";
import { getOrSet } from "../config/cache.js";
import { calcularSugerido } from "./sugerido.service.js";

/* =============================================
   Servicio SIESA via Connekta API
   ============================================= */

const QUERY_BODEGA = process.env.CONNEKTA_QUERY_BODEGA || "merkahorro_traslados_bodega_dev";
const QUERY_SEDES = process.env.CONNEKTA_QUERY_SEDES || "merkahorro_sedes_dev";
const BODEGA_ORIGEN = "00101";

/**
 * Obtener criterios de agrupación disponibles para los filtros.
 * Los extrae directamente de los datos de Copacabana.
 */
export async function getCriterios() {
  try {
    // Traemos todos los productos de Copacabana
    const todos = await traerTodosLosProductos();

    // Estructura fija de los 9 planes
    const planes = [
      { id: "001", campoMayor: "DescMayor1", label: "Grupo" },
      { id: "002", campoMayor: "DescMayor2", label: "Subgrupo" },
      { id: "003", campoMayor: "DescMayor3", label: "Proveedor" },
      { id: "004", campoMayor: "DescMayor4", label: "Marca" },
      { id: "005", campoMayor: "DescMayor5", label: "Rotación" },
      { id: "007", campoMayor: "DescMayor7", label: "Temporada" },
      { id: "MUA", campoMayor: "DescMayorMUA", label: "U. Medida" },
      { id: "TLD", campoMayor: "DescMayorTLD", label: "Tipo Producto" },
      { id: "SP", campoMayor: "DescMayorSP", label: "Segmento" },
    ];

    // Para cada plan, extraer valores únicos desde los datos
    const criterios = planes.map((p) => {
      const valores = new Set();
      for (const item of todos) {
        const valor = item[p.campoMayor];
        if (valor && String(valor).trim()) {
          valores.add(String(valor).trim());
        }
      }

      return {
        id: p.id,
        descripcion: p.label,
        opciones: Array.from(valores).sort(),
        cantidad: valores.size,
      };
    });

    return { data: criterios };
  } catch (error) {
    return { error: error.message };
  }
}

/**
 * Consultar productos de Copacabana, filtrados por criterios.
 */
export async function getProductos(opts = {}) {
  const { criterios = [] } = opts;

  try {
    const todos = await traerTodosLosProductos();

    let resultados = todos;

    // Filtrar por criterios.
    // Semántica: AND entre tipos de criterio distintos (001 y 003),
    //            OR entre valores del mismo tipo (001:LACTEOS o 001:CARNES).
    if (criterios.length > 0) {
      // Agrupar valores por plan → { "001": ["LACTEOS", "CARNES"], "003": ["ALPINA"] }
      const valoresPorPlan = {};
      for (const criterio of criterios) {
        const idx = String(criterio).indexOf(":");
        const plan = idx === -1 ? criterio : criterio.slice(0, idx);
        const valor = idx === -1 ? null : criterio.slice(idx + 1);
        (valoresPorPlan[plan] ||= []).push(valor);
      }

      resultados = resultados.filter((item) =>
        Object.entries(valoresPorPlan).every(([plan, valores]) => {
          const campoMayor = CRITERIOS_MAP[plan];
          if (!campoMayor) return true; // plan desconocido → no restringe

          const valorProducto = String(item[campoMayor] ?? "").trim();

          return valores.some((valor) =>
            valor == null
              ? valorProducto.length > 0
              : valorProducto.toUpperCase() === String(valor).trim().toUpperCase(),
          );
        }),
      );
    }

    // Transformar al formato del frontend
    const productos = resultados.map((p) => {
      const cantidad_disponible = p.CantidadDisponible || 0;
      const consumo_promedio = p.ConsumoPromedio || 0;

      return {
        codigo_item: p.CodigoItem,
        descripcion: (p.DescItem || "").trim(),
        unidad_medida: (p.UM || "").trim(),
        cantidad_disponible,
        cantidad_inventario: p.CantidadInventario || 0,
        cantidad_comprometida: p.CantidadComprometida || 0,
        costo_promedio: p.CostoProm || 0,
        consumo_promedio,
        // Alias que espera el frontend
        stock: cantidad_disponible,
        rotacion: (p.DescMayor5 || "").trim() || "N/A",
        sugerido: calcularSugerido(cantidad_disponible, consumo_promedio),
        criterios: {
          "001": (p.DescMayor1 || "").trim(),
          "002": (p.DescMayor2 || "").trim(),
          "003": (p.DescMayor3 || "").trim(),
          "004": (p.DescMayor4 || "").trim(),
          "005": (p.DescMayor5 || "").trim(),
          "007": (p.DescMayor7 || "").trim(),
          MUA: (p.DescMayorMUA || "").trim(),
          TLD: (p.DescMayorTLD || "").trim(),
          SP: (p.DescMayorSP || "").trim(),
        },
      };
    });

    return { data: productos };
  } catch (error) {
    return { error: error.message };
  }
}

/**
 * Obtener sedes destino.
 * Usa el query general (trae todas las bodegas) o el específico de bodega.
 */
export async function getSedes() {
  try {
    const datos = await getOrSet("siesa:sedes", async () => {
      const { datos: raw } = await ejecutarConsulta(QUERY_SEDES, 1, 100);
      return raw;
    }, 30 * 60 * 1000); // TTL 30 minutos

    const bodegasMap = new Map();
    for (const item of datos) {
      if (!bodegasMap.has(item.IdBodega)) {
        bodegasMap.set(item.IdBodega, {
          id: item.IdBodega,
          descripcion: (item.DescBodega || "").trim(),
        });
      }
    }

    const sedes = Array.from(bodegasMap.values())
      .filter((s) => s.id !== BODEGA_ORIGEN && s.id !== "PV001" && !s.id.startsWith("BA") && !s.id.startsWith("ALM"))
      .sort((a, b) => a.descripcion.localeCompare(b.descripcion));

    return { data: sedes };
  } catch (error) {
    return { error: error.message };
  }
}

// ─── Helpers ──────────────────────────────────────

/**
 * Traer todos los productos de Copacabana (todas las páginas).
 */
async function traerTodosLosProductos() {
  return getOrSet("siesa:productos", async () => {
    const primera = await ejecutarConsulta(QUERY_BODEGA, 1, 200);
    let todos = [...primera.datos];

    const totalPaginas = primera.totalPaginas;
    for (let pag = 2; pag <= totalPaginas; pag++) {
      const pagina = await ejecutarConsulta(QUERY_BODEGA, pag, 200);
      todos = todos.concat(pagina.datos);
    }

    return todos;
  }, 30 * 60 * 1000); // TTL 30 minutos
}

const CRITERIOS_MAP = {
  "001": "DescMayor1",
  "002": "DescMayor2",
  "003": "DescMayor3",
  "004": "DescMayor4",
  "005": "DescMayor5",
  "007": "DescMayor7",
  MUA: "DescMayorMUA",
  TLD: "DescMayorTLD",
  SP: "DescMayorSP",
};
