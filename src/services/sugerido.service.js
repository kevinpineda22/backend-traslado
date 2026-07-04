/**
 * Cálculo de cantidad sugerida por producto.
 *
 * Dos lógicas según el flujo:
 *   - General (stock de seguridad): consumo × periodoCubrimiento − inventario
 *   - Llano (A/B/C): clasificación con capacidad tomada de un Excel
 */

const num = (v) => Number(v) || 0;

/**
 * Redondeo de negocio de Traslados: sube al entero siguiente si el decimal es
 * 0.2 o más; si es menor, baja (trunca). Ej: 22.45 → 23, 3.15 → 3, 3.2 → 4.
 */
export function redondear(x) {
  const n = num(x);
  if (n <= 0) return 0;
  const entero = Math.floor(n);
  return n - entero >= 0.2 - 1e-9 ? entero + 1 : entero;
}

/* =============================================
   FLUJO GENERAL — Stock de seguridad
   ============================================= */

/**
 * Sugerido del flujo general.
 *   stock_seguridad = consumoDestino × periodoCubrimiento
 *   sugerido        = max(0, stock_seguridad − inventarioDestino)
 *   topeado por el disponible del origen (no se envía más de lo que hay).
 *
 * @returns {{ stockSeguridad: number, sugerido: number }}
 */
export function calcularSugeridoGeneral({
  consumoDestino = 0,
  periodoCubrimiento = 0,
  inventarioDestino = 0,
  disponibleOrigen = 0,
}) {
  const stockSeguridad = num(consumoDestino) * num(periodoCubrimiento);
  const bruto = redondear(stockSeguridad - num(inventarioDestino));
  const tope = Math.max(0, Math.floor(num(disponibleOrigen)));
  return {
    stockSeguridad: Math.round(stockSeguridad * 100) / 100,
    sugerido: Math.min(bruto, tope),
  };
}

/* =============================================
   FLUJO LLANO — Clasificación A/B/C
   ============================================= */

/** Cadencias de reposición por clase (días). Ajustables. */
export const CADENCIAS_DEFAULT = { A: 1, B: 3, C: 5 };

/**
 * Sugerido del flujo Llano según la clase del producto.
 *
 *   A: si capacidad/consumo ≤ cadenciaA → objetivo = capacidad + consumo×cadenciaA
 *      si no                            → objetivo = capacidad
 *   B: si capacidad/consumo <  cadenciaB → objetivo = consumo×cadenciaB
 *      si no                            → objetivo = capacidad
 *   C / ninguno: objetivo = capacidad
 *
 *   sugerido = max(0, objetivo − inventario)
 *
 * @param {object} opts
 * @param {"A"|"B"|"C"|string} opts.clase
 * @param {number} opts.capacidad     - Capacidad de góndola (desde Excel)
 * @param {number} opts.consumoDiario - Promedio de venta diario (destino)
 * @param {number} opts.inventario    - Inventario actual (destino)
 * @param {object} [opts.cadencias]   - { A, B, C } en días
 */
export function calcularSugeridoABC({
  clase,
  capacidad = 0,
  consumoDiario = 0,
  inventario = 0,
  cadencias = CADENCIAS_DEFAULT,
}) {
  const cap = num(capacidad);
  const cons = num(consumoDiario);
  const inv = num(inventario);
  const dias = cons > 0 ? cap / cons : Infinity;
  const claseNorm = String(clase || "").trim().toUpperCase();

  let objetivo;
  if (claseNorm === "A") {
    const cad = cadencias.A ?? CADENCIAS_DEFAULT.A;
    objetivo = dias <= cad ? cap + cons * cad : cap;
  } else if (claseNorm === "B") {
    const cad = cadencias.B ?? CADENCIAS_DEFAULT.B;
    objetivo = dias < cad ? cons * cad : cap;
  } else {
    // C o "ninguno"
    objetivo = cap;
  }

  return redondear(objetivo - inv);
}
