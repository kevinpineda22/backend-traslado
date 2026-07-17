/**
 * tiempo.js — Fechas en la zona horaria de la operación.
 *
 * El servidor corre en UTC (Vercel siempre, y cualquier contenedor por default).
 * Colombia es UTC-5. Si formateás una fecha sin decir la zona, JavaScript usa la
 * del runtime y te devuelve la hora de Londres con cara de local: un despacho
 * cerrado a las 8:38 AM sale en el correo como "1:38 PM".
 *
 * Peor todavía con la fecha SOLA: `getDate()` sobre un cierre de las 7 PM en
 * Colombia (= 00:00 UTC del día siguiente) devuelve MAÑANA. Eso viajaba al
 * FECHA_DOCUMENTO de la requisición de SIESA, que entra contabilizada — un
 * documento fechado un día después del movimiento físico.
 *
 * Regla: NUNCA usar toLocaleString/getDate/getMonth sin zona en este proyecto.
 * Toda fecha que vea un humano o el ERP sale de acá.
 */

export const ZONA = "America/Bogota"; // UTC-5, sin horario de verano

/** "AAAAMMDD" en hora de Colombia — formato que exige el conector de SIESA. */
const FMT_COMPACTA = new Intl.DateTimeFormat("en-CA", {
  timeZone: ZONA,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * Fecha en formato AAAAMMDD, en hora de Colombia.
 * en-CA formatea como "2026-07-17"; le sacamos los guiones. Es el truco estándar
 * para obtener una fecha ISO en una zona arbitraria sin librerías.
 * @param {Date|string|number} [d]
 */
export function fechaCompacta(d = new Date()) {
  return FMT_COMPACTA.format(new Date(d)).replace(/-/g, "");
}

/** Fecha y hora legibles en hora de Colombia (ej: "17/07/2026, 08:38"). */
export function fechaHoraLegible(d = new Date()) {
  return new Date(d).toLocaleString("es-CO", {
    timeZone: ZONA,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
