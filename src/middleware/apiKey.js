import crypto from "node:crypto";
import { createError } from "./errorHandler.js";

/**
 * Autenticación por API key para la superficie de INTEGRACIONES (`/api/integraciones`).
 *
 * Este backend no tiene auth todavía: los endpoints internos los consume el front
 * de Merkahorro y viven detrás de la sesión de la app. Pero una integración con
 * otra área es distinta — la URL se la queda un tercero, se pega en un Postman,
 * en un script de Excel, en un n8n — y una URL sin llave es una URL pública.
 *
 * Por eso las rutas de integración NO comparten middleware con el resto: tienen
 * llave propia, por consumidor, revocable de a uno. Si mañana hay que cortarle el
 * acceso a un área, se borra su entrada de la variable de entorno y se redeploya.
 * Sin tocar código, sin afectar a los demás consumidores.
 *
 * Configuración (variable de entorno `INTEGRACIONES_API_KEYS`):
 *
 *   Formato JSON (recomendado — permite nombres con caracteres raros):
 *     INTEGRACIONES_API_KEYS={"inventarios":"a1b2...","compras":"c3d4..."}
 *
 *   Formato corto (equivalente, más cómodo de pegar en Vercel):
 *     INTEGRACIONES_API_KEYS=inventarios:a1b2...,compras:c3d4...
 *
 * Generar una llave:  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */

const HEADER = "x-api-key";

/**
 * Parsea `INTEGRACIONES_API_KEYS` a un mapa { llave → nombre_consumidor }.
 *
 * El mapa va invertido (llave como índice) a propósito: la búsqueda es por la
 * llave que llega en el header, y así es un lookup directo en vez de recorrer
 * consumidores. El nombre sale del valor y sirve para el log de auditoría.
 *
 * No se cachea en módulo: en serverless el proceso se reusa entre invocaciones y
 * un cache dejaría vivas llaves ya revocadas hasta que Vercel recicle el lambda.
 * Parsear un objeto de 5 entradas por request no se mide.
 *
 * Devuelve `{ llaves, problema }`. El `problema` distingue POR QUÉ no hay llaves,
 * y esa distinción es la mitad del valor de esta función: la primera versión
 * devolvía un mapa vacío en los tres casos —variable ausente, JSON roto, formato
 * sin `nombre:clave`— y el 503 decía "falta INTEGRACIONES_API_KEYS" incluso
 * cuando la variable estaba puesta. Mandaba a revisar el lugar equivocado.
 *
 * @returns {{llaves: Record<string,string>, problema: string|null}}
 */
function leerLlaves() {
  const raw = String(process.env.INTEGRACIONES_API_KEYS || "").trim();
  if (!raw) {
    return { llaves: {}, problema: "Falta la variable de entorno INTEGRACIONES_API_KEYS." };
  }

  const porLlave = {};

  if (raw.startsWith("{")) {
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch {
      return {
        llaves: {},
        problema: "INTEGRACIONES_API_KEYS empieza con '{' pero no es JSON válido.",
      };
    }
    for (const [nombre, llave] of Object.entries(obj)) {
      const l = String(llave || "").trim();
      if (l) porLlave[l] = String(nombre).trim();
    }
    return Object.keys(porLlave).length > 0
      ? { llaves: porLlave, problema: null }
      : { llaves: {}, problema: "INTEGRACIONES_API_KEYS es un JSON sin ninguna clave." };
  }

  // Formato corto. Se cuentan los pares descartados para poder decir QUÉ estaba
  // mal: pegar solo la clave, sin el `nombre:` adelante, es el error natural de
  // quien acaba de generarla — y sin este contador el diagnóstico era
  // indistinguible de "no configuraste nada".
  let descartados = 0;
  for (const par of raw.split(",")) {
    if (!par.trim()) continue;
    const i = par.indexOf(":");
    const nombre = i > 0 ? par.slice(0, i).trim() : "";
    const llave = i > 0 ? par.slice(i + 1).trim() : "";
    if (nombre && llave) porLlave[llave] = nombre;
    else descartados++;
  }

  if (Object.keys(porLlave).length > 0) return { llaves: porLlave, problema: null };

  return {
    llaves: {},
    problema:
      `INTEGRACIONES_API_KEYS está definida pero no tiene ninguna entrada válida ` +
      `(${descartados} descartada(s)). El formato es "nombre:clave", ` +
      `por ejemplo INTEGRACIONES_API_KEYS=inventarios:<clave>. ` +
      `Si pegaste solo la clave, falta el nombre del consumidor adelante.`,
  };
}

/**
 * Comparación en tiempo constante.
 *
 * `a === b` sobre un string corta en el primer carácter distinto, y esa diferencia
 * de tiempo —medible sobre miles de requests— permite adivinar la llave carácter
 * por carácter. Se comparan los SHA-256 y no las llaves crudas porque
 * `timingSafeEqual` exige buffers del mismo largo: hashear normaliza el largo sin
 * filtrar cuántos caracteres tenía la llave correcta.
 */
function igualSeguro(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Middleware. Exige header `X-API-Key` válido; adjunta `req.consumidor`.
 *
 * Si `INTEGRACIONES_API_KEYS` no está configurada responde 503 y NO deja pasar.
 * Fallar cerrado es el punto: la alternativa cómoda —"si no hay llaves
 * configuradas, dejá pasar todo"— convierte un deploy con una variable de entorno
 * olvidada en una API pública, y eso no se nota nunca, porque todo "funciona".
 */
export function requireApiKey(req, _res, next) {
  const { llaves, problema } = leerLlaves();

  if (problema) {
    // El detalle del problema va al LOG del servidor, no a la respuesta: el 503
    // lo lee un consumidor externo, y contarle cómo está configurada tu variable
    // de entorno es regalarle información que no necesita para su integración.
    console.error(`🔴 Integraciones mal configuradas → ${problema}`);
    return next(createError(503, "Integraciones no configuradas en este entorno."));
  }

  const recibida = String(req.headers[HEADER] || "").trim();
  if (!recibida) {
    return next(createError(401, "Falta el header X-API-Key."));
  }

  for (const [llave, nombre] of Object.entries(llaves)) {
    if (igualSeguro(recibida, llave)) {
      req.consumidor = nombre;
      console.log(`🔑 integración "${nombre}" → ${req.method} ${req.originalUrl}`);
      return next();
    }
  }

  // No se dice si la llave existe pero está mal, ni de quién es: un 401 que
  // distingue casos le enseña al que prueba dónde seguir probando.
  return next(createError(401, "API key inválida."));
}
