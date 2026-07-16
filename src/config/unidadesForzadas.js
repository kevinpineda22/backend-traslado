/**
 * Unidades de medida FORZADAS por ítem (Traslados).
 *
 * Estos ítems se piden ESTRICTAMENTE en la unidad indicada: en la tabla y en el
 * despacho no se puede elegir otra unidad (buildUnidades devuelve solo esta).
 *
 * El código se compara SIN ceros a la izquierda, porque así viene en el snapshot
 * (v121a_id_item numérico → "0011420" queda como "11420").
 *
 * Factor: si SIESA ya trae la unidad en el ítem (ej. P6), se usa ese factor real;
 * si no la trae (ej. P25 en los arroces), se usa el de FACTOR_UNIDAD_FORZADA.
 */

const norm = (c) => String(c ?? "").trim().replace(/^0+/, "") || "0";

// Códigos tal como los pasó el negocio (con ceros); se normalizan al cargar.
const CRUDO = {
  P6: [
    "0011420", "0002280", "0003874", "0002272", "0002270", "0188417",
    "0006096", "0180026", "0011422", "0009499", "0006098", "0002982",
    "0002249", "0184747", "0009531", "0004236", "0002251", "0180819",
    "0188488", "0009632", "0002277",
  ],
  // Arroces: P25 NO existe en SIESA para estos ítems → se inyecta con factor 25.
  P25: ["0185325", "0001210", "0001199", "0001222", "0001231"],
};

/** Factor por defecto de cada unidad forzada si SIESA no lo trae en el ítem. */
export const FACTOR_UNIDAD_FORZADA = { P6: 6, P25: 25 };

// codigoNormalizado → unidad forzada
const MAPA = {};
for (const [unidad, codigos] of Object.entries(CRUDO)) {
  for (const c of codigos) MAPA[norm(c)] = unidad;
}

/** Unidad forzada de un ítem, o null si no aplica. */
export function unidadForzadaDe(codigo) {
  return MAPA[norm(codigo)] || null;
}
