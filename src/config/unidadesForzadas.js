/**
 * Overrides de unidad de medida por ítem (Traslados).
 *
 * Dos casos:
 *   1. FORZADAS    → el ítem se pide ESTRICTAMENTE en una unidad (sin selector).
 *   2. SELECCIONABLES → el ítem ofrece un SET fijo de unidades para elegir.
 *
 * El código se compara SIN ceros a la izquierda, porque así viene en el snapshot
 * (v121a_id_item numérico → "0011420" queda como "11420").
 *
 * Factores: si SIESA ya trae la unidad en el ítem se usa ese factor real; si no
 * (P15/P25/P30 no vienen de SIESA), se usa el de FACTOR_UNIDAD.
 */

const norm = (c) => String(c ?? "").trim().replace(/^0+/, "") || "0";

/** UND por paquete de cada unidad. Fuente de verdad de los factores inyectados. */
export const FACTOR_UNIDAD = { UND: 1, P6: 6, P15: 15, P25: 25, P30: 30 };

/* ─── 1. Unidad FORZADA (una sola, sin selector) ───────────────────────── */
const FORZADAS_CRUDO = {
  P6: [
    "0011420", "0002280", "0003874", "0002272", "0002270", "0188417",
    "0006096", "0180026", "0011422", "0009499", "0006098", "0002982",
    "0002249", "0184747", "0009531", "0004236", "0002251", "0180819",
    "0188488", "0009632", "0002277",
  ],
  P25: ["0185325", "0001210", "0001199", "0001222", "0001231"],
};

/* ─── 2. Unidades SELECCIONABLES (set fijo, con selector) ───────────────── */
// código → lista de unidades a ofrecer (la primera es la base/por defecto).
// Los huevos (0025587/88/89) se pasaron a manejarse por filas de Capacidad
// (multi-UM P15/P30), así que ya NO usan selector. Se deja el mecanismo por si
// otro ítem lo necesita a futuro.
const SELECCIONABLES_CRUDO = {};

// codigoNormalizado → unidad forzada
const MAPA_FORZADAS = {};
for (const [unidad, codigos] of Object.entries(FORZADAS_CRUDO)) {
  for (const c of codigos) MAPA_FORZADAS[norm(c)] = unidad;
}

// codigoNormalizado → [{ unidad, factor }]
const MAPA_SELECCIONABLES = {};
for (const [codigo, unidades] of Object.entries(SELECCIONABLES_CRUDO)) {
  MAPA_SELECCIONABLES[norm(codigo)] = unidades.map((u) => ({
    unidad: u,
    factor: FACTOR_UNIDAD[u] || 1,
  }));
}

/** Unidad forzada de un ítem, o null si no aplica. */
export function unidadForzadaDe(codigo) {
  return MAPA_FORZADAS[norm(codigo)] || null;
}

/** Set fijo de unidades seleccionables de un ítem, o null si no aplica. */
export function unidadesSeleccionablesDe(codigo) {
  return MAPA_SELECCIONABLES[norm(codigo)] || null;
}
