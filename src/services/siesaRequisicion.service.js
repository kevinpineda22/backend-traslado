import axios from "axios";
import "dotenv/config";
import { centroOperacionDeSede } from "../config/flujos.js";
import { fechaCompacta } from "../config/tiempo.js";

/* =============================================
   Importar requisición a SIESA (/conectoresimportar, conector 249486
   DEV_REQUISICIONES → registro tipo 450, cabecera de inventario)

   Este módulo ESCRIBE EN EL ERP. Todo lo demás del backend lee; esto no. Si se
   dispara dos veces quedan dos requisiciones, o sea movimientos de inventario
   que nunca ocurrieron. La idempotencia no la resuelve este archivo: la resuelve
   el estado `siesa_estado` en la BD (ver migración 007 y requisicion.service).
   Acá solo armamos el payload y hacemos el POST.

   ── Lo que el conector ya trae horneado (spec del registro 450) ──
   El JSON solo lleva los campos VARIABLES; los fijos viven en la definición del
   conector y NO viajan. Anotados acá porque explican qué estamos creando:

     f350_id_tipo_docto   = CTI
     f350_id_clase_docto  = 67  → Transferencias
     f450_id_concepto     = 607 → Transferencias
     f350_ind_estado      = 1   → Aprobado/Contabilizado
     F_CIA                = 001
     F_CONSEC_AUTO_REG    = 1   → el consecutivo lo asigna SIESA

   OJO: `ind_estado = 1` significa que el documento NO entra como borrador. Entra
   aprobado y contabilizado: mueve inventario apenas SIESA lo acepta. No hay una
   instancia intermedia donde alguien revise. Por eso todo este flujo está armado
   alrededor de no enviar dos veces y de no enviar basura.

   Configuración (.env):
     SIESA_IMPORTAR_URL        base del conector (default: QA)
     SIESA_IMPORTAR_ID_SISTEMA idSistema (default 1)
     SIESA_IMPORTAR_ID_DOCUMENTO      default 249486
     SIESA_IMPORTAR_NOMBRE_DOCUMENTO  default DEV_REQUISICIONES
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
  idDocumento: () => process.env.SIESA_IMPORTAR_ID_DOCUMENTO || "249486",
  nombreDocumento: () => process.env.SIESA_IMPORTAR_NOMBRE_DOCUMENTO || "DEV_REQUISICIONES",
  key: () => process.env.CONNEKTA_KEY || process.env.CONNI_KEY || "",
  token: () => process.env.CONNEKTA_TOKEN || process.env.CONNI_TOKEN || "",
};

/** Longitud exacta de f350_id_co según el spec del registro 450. */
const CO_LARGO = 3;

/**
 * Centro de operación (`f350_id_co`) de una sede. 3 chars, valida en maestro.
 *
 * La tabla vive en config/flujos.js, al lado de SEDES (ver CENTROS_OPERACION).
 * Acá solo resolvemos con precedencia, de más específico a más general:
 *   1. `SIESA_IMPORTAR_CO_POR_SEDE` = {"PV001":"P01"} — override por sede.
 *   2. La tabla del código.
 *   3. `SIESA_IMPORTAR_CO` — valor único, escotilla de emergencia.
 *
 * @param {string} sede - bodega de origen del despacho
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

/**
 * Qué falta para poder enviar. Vacío = todo listo.
 * @param {string} [sede] - origen del despacho; el C.O. puede variar por sede
 */
export function configFaltante(sede) {
  const faltan = [];
  if (!cfg.idSistema()) faltan.push("SIESA_IMPORTAR_ID_SISTEMA");
  if (!cfg.key()) faltan.push("CONNI_KEY");
  if (!cfg.token()) faltan.push("CONNI_TOKEN");

  const co = resolverCO(sede);
  if (!co) {
    faltan.push(
      `SIESA_IMPORTAR_CO${sede ? ` (centro de operación de la sede ${sede})` : ""}`,
    );
  } else if (co.length !== CO_LARGO) {
    // Atajamos acá lo que SIESA rechazaría igual, pero con un mensaje que se
    // entiende: "largo inválido" es más útil que un error del ERP.
    faltan.push(
      `SIESA_IMPORTAR_CO con largo inválido ("${co}" tiene ${co.length}, deben ser ${CO_LARGO})`,
    );
  }

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
 * Arma el payload de la requisición a partir de un despacho.
 *
 * Solo viajan los ítems que el AUDITOR verificó que llegaron (`cantidad_auditor
 * > 0`). Lo que se mueve en el ERP es lo que realmente se recibió y verificó —
 * el auditor tiene la última palabra: incluye sus correcciones y los productos
 * que agregó fuera de lista, y excluye lo que no llegó (cantidad_auditor 0).
 *
 * OJO con los nombres de campo: `Documentos` usa "NRO DOCTO" (con espacio) y
 * `Movimientos` usa "NRO_DOCTO" (con guión bajo). Está copiado tal cual del
 * contrato del conector — si se "corrige", SIESA lo rechaza.
 *
 * @param {object} despacho - cabecera + traslados_items
 * @returns {{ Documentos: object[], Movimientos: object[] }}
 */
export function armarPayload(despacho) {
  const items = (despacho?.traslados_items || []).filter(
    (it) => Number(it.cantidad_auditor) > 0,
  );

  // Consecutivo en 0: el conector va con F_CONSEC_AUTO_REG = 1
  // ("el consecutivo es recalculado con base en la tabla de consecutivos de
  // docto"). Lo asigna SIESA; mandarlo nosotros sería pelearle al ERP por un
  // número que él ya sabe cuál es. Pero SIESA exige que el campo sea numérico,
  // por lo que mandamos 0 en vez de string vacío.
  const nroDocto = 0;
  const fecha = fechaSiesa(new Date(despacho.updated_at || Date.now()));
  const co = resolverCO(despacho.origen);

  const documento = {
    "C.O_DESPACHO": co,
    "NRO DOCTO": nroDocto,
    "FECHA_DOCUMENTO=8 (AAAAMMDD)": fecha,
    // f350_notas tope 255 en el spec. Recortamos nosotros: que el ERP nos
    // rechace un documento entero por una nota larga sería absurdo.
    NOTA_DOCUMENTO: `Traslado ${despacho.origen} -> ${despacho.destino} (despacho ${despacho.id})`.slice(
      0,
      255,
    ),
    BODEGA_SALIDA: String(despacho.origen || ""),
    BODEGA_ENTRADA: String(despacho.destino || ""),
  };

  const movimientos = items.map((it, i) => ({
    "C.O_OPERACION": co,
    NRO_DOCTO: nroDocto,
    NRO_REGISTRO_MOVIMIENTO: String(i + 1),
    BODEGA_SALIDA: String(despacho.origen || ""),
    "C.O_MOVIMIENTO": co,
    // Canonicalización: cantidad_auditor ya viene en UND (unidades reales), sin
    // importar en qué unidad contó el auditor. A SIESA siempre va en UND.
    UNIDAD_MEDIDA: "UND",
    CANTIDAD: String(Number(it.cantidad_auditor) || 0),
    CODIGO_ITEM: String(it.codigo_item || ""),
  }));

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
 * Importa la requisición a SIESA. Una sola pasada, SIN reintento interno.
 *
 * El reintento vive afuera (requisicion.service) y pasa por la BD: reintentar
 * acá adentro, en memoria, correría el riesgo de mandar dos veces sin que quede
 * registro de la primera. Con un POST que escribe en el ERP, "no sé si llegó" es
 * peor que "falló".
 *
 * @param {object} despacho
 * @returns {Promise<{ ok: true, docto: string, respuesta: object }>}
 * @throws {ConfigSiesaError} si falta configuración
 * @throws {Error} si SIESA rechaza o no responde
 */
export async function importarRequisicion(despacho) {
  const faltan = configFaltante(despacho?.origen);
  if (faltan.length) throw new ConfigSiesaError(faltan);

  const payload = armarPayload(despacho);

  if (payload.Movimientos.length === 0) {
    // Nada salió del camión: no hay requisición que importar. No es un error.
    return { ok: true, vacio: true, docto: null, respuesta: null };
  }

  const { data, status } = await axios.post(cfg.url(), payload, {
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
    // No lanzamos por status: el conector devuelve 200 con errores adentro y
    // también 4xx/5xx. Los evaluamos todos por igual acá abajo.
    validateStatus: () => true,
  });

  if (status >= 400 || !respuestaOk(data)) {
    throw new Error(`SIESA rechazó la requisición [HTTP ${status}]: ${detalleError(data)}`);
  }

  return {
    ok: true,
    docto: String(data?.detalle?.NroDocto || data?.NroDocto || data?.nro_docto || ""),
    respuesta: data,
    payload,
  };
}
