/**
 * Cómo se escribe una placa (Traslados · manifiesto de carga).
 *
 * POR QUÉ ESTE ARCHIVO EXISTE
 * La placa entra por tres puertas distintas: el alta del maestro de vehículos, el
 * manifiesto con vehículo elegido, y el manifiesto con vehículo escrito a mano. Si
 * cada puerta la normaliza a su manera, el índice único sobre `upper(placa)` deja
 * pasar duplicados ("GTX  302" y "GTX 302" son filas distintas) y el límite de la
 * columna se respeta solo en algunos caminos.
 *
 * Acá vive UNA definición: cómo se limpia y hasta dónde llega.
 *
 * EL LÍMITE ES EL DE LA BASE
 * `placa` es varchar(20) en `traslados_vehiculos` y `traslados_manifiestos`
 * (migración 027). Este número tiene que moverse junto con esa migración: si el
 * código permite más de lo que la columna aguanta, el exceso vuelve como un 500 de
 * Postgres en vez de un mensaje que el despachador pueda entender — que es
 * exactamente lo que rompía "Camión cargado".
 */

/** Tope de caracteres. Espejo de varchar(20) en la base (migración 027). */
export const PLACA_MAX = 20;

/** Mensaje único, para que el 422 diga lo mismo venga de donde venga. */
export const ERROR_PLACA_LARGA = `La placa no puede tener más de ${PLACA_MAX} caracteres`;

/**
 * Deja la placa como se guarda: sin espacios en los bordes, en mayúsculas y con
 * los espacios internos colapsados a uno.
 *
 * Las mayúsculas no son cosmética: el índice único del maestro es sobre
 * `upper(placa)`, así que "gtx 302" y "GTX 302" tienen que llegar iguales o el
 * mismo camión se da de alta dos veces.
 *
 * @param {unknown} valor
 * @returns {string} la placa normalizada, o "" si no había nada
 */
export function normalizarPlaca(valor) {
  return String(valor ?? "").trim().toUpperCase().replace(/\s+/g, " ");
}
