/**
 * Cálculo de cantidad sugerida por producto.
 *
 * Lógica:
 *   Si el producto tiene consumo promedio → sugerido = consumo promedio * 1.5
 *   Si NO tiene consumo → sugerido = 10% del inventario actual
 *   El sugerido nunca puede ser mayor al inventario disponible.
 *
 * @param {number} disponible - Cantidad disponible en bodega
 * @param {number} consumoPromedio - Consumo promedio del producto
 * @returns {number} Cantidad sugerida (entero, mínimo 1)
 */
export function calcularSugerido(disponible, consumoPromedio) {
  if (!disponible || disponible <= 0) return 0;

  let sugerido;

  if (consumoPromedio && consumoPromedio > 0) {
    sugerido = Math.round(consumoPromedio * 1.5);
  } else {
    sugerido = Math.round(disponible * 0.1);
  }

  // No puede superar el disponible ni ser menor a 1
  return Math.max(1, Math.min(sugerido, disponible));
}

/**
 * Calcular sugerido para una lista de productos.
 * @param {Array} productos - [{ cantidad_disponible, consumo_promedio }]
 */
export function calcularSugeridos(productos) {
  return productos.map((p) => ({
    ...p,
    sugerido: calcularSugerido(p.cantidad_disponible, p.consumo_promedio),
  }));
}
