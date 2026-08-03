import { supabase } from "../config/supabase.js";
import { nombreSede } from "../config/flujos.js";
import { MOTIVOS_FALTANTE, despachadoEnUnd } from "./Item.model.js";

const TABLE = "traslados_items";

/**
 * Lectura de NOVEDADES DE INVENTARIO para consumidores externos (Inventarios,
 * Compras, etc.) vía `/api/integraciones/v1/novedades`.
 *
 * ─── Por qué este modelo existe y no se reusa `Item.model` ───────────────────
 *
 * Los endpoints internos devuelven la fila de la tabla tal cual: `motivo`,
 * `cantidad_despachador`, `factor`. Si se los entrego a otra área, el shape
 * interno pasa a ser contrato público — y este esquema se mueve seguido (21
 * migraciones y contando). El día que se renombre `motivo` o se agregue una UM,
 * se le rompe la integración a un tercero y nos enteramos por un reclamo.
 *
 * Así que acá hay una TRADUCCIÓN explícita: nombres de negocio afuera
 * (`INVENTARIO_FANTASMA`), nombres de tabla adentro (`inventario_inflado`). El
 * mapa `TIPO_PUBLICO` es la frontera. Refactorizá la BD todo lo que quieras: se
 * ajusta el mapa y el contrato de afuera no se mueve.
 */

/**
 * Motivo en BD → tipo público de novedad.
 * Espejo del MOTIVO_LABEL de `notificacionesTraslado.service.js`.
 *
 * Los nombres internos quedaron con la historia del proyecto encima
 * (`inventario_inflado` es lo que Inventarios llama "Inventario Fantasma"), y la
 * integración no tiene por qué heredar esa deuda.
 */
const TIPO_PUBLICO = {
  sin_stock: { tipo: "AGOTADO", etiqueta: "Agotado" },
  surtido_parcial: { tipo: "SURTIDO_PARCIAL", etiqueta: "Surtido parcial en PV" },
  inventario_inflado: { tipo: "INVENTARIO_FANTASMA", etiqueta: "Inventario Fantasma" },
};

/** Tipo público → motivo en BD. Se deriva para que no puedan desincronizarse. */
const MOTIVO_INTERNO = Object.fromEntries(
  Object.entries(TIPO_PUBLICO).map(([motivo, { tipo }]) => [tipo, motivo]),
);

/** Catálogo de tipos, para que el consumidor no hardcodee strings. */
export function tiposNovedad() {
  return MOTIVOS_FALTANTE.map((m) => ({
    tipo: TIPO_PUBLICO[m].tipo,
    etiqueta: TIPO_PUBLICO[m].etiqueta,
  }));
}

/** Traduce una lista de tipos públicos a motivos de BD. Descarta los desconocidos. */
export function tiposAMotivos(tipos = []) {
  return tipos.map((t) => MOTIVO_INTERNO[String(t).trim().toUpperCase()]).filter(Boolean);
}

/** Límites de paginación. El tope duro protege el timeout de la función serverless. */
export const LIMITE_DEFAULT = 100;
export const LIMITE_MAX = 1000;

// Columnas del ítem que salen al exterior. Lista EXPLÍCITA, nunca `select("*")`:
// con `*`, la próxima columna que alguien agregue a la tabla —un costo, un dato
// de un proveedor, lo que sea— se publica sola a otra área sin que nadie lo decida.
const COLUMNAS = `
  id,
  codigo_item,
  descripcion,
  unidad_medida,
  factor,
  grupo,
  categoria,
  motivo,
  cantidad_admin,
  cantidad_despachador,
  cantidad_auditor,
  no_recibido,
  agregado_por_auditor,
  updated_at,
  traslados_despachos!inner (
    id,
    origen,
    destino,
    estado,
    created_at,
    recoleccion_finalizada_at
  )
`;

/**
 * Fila de BD → novedad pública.
 *
 * `cantidad_despachada_und` va aparte de `cantidad_despachada` porque un ítem son
 * VARIOS renglones (uno por unidad de medida) y cada UM tiene su factor: el número
 * crudo del despachador está en la unidad del renglón, no en UND, así que no es
 * comparable entre renglones ni contra el conteo del auditor. `despachadoEnUnd()`
 * es el mismo helper que usa el resto del backend — el consumidor recibe las dos
 * cifras y no tiene que conocer la regla del factor para cruzar contra su stock.
 */
function aPublico(row) {
  const d = row.traslados_despachos || {};
  const meta = TIPO_PUBLICO[row.motivo] || { tipo: "DESCONOCIDO", etiqueta: row.motivo };

  const solicitada = Number(row.cantidad_admin) || 0;
  const despachadaUnd = despachadoEnUnd(row);

  return {
    novedad_id: row.id,
    tipo: meta.tipo,
    tipo_etiqueta: meta.etiqueta,

    producto: {
      codigo: String(row.codigo_item),
      descripcion: (row.descripcion || "").trim(),
      grupo: row.grupo || null,
      categoria: row.categoria || null,
    },

    unidad_medida: row.unidad_medida || null,
    factor: Number(row.factor) || 1,

    cantidad_solicitada: solicitada,
    cantidad_despachada: Number(row.cantidad_despachador) || 0,
    cantidad_despachada_und: despachadaUnd,
    cantidad_auditada_und: row.cantidad_auditor == null ? null : Number(row.cantidad_auditor),
    faltante_und: Math.max(0, solicitada - despachadaUnd),

    no_recibido: row.no_recibido === true,
    agregado_por_auditor: row.agregado_por_auditor === true,

    traslado: {
      id: d.id,
      estado: d.estado,
      origen: { codigo: d.origen, nombre: nombreSede(d.origen) },
      destino: { codigo: d.destino, nombre: nombreSede(d.destino) },
      creado_at: d.created_at,
      recoleccion_finalizada_at: d.recoleccion_finalizada_at || null,
    },

    // Última modificación del renglón. Es lo más cercano a "cuándo se reportó la
    // novedad", pero NO es exactamente eso: el auditor también toca el renglón
    // después. Para filtrar por fecha usá los parámetros de fecha, que van sobre
    // la fecha del traslado y no se mueven.
    actualizada_at: row.updated_at,
  };
}

/**
 * Novedades paginadas, con filtros.
 *
 * @param {object} f
 * @param {string[]} [f.motivos]      - motivos internos; vacío = los tres
 * @param {string}   [f.destino]      - código de sede destino (ej. '00301')
 * @param {string}   [f.origen]       - código de sede origen
 * @param {string}   [f.codigo_item]  - un producto puntual
 * @param {string}   [f.estado]       - estado del traslado
 * @param {string}   [f.fecha_desde]  - ISO; sobre la fecha de creación del traslado
 * @param {string}   [f.fecha_hasta]  - ISO, inclusivo
 * @param {number}   [f.limit]
 * @param {number}   [f.offset]
 * @returns {Promise<{novedades: object[], total: number, limit: number, offset: number}>}
 */
export async function listarNovedades(f = {}) {
  const limit = Math.min(Math.max(Number(f.limit) || LIMITE_DEFAULT, 1), LIMITE_MAX);
  const offset = Math.max(Number(f.offset) || 0, 0);

  // `count: "exact"` en la misma query: el consumidor necesita el total para saber
  // cuántas páginas pedir, y un segundo round-trip para contar duplicaría el costo.
  let q = supabase.from(TABLE).select(COLUMNAS, { count: "exact" });

  const motivos = (f.motivos || []).filter((m) => MOTIVOS_FALTANTE.includes(m));
  if (motivos.length > 0) q = q.in("motivo", motivos);
  else q = q.not("motivo", "is", null);

  if (f.codigo_item) q = q.eq("codigo_item", String(f.codigo_item).trim());

  // Filtros sobre la cabecera. Funcionan porque el embed es `!inner`: con un join
  // externo, un filtro sobre la tabla embebida no descarta la fila del ítem — la
  // devuelve con la cabecera en null, que es peor que no filtrar.
  if (f.destino) q = q.eq("traslados_despachos.destino", String(f.destino).trim());
  if (f.origen) q = q.eq("traslados_despachos.origen", String(f.origen).trim());
  if (f.estado) q = q.eq("traslados_despachos.estado", String(f.estado).trim());
  if (f.fecha_desde) q = q.gte("traslados_despachos.created_at", f.fecha_desde);
  if (f.fecha_hasta) q = q.lte("traslados_despachos.created_at", f.fecha_hasta);

  // Orden estable: sin el desempate por `id`, dos renglones con el mismo
  // `created_at` pueden salir en orden distinto entre páginas y el consumidor ve
  // uno repetido y se pierde otro.
  q = q
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(offset, offset + limit - 1);

  const { data, error, count } = await q;
  if (error) throw new Error(`Error al leer novedades: ${error.message}`);

  return {
    novedades: (data || []).map(aPublico),
    total: count ?? 0,
    limit,
    offset,
  };
}
