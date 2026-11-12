/**
 * Normalizador ÚNICO del código de ítem de SIESA.
 *
 * POR QUÉ HAY UNO SOLO
 * SIESA devuelve el mismo ítem con ceros a la izquierda en unos lados ("0003851": los
 * faltantes 470, los Excel de capacidad) y sin ellos en otros ("3851"). El catálogo, el
 * portafolio extra y la guardia del ajuste automático tienen que comparar SIEMPRE con la
 * misma regla: si una de las tres normaliza distinto, el cruce falla EN SILENCIO y la
 * guardia deja pasar un ajuste que crea inventario en SIESA de producción.
 *
 * Regla: recortar espacios y quitar los ceros a la izquierda; un código de solo ceros
 * queda como "0" (no como vacío). Vacío sigue siendo vacío.
 *
 * NO se usa en `snapshot.service.js` (`aRegistro` guarda `String(CodigoItem)` tal cual y
 * no se toca): contra esa tabla se consultan las dos formas, la cruda y la normalizada.
 */
export function normCodigoItem(codigo) {
  const s = String(codigo ?? "").trim();
  if (!s) return "";
  return s.replace(/^0+/, "") || "0";
}
