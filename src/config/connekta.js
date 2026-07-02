import axios from "axios";
import "dotenv/config";

const BASE_URL = process.env.CONNEKTA_BASE_URL;
const ID_COMPANIA = process.env.CONNEKTA_ID_COMPANIA;
const CONNI_KEY = process.env.CONNI_KEY;
const CONNI_TOKEN = process.env.CONNI_TOKEN;

if (!BASE_URL || !ID_COMPANIA) {
  console.error("❌ Faltan CONNEKTA_BASE_URL o CONNEKTA_ID_COMPANIA en .env");
  process.exit(1);
}

if (!CONNI_KEY || !CONNI_TOKEN) {
  console.error("❌ Faltan CONNI_KEY o CONNI_TOKEN en .env");
  process.exit(1);
}

/** Headers de autenticación requeridos por Connekta */
const AUTH_HEADERS = {
  conniKey: CONNI_KEY,
  conniToken: CONNI_TOKEN,
};

/**
 * Ejecutar una consulta registrada en Connekta.
 *
 * @param {string} descripcion - Nombre del query registrado
 * @param {number} pagina - Número de página (default: 1)
 * @param {number} tamPag - Tamaño de página (default: 100)
 * @returns {Promise<{ datos: object[], total: number, pagina: number, totalPaginas: number }>}
 */
export async function ejecutarConsulta(descripcion, pagina = 1, tamPag = 100) {
  const response = await axios.get(`${BASE_URL}/ejecutarconsulta`, {
    headers: AUTH_HEADERS,
    params: {
      idCompania: ID_COMPANIA,
      descripcion,
      paginacion: `numPag=${pagina}|tamPag=${tamPag}`,
    },
    timeout: 60_000,
  });

  const body = response.data;

  if (body.codigo !== 0) {
    throw new Error(
      `Connekta error [${body.codigo}]: ${body.mensaje || ""} — ${body.detalle || ""}`,
    );
  }

  return {
    datos: body.detalle?.Datos || [],
    total: body.detalle?.total_registros || 0,
    pagina: body.detalle?.página_actual || pagina,
    totalPaginas: body.detalle?.total_páginas || 1,
  };
}

/**
 * Obtener todas las páginas de una consulta (con límite de seguridad).
 */
export async function ejecutarConsultaCompleta(
  descripcion,
  tamPag = 100,
  maxPaginas = 20,
) {
  const primera = await ejecutarConsulta(descripcion, 1, tamPag);
  let todos = [...primera.datos];

  const limite = Math.min(primera.totalPaginas, maxPaginas);
  for (let pag = 2; pag <= limite; pag++) {
    const page = await ejecutarConsulta(descripcion, pag, tamPag);
    todos = todos.concat(page.datos);
  }

  return {
    datos: todos,
    total: primera.total,
    paginasObtenidas: limite,
    totalPaginas: primera.totalPaginas,
  };
}
