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

/* ─── Reintentos ────────────────────────────────────────────────────────────
   Connekta corre sobre SQL Server y, bajo carga paralela, devuelve 500 con un
   deadlock: "Transaction (Process ID N) was deadlocked on ... resources and has
   been chosen as the deadlock victim. Rerun the transaction." El propio motor
   te dice qué hacer: reintentar. Es un fallo transitorio, no un error de datos.

   También reintentamos 429 (rate limit: 10 por ventana, ver headers
   `connekta-rate-limit-*`) y cortes de red. Un 4xx que no sea 429 es culpa
   nuestra (query mal escrita, credenciales) → no tiene sentido reintentar.
   ────────────────────────────────────────────────────────────────────────── */

const MAX_INTENTOS = Number(process.env.CONNEKTA_MAX_INTENTOS) || 4;
const BACKOFF_BASE_MS = 800;

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

const esDeadlock = (detalle) => /deadlock/i.test(String(detalle || ""));

/** ¿Vale la pena reintentar este fallo? */
function esReintentable(error) {
  const status = error?.response?.status;
  // Sin respuesta = timeout / socket cortado / DNS → transitorio.
  if (!status) return true;
  if (status === 429) return true;
  return status >= 500;
}

/**
 * Cuántos ms esperar antes del próximo intento.
 * Si Connekta nos dice cuándo se libera el rate limit (`connekta-rate-limit-reset`,
 * formato "mm:ss"), le hacemos caso. Si no, backoff exponencial con jitter — el
 * jitter importa: sin él, los N workers reintentan al unísono y se vuelven a
 * deadlockear entre ellos.
 */
function esperaAntesDeReintentar(error, intento) {
  const reset = error?.response?.headers?.["connekta-rate-limit-reset"];
  if (error?.response?.status === 429 && typeof reset === "string") {
    const [mm, ss] = reset.split(":").map(Number);
    if (Number.isFinite(mm) && Number.isFinite(ss)) {
      return Math.min((mm * 60 + ss) * 1000 + 500, 60_000);
    }
  }
  const exponencial = BACKOFF_BASE_MS * 2 ** (intento - 1);
  return Math.min(exponencial, 15_000) + Math.random() * 500;
}

/**
 * Ejecutar una consulta registrada en Connekta, reintentando fallos transitorios.
 *
 * @param {string} descripcion - Nombre del query registrado
 * @param {number} pagina - Número de página (default: 1)
 * @param {number} tamPag - Tamaño de página (default: 100)
 * @returns {Promise<{ datos: object[], total: number, pagina: number, totalPaginas: number }>}
 */
export async function ejecutarConsulta(descripcion, pagina = 1, tamPag = 100) {
  let ultimoError;

  for (let intento = 1; intento <= MAX_INTENTOS; intento++) {
    try {
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
    } catch (error) {
      ultimoError = error;
      if (!esReintentable(error) || intento === MAX_INTENTOS) break;

      const espera = esperaAntesDeReintentar(error, intento);
      const causa = esDeadlock(error?.response?.data?.detalle)
        ? "deadlock"
        : error?.response?.status || error.code || "error de red";
      console.warn(
        `[connekta] pág ${pagina} falló (${causa}) — reintento ${intento}/${MAX_INTENTOS - 1} en ${Math.round(espera)}ms`,
      );
      await dormir(espera);
    }
  }

  // Agotados los reintentos: enriquecemos el mensaje para que el log sirva.
  const detalle = ultimoError?.response?.data?.detalle;
  const status = ultimoError?.response?.status;
  throw new Error(
    `Connekta falló en pág ${pagina} tras ${MAX_INTENTOS} intentos` +
      `${status ? ` [HTTP ${status}]` : ""}: ${detalle || ultimoError?.message || "error desconocido"}`,
    { cause: ultimoError },
  );
}

/* ─── Acá NO hay un `ejecutarConsultaCompleta` (2026-09-04) ─────────────────────
   Había uno: pedía la página 1, después la 2, la 3… y devolvía todo concatenado.
   Nadie lo llamaba, y así se fue — pero conviene dejar dicho por qué no vuelve,
   porque es exactamente lo que uno escribe cuando quiere "traer todo".

   PAGINAR UNA CONSULTA SIN `ORDER BY` NO TRAE TODO. SQL Server no garantiza
   ningún orden entre dos consultas separadas, así que la página 2 puede repetir
   filas de la 1 y —lo grave— SALTEARSE otras que no aparecen en ninguna. El
   helper devolvía ese resultado con cara de completo, sin forma de saberlo.

   Ya nos costó dos veces:
     · Tránsito (113 filas, 2 páginas): las CTE 1412, 1413 y 1415 no volvieron
       nunca y el verificador reportó como abiertos tres pares que estaban
       cerrados. Peor todavía: "la entrada no existe" es la respuesta que autoriza
       a crear una SEGUNDA entrada en el ERP.
     · Snapshot (~77 páginas): el mismo ítem traía datos distintos entre pulls y,
       con el prune destructivo de entonces, el catálogo se corrompía.

   EL FIX DE RAÍZ VIVE EN CONNEKTA, NO ACÁ: la consulta registrada tiene que
   terminar en `ORDER BY <llave estable> OFFSET 0 ROWS`. El `OFFSET` es
   obligatorio — Connekta envuelve la consulta en una subconsulta y SQL Server
   prohíbe `ORDER BY` ahí sin `TOP/OFFSET`; por eso el `ORDER BY` desnudo devuelve
   un 500 de sintaxis, y de ahí salió la media verdad de que "Connekta no acepta
   ORDER BY". Sí lo acepta, con `OFFSET 0 ROWS`: es lo que arregló
   `merkahorro_traslados_dev` (docs/CONTEXTO-Y-PENDIENTES-TRASLADOS.md §4.1).

   Mientras una consulta no tenga ese ORDER BY, quien la lee tiene que elegir a
   mano y hacerse cargo de la elección:
     · `siesaTransito.consulta.js` pide UNA sola página y lanza si hay más de una.
     · `siesaAjuste.service.js` (~22k filas, no entran en una) pagina, pero cuenta
       las filas distintas contra el `total` declarado y no cachea un mapa con
       agujeros.
     · `snapshot.service.js` pagina sobre una consulta que SÍ tiene el ORDER BY, y
       aun así conserva guardas de completitud y prune con gracia.

   Un helper genérico no puede tomar ninguna de esas tres decisiones, y su peor
   efecto es esconder que hay una decisión que tomar. Por eso no está.
   ────────────────────────────────────────────────────────────────────────────── */
