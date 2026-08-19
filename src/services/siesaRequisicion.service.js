import axios from "axios";
import "dotenv/config";
import { centroOperacionDeSede } from "../config/flujos.js";
import { fechaCompacta } from "../config/tiempo.js";
import { sandboxOn } from "../config/sandbox.js";

/* =============================================
   Importar transferencia EN TRÁNSITO a SIESA (/conectoresimportar, conector
   252844 TRANSFERENCIA_TRANSITO_DEV_REQUISICIONES → registro tipo 450).

   Este módulo ESCRIBE EN EL ERP. Todo lo demás del backend lee; esto no. Si se
   dispara dos veces quedan documentos duplicados, o sea movimientos de
   inventario que nunca ocurrieron. La idempotencia no la resuelve este archivo:
   la resuelven `siesa_estado` y `siesa_salida_docto` en la BD (migraciones 007 y
   029, requisicion.service). Acá solo armamos los payloads y hacemos los POST.

   ── POR QUÉ SON DOS DOCUMENTOS ──
   SIESA dejó de aceptar la transferencia DIRECTA (clase 67, un documento con
   origen y destino, que movía inventario de una). Ahora el modelo es EN TRÁNSITO:

     1. SALIDA  (clase 65, tipo CTS): saca de la bodega origen → tránsito.
        SIESA le asigna un consecutivo (F_CONSEC_AUTO_REG = 1).
     2. ENTRADA (clase 66, tipo CTE): mete de tránsito → bodega destino, y
        REFERENCIA a la salida por su consecutivo (CO_BASE + TIPO_DOCTO=CTS +
        CONSECUTIVO = nro de la salida). Sin ese número la entrada no existe.

   El orden es OBLIGADO: salida → leo el NroDocto → entrada con ese consecutivo.
   No se pueden mandar en paralelo ni al revés. Por eso este módulo expone las
   dos importaciones por separado (`importarSalida` / `importarEntrada`) y el
   orquestador (requisicion.service) las encadena persistiendo el docto de la
   salida en el medio — así, si la entrada falla, el reintento manda SOLO la
   entrada sin duplicar la salida.

   ── Lo que el conector ya trae horneado (spec del registro 450) ──
   El JSON solo lleva los campos VARIABLES; los fijos viven en la definición del
   conector y NO viajan:

     f350_ind_estado    = 1   → Aprobado/Contabilizado (mueve inventario al instante)
     F_CIA              = 001
     F_CONSEC_AUTO_REG  = 1   → el consecutivo lo asigna SIESA

   OJO: `ind_estado = 1` significa que los documentos NO entran como borrador.
   Entran aprobados y contabilizados: mueven inventario apenas SIESA los acepta.
   No hay instancia intermedia donde alguien revise. Por eso todo este flujo está
   armado alrededor de no enviar dos veces y de no enviar basura.

   Configuración (.env):
     SIESA_IMPORTAR_URL        base del conector
     SIESA_IMPORTAR_ID_SISTEMA idSistema (default 1)
     SIESA_IMPORTAR_ID_DOCUMENTO      default 252844
     SIESA_IMPORTAR_NOMBRE_DOCUMENTO  default TRANSFERENCIA_TRANSITO_DEV_REQUISICIONES
     SIESA_IMPORTAR_CO         centro de operación, 3 chars (ver resolverCO)
     SIESA_IMPORTAR_CO_POR_SEDE  JSON {"PV001":"001", ...} si varía por sede
     CONNEKTA_ID_COMPANIA / CONNI_KEY / CONNI_TOKEN  (ya existen)
   ============================================= */

/* La config se lee PEREZOSA, no en constantes de módulo. Capturar process.env al
   importar significa que quien cargue una variable después del import se come un
   fallo mudo, y deja `configFaltante()` imposible de reevaluar. Un getter no
   cuesta nada y no miente. */
const cfg = {
  url: () =>
    process.env.SIESA_IMPORTAR_URL ||
    "https://servicios.siesacloud.com/api/siesa/v3.1/conectoresimportar",
  idCompania: () => process.env.CONNEKTA_ID_COMPANIA || "7375",
  idSistema: () => process.env.SIESA_IMPORTAR_ID_SISTEMA || "1",
  idDocumento: () => process.env.SIESA_IMPORTAR_ID_DOCUMENTO || "252844",
  nombreDocumento: () =>
    process.env.SIESA_IMPORTAR_NOMBRE_DOCUMENTO || "TRANSFERENCIA_TRANSITO_DEV_REQUISICIONES",
  key: () => process.env.CONNEKTA_KEY || process.env.CONNI_KEY || "",
  token: () => process.env.CONNEKTA_TOKEN || process.env.CONNI_TOKEN || "",
};

/* ── Constantes del contrato de tránsito ─────────────────────────────────────
   Valores confirmados por inventario (2026-08-18). No son configurables: son EL
   contrato del documento de tránsito. Si SIESA cambia el modelo otra vez, se
   tocan acá, en un solo lugar con nombre. */
const CLASE_SALIDA = "65"; // Transferencia salida en tránsito
const CLASE_ENTRADA = "66"; // Transferencia entrada en tránsito
const TIPO_SALIDA = "CTS"; // tipo de documento de la salida
const TIPO_ENTRADA = "CTE"; // tipo de documento de la entrada
const MOTIVO_ENTRADA = "01"; // entrada: 01 para todos los casos
const MOTIVO_SALIDA_PARQUE_LLANO = "50"; // salida del Parque (00301) al Llano (00401)
const MOTIVO_SALIDA_GENERAL = "02"; // salida: el resto de los casos
const BODEGA_PARQUE = "00301"; // Girardota Parque (origen del flujo Llano)
const BODEGA_LLANO = "00401"; // Girardota Llano (destino del flujo Llano)

/** Longitud exacta de f350_id_co según el spec del registro 450. */
const CO_LARGO = 3;

const num = (v) => Number(v) || 0;
const trim = (v) => String(v ?? "").trim();

/**
 * Centro de operación (`f350_id_co`) de una sede. 3 chars, valida en maestro.
 *
 * La tabla vive en config/flujos.js, al lado de SEDES (ver CENTROS_OPERACION).
 * Acá solo resolvemos con precedencia, de más específico a más general:
 *   1. `SIESA_IMPORTAR_CO_POR_SEDE` = {"PV001":"P01"} — override por sede.
 *   2. La tabla del código.
 *   3. `SIESA_IMPORTAR_CO` — valor único, escotilla de emergencia.
 *
 * Sirve tanto para el origen (C.O. de la salida) como para el destino (C.O. de
 * la entrada): en el modelo de tránsito los dos centros de operación viajan.
 *
 * @param {string} sede - bodega (origen o destino del despacho)
 * @returns {string} el C.O., o "" si no se pudo resolver
 */
export function resolverCO(sede) {
  const crudo = process.env.SIESA_IMPORTAR_CO_POR_SEDE;
  if (crudo) {
    try {
      const mapa = JSON.parse(crudo);
      const co = mapa?.[String(sede || "").trim()];
      if (co) return String(co).trim();
    } catch {
      console.error("[siesa] SIESA_IMPORTAR_CO_POR_SEDE no es JSON válido — se ignora");
    }
  }

  const deTabla = centroOperacionDeSede(sede);
  if (deTabla) return deTabla;

  return String(process.env.SIESA_IMPORTAR_CO || "").trim();
}

/**
 * Motivo del movimiento de SALIDA. Regla de negocio (2026-08-18):
 *   - 50 si la mercancía sale del Parque (00301) al Llano (00401).
 *   - 02 en todos los demás casos.
 * La entrada siempre lleva 01 (ver MOTIVO_ENTRADA).
 */
function motivoSalida(despacho) {
  const origen = trim(despacho?.origen);
  const destino = trim(despacho?.destino);
  return origen === BODEGA_PARQUE && destino === BODEGA_LLANO
    ? MOTIVO_SALIDA_PARQUE_LLANO
    : MOTIVO_SALIDA_GENERAL;
}

/**
 * Falta configuración obligatoria. Lo tratamos aparte de un fallo de red: no se
 * reintenta (reintentar no arregla una variable que no existe) y el mensaje dice
 * exactamente qué cargar.
 */
export class ConfigSiesaError extends Error {
  constructor(faltantes) {
    super(
      `No se puede importar a SIESA: falta configurar ${faltantes.join(", ")}. ` +
        "Cargalas en el entorno (Vercel → Settings → Environment Variables).",
    );
    this.name = "ConfigSiesaError";
    this.configIncompleta = true;
  }
}

/** Valida el C.O. de UNA sede y agrega a `faltan` lo que corresponda. */
function validarCO(faltan, sede, etiqueta) {
  const co = resolverCO(sede);
  if (!co) {
    faltan.push(`SIESA_IMPORTAR_CO (${etiqueta}${sede ? ` ${sede}` : ""})`);
  } else if (co.length !== CO_LARGO) {
    // Atajamos acá lo que SIESA rechazaría igual, pero con un mensaje que se
    // entiende: "largo inválido" es más útil que un error del ERP.
    faltan.push(
      `SIESA_IMPORTAR_CO ${etiqueta} con largo inválido ("${co}" tiene ${co.length}, deben ser ${CO_LARGO})`,
    );
  }
}

/**
 * Qué falta para poder enviar. Vacío = todo listo.
 *
 * Ahora se valida el C.O. del ORIGEN y del DESTINO: en el modelo de tránsito la
 * entrada declara el C.O. destino, y un destino sin C.O. rompería la entrada
 * DESPUÉS de que la salida ya entró — el peor momento para enterarse.
 *
 * @param {string} [origen]  - bodega origen del despacho
 * @param {string} [destino] - bodega destino del despacho (opcional)
 */
export function configFaltante(origen, destino) {
  const faltan = [];
  if (!cfg.idSistema()) faltan.push("SIESA_IMPORTAR_ID_SISTEMA");
  if (!cfg.key()) faltan.push("CONNI_KEY");
  if (!cfg.token()) faltan.push("CONNI_TOKEN");

  validarCO(faltan, origen, "centro de operación origen");
  if (destino) validarCO(faltan, destino, "centro de operación destino");

  return faltan;
}

/**
 * Fecha del documento en el formato que pide el conector: AAAAMMDD.
 *
 * En hora de COLOMBIA, no del servidor. Vercel corre en UTC: `getDate()` sobre
 * un despacho cerrado a las 7 PM en Colombia (= 00:00 UTC del día siguiente)
 * devolvía MAÑANA, y el documento entraba a SIESA fechado un día después del
 * movimiento físico. Contabilizado, además. Ver config/tiempo.js.
 */
export function fechaSiesa(d = new Date()) {
  return fechaCompacta(d);
}

/**
 * Ítems que van al plano SIESA: recolectados (cantidad_despachador > 0) y NO
 * excluidos a mano por el admin.
 *
 * `siesa_omitido` es la válvula de escape para el renglón que ROMPE la
 * importación (código mal en el ERP, ítem que SIESA no acepta). Antes un solo
 * renglón así tumbaba el traslado ENTERO a `fallido` y tocaba subir todo a mano;
 * ahora el admin lo saca del plano y el resto entra solo.
 *
 * El filtro vive ACÁ, en el helper, y no en cada armador: salida y entrada son
 * las dos caras del mismo movimiento y TIENEN que excluir exactamente los mismos
 * renglones. Si una sacara un ítem que la otra deja, el plano quedaría
 * descuadrado (salió N, entró N+1) y SIESA lo rechazaría.
 *
 * OJO: excluye AL ARMAR. Si el renglón ya se envió a SIESA con éxito, marcarlo
 * después NO lo saca del ERP — ahí la marca queda solo como registro.
 */
function itemsRecolectados(despacho) {
  return (despacho?.traslados_items || []).filter(
    (it) => Number(it.cantidad_despachador) > 0 && !it.siesa_omitido,
  );
}

/** Nota del documento, recortada al tope de f350_notas (255). */
function notaDoc(despacho, cara) {
  return `Traslado ${cara} ${despacho.origen} -> ${despacho.destino} (despacho ${despacho.id})`.slice(
    0,
    255,
  );
}

/**
 * Movimientos (una línea por ítem). Salida y entrada comparten estructura y
 * difieren solo en C.O., tipo de docto, bodega y motivo.
 *
 * OJO con la UNIDAD: `cantidad_despachador` está guardada en la unidad del ítem,
 * NO en UND. `cantidad_despachador × factor` da el total real en UND (el factor
 * queda sincronizado con la unidad guardada — misma canonicalización que
 * compararAuditoria). A SIESA siempre va en UND.
 *
 * `NRO DOCTO` va en 0: el conector asigna el consecutivo (F_CONSEC_AUTO_REG = 1).
 * La entrada NO referencia a la salida por acá, sino por el CONSECUTIVO del
 * documento (ver armarEntrada).
 */
function construirMovimientos(items, { co, tipoDocto, bodega, motivo }) {
  return items.map((it, i) => ({
    "C.O_DOCUMENTO": co,
    "TIPO DOCTO": tipoDocto,
    "NRO DOCTO": 0,
    "NRO REGISTRO MOVIMIENTO": String(i + 1),
    BODEGA_MOVIMIENTO: bodega,
    MOTIVO: motivo,
    "C.O MOVIMIENTO": co,
    UNIDAD_MEDIDA: "UND",
    CANTIDAD: String((Number(it.cantidad_despachador) || 0) * (Number(it.factor) || 1)),
    ITEM: String(it.codigo_item || ""),
  }));
}

/**
 * Payload de la SALIDA en tránsito (clase 65 / CTS).
 *
 * Los 3 campos de referencia al docto base (CO_BASE / TIPO_DOCTO / CONSECUTIVO)
 * van VACÍOS: solo la entrada apunta a la salida, no al revés. Bodega y C.O. del
 * movimiento son los del ORIGEN. Motivo 50/02 según Parque→Llano.
 *
 * @param {object} despacho - cabecera + traslados_items
 * @returns {{ Documentos: object[], Movimientos: object[] }}
 */
export function armarSalida(despacho) {
  const items = itemsRecolectados(despacho);
  const fecha = fechaSiesa(new Date(despacho.updated_at || Date.now()));
  const coOrigen = resolverCO(despacho.origen);

  const documento = {
    "C.O DOCTO": coOrigen,
    "TIPO DOCTO": TIPO_SALIDA,
    "FECHA_DOCUMENTO=8 (AAAAMMDD)": fecha,
    CLASE_DOCTO: CLASE_SALIDA,
    NOTAS: notaDoc(despacho, "salida"),
    BODEGA_SALIDA: String(despacho.origen || ""),
    BODEGA_ENTRADA: String(despacho.destino || ""),
    // Referencia al docto base — solo en la ENTRADA. Vacíos acá.
    CO_BASE: "",
    TIPO_DOCTO: "",
    CONSECUTIVO: "",
  };

  const movimientos = construirMovimientos(items, {
    co: coOrigen,
    tipoDocto: TIPO_SALIDA,
    bodega: String(despacho.origen || ""),
    motivo: motivoSalida(despacho),
  });

  return { Documentos: [documento], Movimientos: movimientos };
}

/**
 * Payload de la ENTRADA en tránsito (clase 66 / CTE).
 *
 * Referencia a la salida: CO_BASE = C.O. origen, TIPO_DOCTO = CTS (el tipo de la
 * salida), CONSECUTIVO = nro del docto que generó la salida. Sin ese consecutivo
 * la entrada no puede existir. Bodega y C.O. del movimiento son los del DESTINO.
 * Motivo 01 siempre.
 *
 * @param {object} despacho    - cabecera + traslados_items
 * @param {string|number} salidaDocto - consecutivo que SIESA asignó a la salida
 * @returns {{ Documentos: object[], Movimientos: object[] }}
 */
export function armarEntrada(despacho, salidaDocto) {
  const items = itemsRecolectados(despacho);
  const fecha = fechaSiesa(new Date(despacho.updated_at || Date.now()));
  const coOrigen = resolverCO(despacho.origen);
  const coDestino = resolverCO(despacho.destino);

  const documento = {
    "C.O DOCTO": coDestino,
    "TIPO DOCTO": TIPO_ENTRADA,
    "FECHA_DOCUMENTO=8 (AAAAMMDD)": fecha,
    CLASE_DOCTO: CLASE_ENTRADA,
    NOTAS: notaDoc(despacho, "entrada"),
    BODEGA_SALIDA: String(despacho.origen || ""),
    BODEGA_ENTRADA: String(despacho.destino || ""),
    // La entrada apunta a la salida por su consecutivo.
    CO_BASE: coOrigen,
    TIPO_DOCTO: TIPO_SALIDA,
    CONSECUTIVO: String(salidaDocto ?? ""),
  };

  const movimientos = construirMovimientos(items, {
    co: coDestino,
    tipoDocto: TIPO_ENTRADA,
    bodega: String(despacho.destino || ""),
    motivo: MOTIVO_ENTRADA,
  });

  return { Documentos: [documento], Movimientos: movimientos };
}

/**
 * ¿La respuesta de SIESA dice que salió bien?
 * El conector responde 200 aunque rechace el documento, así que mirar el status
 * HTTP no alcanza: hay que leer el cuerpo. Un 200 con errores adentro es un
 * fallo, y tratarlo como éxito sería peor que un 500 — quedaría marcado como
 * "enviado" sin estar en el ERP, y nadie lo reintentaría nunca.
 */
function respuestaOk(data) {
  if (data == null) return false;
  if (typeof data === "object") {
    if (data.codigo != null && Number(data.codigo) !== 0) return false;
    const errores = data.Errores ?? data.errores;
    if (Array.isArray(errores) && errores.length > 0) return false;
    if (data.error) return false;
  }
  return true;
}

/**
 * Serializa cualquier cosa a texto legible.
 *
 * El detalle: `String(unArray)` y la interpolación en template devuelven
 * "[object Object],[object Object]" — el valor se pierde y el log no sirve para
 * nada. Un error que no se puede leer es un error que no existe.
 */
const aTexto = (v) => {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
};

/**
 * Texto de error legible a partir de lo que sea que haya devuelto SIESA.
 * El conector responde el detalle en formas distintas según el fallo: string,
 * objeto, o un ARRAY de objetos (una entrada por campo inválido). Todas tienen
 * que terminar siendo texto que un humano pueda leer en el log.
 */
function detalleError(data) {
  if (data == null) return "sin respuesta";
  if (typeof data === "string") return data.slice(0, 800);

  const errores = data.Errores ?? data.errores;
  if (Array.isArray(errores) && errores.length) return aTexto(errores).slice(0, 800);

  const d = data.detalle ?? data.mensaje ?? data.error;
  if (d != null) {
    const texto = aTexto(d);
    if (texto) return texto.slice(0, 800);
  }

  return aTexto(data).slice(0, 800);
}

/**
 * Busca recursivamente la primera clave tipo consecutivo con valor útil.
 *
 * El conector devuelve el NroDocto en formas distintas según el caso (bajo
 * `detalle`, dentro de un array `Documentos`, anidado). Un lookup por rutas fijas
 * se pierde el consecutivo y dispara el bug de la salida duplicada. Esta búsqueda
 * recorre el objeto y toma el primer valor de una clave `NroDocto`/`nro_docto`/
 * `consecutivo`/`consec_docto` que NO sea vacío ni el placeholder "0".
 */
function buscarConsecutivo(obj, prof = 0) {
  if (obj == null || prof > 4) return "";
  if (Array.isArray(obj)) {
    for (const x of obj) {
      const r = buscarConsecutivo(x, prof + 1);
      if (r) return r;
    }
    return "";
  }
  if (typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      if (/^(nro_?docto|consecutivo|consec_docto)$/i.test(k)) {
        const s = String(v ?? "").trim();
        if (s && s !== "0") return s;
      }
    }
    for (const v of Object.values(obj)) {
      const r = buscarConsecutivo(v, prof + 1);
      if (r) return r;
    }
  }
  return "";
}

/** Consecutivo que SIESA asignó a un documento, sin importar cómo lo envuelva. */
function doctoDe(data) {
  const directo = String(data?.detalle?.NroDocto || data?.NroDocto || data?.nro_docto || "").trim();
  if (directo && directo !== "0") return directo;
  // Si las rutas conocidas no dieron, barremos el cuerpo entero. Mejor recuperar
  // el consecutivo que dejarlo vacío y arriesgar el flujo de la entrada.
  return buscarConsecutivo(data);
}

/**
 * POST crudo al conector. Una sola pasada, SIN reintento interno: el reintento
 * vive afuera (requisicion.service) y pasa por la BD. Reintentar acá adentro, en
 * memoria, correría el riesgo de mandar dos veces sin registro de la primera —
 * con un write al ERP, "no sé si llegó" es peor que "falló".
 *
 * Devuelve `{ data, status }`. No lanza por status: el conector devuelve 200 con
 * errores adentro y también 4xx/5xx; la evaluación la hace quien llama.
 */
async function postConector(payload) {
  return axios
    .post(cfg.url(), payload, {
      params: {
        idCompania: cfg.idCompania(),
        idSistema: cfg.idSistema(),
        idDocumento: cfg.idDocumento(),
        nombreDocumento: cfg.nombreDocumento(),
      },
      headers: {
        conniKey: cfg.key(),
        conniToken: cfg.token(),
        "Content-Type": "application/json",
      },
      timeout: 60_000,
      validateStatus: () => true,
    })
    .then(({ data, status }) => ({ data, status }));
}

/** Convierte un rechazo de SIESA en un Error con la respuesta cruda adjunta. */
function errorRechazo(cara, status, data) {
  const err = new Error(`SIESA rechazó la ${cara} en tránsito [HTTP ${status}]: ${detalleError(data)}`);
  // Adjuntamos la respuesta cruda para que el orquestador decida si el rechazo es
  // un faltante de stock ajustable (registro 470) sin re-parsear el mensaje.
  err.siesaData = data;
  err.httpStatus = status;
  return err;
}

/**
 * Importa la SALIDA en tránsito (clase 65) a partir de un despacho.
 *
 * Es el PRIMER eslabón: valida stock en la bodega origen, así que es acá donde
 * SIESA puede rechazar por "Item sin cantidad disponible" (registro 470) y donde
 * el orquestador engancha el ajuste automático. Devuelve el consecutivo que
 * SIESA asignó — es el que la entrada necesita.
 *
 * @param {object} despacho
 * @returns {Promise<{ ok:true, docto:string, respuesta:object, payload:object } | { ok:true, vacio:true }>}
 * @throws {ConfigSiesaError} si falta configuración
 * @throws {Error} si SIESA rechaza o no responde (con `siesaData` adjunto)
 */
export async function importarSalida(despacho) {
  const faltan = configFaltante(despacho?.origen, despacho?.destino);
  if (faltan.length) throw new ConfigSiesaError(faltan);

  const payload = armarSalida(despacho);

  if (payload.Movimientos.length === 0) {
    // Nada salió del camión: no hay transferencia que importar. No es un error.
    return { ok: true, vacio: true, docto: null, respuesta: null, payload: null };
  }

  // SANDBOX — se corta JUSTO ANTES del POST y DESPUÉS de armar el payload: así el
  // armado (donde viven los bugs de C.O., bodegas, motivos y unidades) se
  // ejercita igual y queda guardado para revisarlo. El docto simulado deja el
  // par en el camino feliz — la entrada lo referencia como cualquier consecutivo.
  if (sandboxOn()) {
    const docto = `SANDBOX-CTS-${String(despacho?.id || "").slice(0, 8).toUpperCase()}`;
    console.warn(
      `[siesa] 🧪 SANDBOX — salida en tránsito del despacho ${despacho?.id} NO se importó. ` +
        `${payload.Movimientos.length} movimiento(s) simulados como ${docto}.`,
    );
    return { ok: true, sandbox: true, docto, respuesta: { sandbox: true }, payload };
  }

  const { data, status } = await postConector(payload);
  if (status >= 400 || !respuestaOk(data)) throw errorRechazo("salida", status, data);

  return { ok: true, docto: doctoDe(data), respuesta: data, payload };
}

/**
 * Importa la ENTRADA en tránsito (clase 66) referenciando el consecutivo de la
 * salida. SEGUNDO eslabón: solo tiene sentido con una salida ya aceptada.
 *
 * NO lleva ajuste de faltantes: la entrada no valida stock de la bodega origen
 * (eso lo hizo la salida), valida que el docto de tránsito exista. Si falla, el
 * orquestador reintenta SOLO la entrada (la salida ya está persistida).
 *
 * @param {object} despacho
 * @param {string|number} salidaDocto - consecutivo de la salida (obligatorio)
 * @returns {Promise<{ ok:true, docto:string, respuesta:object, payload:object } | { ok:true, vacio:true }>}
 * @throws {ConfigSiesaError} si falta configuración
 * @throws {Error} si falta el consecutivo de salida, o si SIESA rechaza / no responde
 */
export async function importarEntrada(despacho, salidaDocto) {
  const faltan = configFaltante(despacho?.origen, despacho?.destino);
  if (faltan.length) throw new ConfigSiesaError(faltan);

  const consecutivo = trim(salidaDocto);
  if (!consecutivo) {
    // Sin el consecutivo de la salida la entrada es imposible. Es un error de
    // programa (no debería llegar acá), no un rechazo de SIESA: sin siesaData.
    throw new Error("No hay consecutivo de salida para armar la entrada en tránsito.");
  }

  const payload = armarEntrada(despacho, consecutivo);

  if (payload.Movimientos.length === 0) {
    return { ok: true, vacio: true, docto: null, respuesta: null, payload: null };
  }

  if (sandboxOn()) {
    const docto = `SANDBOX-CTE-${String(despacho?.id || "").slice(0, 8).toUpperCase()}`;
    console.warn(
      `[siesa] 🧪 SANDBOX — entrada en tránsito del despacho ${despacho?.id} NO se importó. ` +
        `${payload.Movimientos.length} movimiento(s) simulados como ${docto} ` +
        `(referencia salida ${consecutivo}).`,
    );
    return { ok: true, sandbox: true, docto, respuesta: { sandbox: true }, payload };
  }

  const { data, status } = await postConector(payload);
  if (status >= 400 || !respuestaOk(data)) throw errorRechazo("entrada", status, data);

  return { ok: true, docto: doctoDe(data), respuesta: data, payload };
}
