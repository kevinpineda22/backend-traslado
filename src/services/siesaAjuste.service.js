import axios from "axios";
import "dotenv/config";
import { ejecutarConsulta } from "../config/connekta.js";
import { resolverCO, fechaSiesa } from "./siesaRequisicion.service.js";

/* =============================================
   Ajuste de inventario a SIESA (/conectoresimportar, conector 250295
   AJUSTE_DESARROLLO_REQUISICIONES → registro tipo 450, clase 61 / concepto 601:
   ENTRADA de inventario)

   POR QUÉ EXISTE ESTE MÓDULO
   ─────────────────────────
   La requisición de traslado (siesaRequisicion.service, conector 249486) entra a
   SIESA CONTABILIZADA y valida que la BODEGA DE SALIDA tenga existencias. Si el
   ítem está en cero, SIESA rechaza con un registro tipo 470:

     "Movto Inventario: Item sin cantidad disponible Faltante Inv.: -9.000000"

   En AMBIENTE DE DESARROLLO la decisión de negocio es: insertar esas unidades con
   un ajuste de entrada y reintentar el traslado. Este módulo arma y manda ESE
   ajuste. Igual que la requisición, ESCRIBE EN EL ERP: si se dispara dos veces,
   inserta stock fantasma por duplicado. La idempotencia NO vive acá — vive en el
   estado `siesa_ajuste_estado` de la BD (migración 009, requisicion.service).

   ⚠️  Este es un write al ERP que FABRICA inventario. Está detrás de un flag
   (`SIESA_AJUSTE_AUTO`) apagado por defecto: sin él, nada se dispara.

   ── Lo que el conector trae horneado (spec del registro 450, clase 61) ──
   Solo viajan los campos VARIABLES; los fijos viven en la definición del conector:
     f350_id_clase_docto = 61  → Entrada
     f450_id_concepto    = 601 → Entrada
     f350_ind_estado     = 1   → Aprobado/Contabilizado (mueve inventario al instante)
     F_CIA               = 001
     F_CONSEC_AUTO_REG   = 1   → el consecutivo lo asigna SIESA

   ── De dónde sale cada valor variable ──
     FECHA_DOCTO      fechaSiesa() en hora Colombia (AAAAMMDD)
     BODEGA           origen del despacho (donde insertamos el stock)
     C.O MOVIMIENTO   resolverCO(origen)
     ITEM / CANTIDAD  del faltante que reportó SIESA (registro 470)
     COSTO_PROMEDIO   consulta `merkahorro_costo_promedio_dev` → CostoPromInst
     UNIDAD_NEGOCIO   MISMA fila de esa consulta → IdInstalacion (001/002/003)

   Config (.env):
     SIESA_AJUSTE_AUTO            "1" para habilitar el disparo automático
     SIESA_AJUSTE_ID_DOCUMENTO    default 250295
     SIESA_AJUSTE_NOMBRE_DOCUMENTO default AJUSTE_DESARROLLO_REQUISICIONES
     SIESA_AJUSTE_ID_SISTEMA      default 1 (cae a SIESA_IMPORTAR_ID_SISTEMA)
     SIESA_AJUSTE_UNIDAD_MEDIDA   default UND
     SIESA_AJUSTE_UNIDAD_NEGOCIO  override fijo (si NO querés que salga de IdInstalacion)
     SIESA_AJUSTE_CONSULTA_COSTO  default merkahorro_costo_promedio_dev
     SIESA_AJUSTE_PARAM_ITEM      default v121_id_item (parámetro de la consulta)
     SIESA_AJUSTE_COSTO_DEFAULT   costo de respaldo si la consulta no trae el ítem
     (reusa CONNEKTA_ID_COMPANIA / CONNI_KEY / CONNI_TOKEN / SIESA_IMPORTAR_URL)
   ============================================= */

const cfg = {
  url: () =>
    process.env.SIESA_IMPORTAR_URL ||
    "https://servicios.siesacloud.com/api/siesa/v3.1/conectoresimportar",
  idCompania: () => process.env.CONNEKTA_ID_COMPANIA || "7375",
  idSistema: () =>
    process.env.SIESA_AJUSTE_ID_SISTEMA || process.env.SIESA_IMPORTAR_ID_SISTEMA || "1",
  idDocumento: () => process.env.SIESA_AJUSTE_ID_DOCUMENTO || "250295",
  nombreDocumento: () =>
    process.env.SIESA_AJUSTE_NOMBRE_DOCUMENTO || "AJUSTE_DESARROLLO_REQUISICIONES",
  key: () => process.env.CONNEKTA_KEY || process.env.CONNI_KEY || "",
  token: () => process.env.CONNEKTA_TOKEN || process.env.CONNI_TOKEN || "",
  unidadMedida: () => process.env.SIESA_AJUSTE_UNIDAD_MEDIDA || "UND",
  unidadNegocioFija: () => String(process.env.SIESA_AJUSTE_UNIDAD_NEGOCIO || "").trim(),
  consultaCosto: () =>
    process.env.SIESA_AJUSTE_CONSULTA_COSTO || "merkahorro_costo_promedio_dev",
  paramItem: () => process.env.SIESA_AJUSTE_PARAM_ITEM || "v121_id_item",
  costoDefault: () => {
    const v = process.env.SIESA_AJUSTE_COSTO_DEFAULT;
    return v == null || v === "" ? null : Number(v);
  },
};

/**
 * ¿Está habilitado el ajuste automático? Apagado por defecto — este es un write
 * que fabrica inventario, no se prende solo por mergear código.
 */
export function ajusteAutoHabilitado() {
  return ["1", "true", "on", "si", "sí"].includes(
    String(process.env.SIESA_AJUSTE_AUTO || "").trim().toLowerCase(),
  );
}

/**
 * Estado de la config del ajuste, para diagnóstico read-only (GET /siesa/ajuste/estado).
 * Existe por la misma razón que /health/email: "la variable está cargada en Vercel"
 * NO es lo mismo que "el runtime la ve". `envAutoRaw` muestra EXACTAMENTE qué llega
 * a process.env — si es null, la env var no está atada a este deployment.
 * No expone secretos (keys/tokens quedan afuera).
 */
export function estadoAjusteConfig(sede = "PV001") {
  return {
    autoHabilitado: ajusteAutoHabilitado(),
    envAutoRaw: process.env.SIESA_AJUSTE_AUTO ?? null,
    idDocumento: cfg.idDocumento(),
    nombreDocumento: cfg.nombreDocumento(),
    idSistema: cfg.idSistema(),
    unidadMedida: cfg.unidadMedida(),
    unidadNegocioFija: cfg.unidadNegocioFija() || null,
    consultaCosto: cfg.consultaCosto(),
    paramItem: cfg.paramItem(),
    configFalta: configAjusteFaltante(sede),
  };
}

const trim = (v) => String(v ?? "").trim();

/**
 * Clave canónica de ítem para cruzar el costo. La consulta de costo guarda el
 * `IdItem` SIN ceros a la izquierda ("15312") mientras que el faltante de SIESA
 * viene CON ceros ("0015312"). Normalizamos ambos lados sacando los ceros para que
 * crucen. (El código que se manda al conector sigue siendo el original con ceros.)
 */
const normItem = (v) => trim(v).replace(/^0+/, "") || "0";

/**
 * Probe read-only de la consulta de costo (para GET /siesa/ajuste/estado?probe=ITEM).
 * Usa el endpoint DINÁMICO (que es el correcto para esta consulta). Construye el
 * mapa completo y reporta el total, cuántos ítems quedaron y el dato del ítem
 * consultado. Es un SELECT: no escribe nada en el ERP.
 */
export async function probarConsultaCosto(item) {
  const codigo = trim(item);
  try {
    const cache = await refrescarMapaCostos();
    const hit = cache.mapa.get(normItem(codigo)) || null;

    return {
      ok: true,
      consulta: cfg.consultaCosto(),
      endpoint: "dinamica",
      totalRegistros: cache.total,
      paginasLeidas: cache.paginas,
      filasValidas: cache.filas,
      itemsEnMapa: cache.mapa.size,
      item: codigo,
      claveNormalizada: normItem(codigo),
      encontrado: hit,
    };
  } catch (e) {
    return {
      ok: false,
      consulta: cfg.consultaCosto(),
      endpoint: "dinamica",
      item: codigo,
      message: e.message,
    };
  }
}

/**
 * Detecta qué ítems rechazó SIESA por "sin cantidad disponible" y cuánto falta.
 *
 * SIESA devuelve un array de errores; cada faltante es un registro tipo 470 con:
 *   f_valor:  "Item:0005312Bodega:PV001"            (ítem + bodega, sin espacio)
 *   f_detalle:"...Item sin cantidad disponible Faltante Inv.: -9.000000..."
 *
 * Leemos el faltante DIRECTO del error (no lo recalculamos contra el stock en
 * vivo): es exactamente lo que SIESA dice que falta para que el traslado pase, y
 * viene de la misma verificación que rechazó — cualquier recálculo nuestro podría
 * discrepar por la caché de 60s del stock y quedar corto.
 *
 * @param {*} siesaData - cuerpo crudo de la respuesta de SIESA (err.siesaData)
 * @returns {{item:string, bodega:string, cantidad:number}[]} faltantes, deduplicados por ítem
 */
export function detectarFaltantes(siesaData) {
  // Primero intentamos la lectura estructurada (rápida y precisa).
  const estructurado = faltantesEstructurado(siesaData);
  if (estructurado.length) return estructurado;

  // Red de seguridad: SIESA envuelve el error de formas impredecibles
  // ({ codigo, detalle: [...] }, { Errores: [...] }, string, texto plano...). En
  // vez de perseguir cada forma, escaneamos el cuerpo ENTERO serializado: los
  // literales "Item:..Bodega:.." y "Faltante Inv.: -N" están SIEMPRE presentes,
  // sin importar el envoltorio. Si el estructurado ya encontró, este no corre.
  return faltantesDesdeTexto(aTexto(siesaData));
}

/**
 * Lectura estructurada del cuerpo de SIESA. Contempla array pelado, string JSON
 * (axios no lo parsea si el content-type no es application/json), y el envoltorio
 * `{ Errores | errores | detalle | Detalle: [...] }`. Devuelve [] si no matchea
 * ninguna forma conocida — ahí entra el fallback por texto de detectarFaltantes.
 */
function faltantesEstructurado(siesaData) {
  let data = siesaData;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      return faltantesDesdeTexto(data);
    }
  }

  const arr = Array.isArray(data)
    ? data
    : data?.Errores ??
      data?.errores ??
      data?.detalle ?? // ← SIESA envuelve la respuesta bajo `detalle`
      data?.Detalle ??
      (data ? [data] : []);
  if (!Array.isArray(arr)) return [];

  const porItem = new Map();
  for (const e of arr) {
    // Una entrada puede venir ella misma como string (array de strings).
    if (typeof e === "string") {
      for (const f of faltantesDesdeTexto(e)) acumularFaltante(porItem, f);
      continue;
    }

    const detalle = String(e?.f_detalle ?? e?.detalle ?? "");
    const esFaltante =
      /sin cantidad disponible/i.test(detalle) || String(e?.f_tipo_reg) === "470";
    if (!esFaltante) continue;

    const m = /Item:\s*(.*?)\s*Bodega:\s*(\S+)/i.exec(String(e?.f_valor ?? ""));
    const item = m ? m[1].trim() : "";
    const bodega = m ? m[2].trim() : "";

    const fm = /Faltante\s*Inv\.?:\s*-?\s*([\d.]+)/i.exec(detalle);
    const cantidad = fm ? Math.abs(Number(fm[1])) : 0;

    acumularFaltante(porItem, { item, bodega, cantidad });
  }
  return [...porItem.values()];
}

/**
 * Extrae faltantes de un texto plano (fallback cuando el cuerpo no es JSON).
 * Cada faltante trae "Item:<code>Bodega:<bod>" y, más adelante en la misma
 * entrada, "Faltante Inv.: -<N>". Los ítems y los faltantes salen en el MISMO
 * orden (uno por registro 470), así que los emparejamos por índice.
 */
function faltantesDesdeTexto(txt) {
  const s = String(txt || "");
  const items = [...s.matchAll(/Item:\s*(.*?)\s*Bodega:\s*([A-Za-z0-9]+)/gi)];
  const falts = [...s.matchAll(/Faltante\s*Inv\.?:\s*-?\s*([\d.]+)/gi)];
  const porItem = new Map();
  items.forEach((m, i) => {
    const cantidad = falts[i] ? Math.abs(Number(falts[i][1])) : 0;
    acumularFaltante(porItem, { item: m[1]?.trim(), bodega: m[2]?.trim(), cantidad });
  });
  return [...porItem.values()];
}

/**
 * Suma un faltante al mapa por ítem. Un mismo ítem no debería repetirse, pero si
 * repite nos quedamos con el faltante MAYOR: insertar de menos dejaría el traslado
 * rechazado igual. Ignora ítems vacíos o con cantidad no positiva.
 */
function acumularFaltante(porItem, { item, bodega, cantidad }) {
  if (!item || !(cantidad > 0)) return;
  const prev = porItem.get(item);
  if (!prev || cantidad > prev.cantidad) porItem.set(item, { item, bodega, cantidad });
}

/* ── Mapa de costos (consulta DINÁMICA, cacheado) ────────────────────────────
   `merkahorro_costo_promedio_dev` es una consulta DINÁMICA (la crearon ellos),
   y las dinámicas NO aceptan parámetros por ítem: devuelven el dataset entero
   paginado (ver docs/ARQUITECTURA.md y config/connekta.js). Así que traemos TODO
   una vez, armamos un mapa item→{costo, unidadNegocio} y lo cacheamos. Los ajustes
   son raros y el costo cambia lento, así que un TTL largo alcanza y sobra. */
const COSTO_TTL_MS = Number(process.env.SIESA_AJUSTE_COSTO_TTL_MS) || 6 * 60 * 60 * 1000;
const COSTO_TAM_PAG = Number(process.env.SIESA_AJUSTE_COSTO_TAMPAG) || 1000;
const COSTO_MAX_PAGINAS = Number(process.env.SIESA_AJUSTE_COSTO_MAX_PAGINAS) || 300;

let _costoCache = { mapa: null, time: 0, total: 0, filas: 0, paginas: 0 };

/**
 * Acumula filas al mapa item→{costo, unidadNegocio}. La consulta trae una fila por
 * INSTALACIÓN, y acá la instalación (`IdInstalacion` = 001/002/003) ES la unidad de
 * negocio → costo y unidad de negocio salen de la MISMA fila. Si un ítem tiene
 * varias instalaciones, nos quedamos con la de MAYOR costo (valuación conservadora).
 */
function acumularCostos(mapa, rows, fija) {
  let n = 0;
  for (const r of rows || []) {
    const item = normItem(r.IdItem);
    const costo = Number(r.CostoPromInst);
    if (!item || !Number.isFinite(costo)) continue;
    n += 1;
    const prev = mapa.get(item);
    if (!prev || costo > prev.costo) {
      mapa.set(item, { costo, unidadNegocio: fija || trim(r.IdInstalacion) });
    }
  }
  return n;
}

/**
 * Carga (o reusa de caché) el mapa completo de costos. Pagina toda la consulta
 * dinámica una sola vez por TTL.
 */
async function cargarMapaCostos({ force = false } = {}) {
  if (!force && _costoCache.mapa && Date.now() - _costoCache.time < COSTO_TTL_MS) {
    return _costoCache;
  }
  const fija = cfg.unidadNegocioFija();
  const mapa = new Map();
  let filas = 0;

  const primera = await ejecutarConsulta(cfg.consultaCosto(), 1, COSTO_TAM_PAG);
  filas += acumularCostos(mapa, primera.datos, fija);

  const limite = Math.min(primera.totalPaginas || 1, COSTO_MAX_PAGINAS);
  for (let pag = 2; pag <= limite; pag++) {
    const page = await ejecutarConsulta(cfg.consultaCosto(), pag, COSTO_TAM_PAG);
    filas += acumularCostos(mapa, page.datos, fija);
  }

  _costoCache = {
    mapa,
    time: Date.now(),
    total: primera.total || 0,
    filas,
    paginas: limite,
  };
  return _costoCache;
}

/** Fuerza recarga del mapa de costos (para probes / diagnóstico). */
export async function refrescarMapaCostos() {
  return cargarMapaCostos({ force: true });
}

/**
 * Costo + unidad de negocio de cada ítem, del mapa cacheado de la consulta dinámica.
 * Si un ítem no está en el mapa, usa `SIESA_AJUSTE_COSTO_DEFAULT` si está configurado;
 * si no, lanza (no inventamos un costo para escribir en el ERP).
 *
 * @param {string[]} items
 * @returns {Promise<Record<string,{costo:number, unidadNegocio:string}>>}
 */
export async function getDatosItems(items) {
  const unicos = [...new Set((items || []).map(trim).filter(Boolean))];
  const fija = cfg.unidadNegocioFija();
  const porDefecto = cfg.costoDefault();

  let mapa;
  try {
    ({ mapa } = await cargarMapaCostos());
  } catch (e) {
    throw new Error(`No se pudo consultar el costo (${cfg.consultaCosto()}): ${e.message}`);
  }

  const out = {};
  for (const item of unicos) {
    const hit = mapa.get(normItem(item));
    if (hit) {
      out[item] = hit;
    } else if (porDefecto != null) {
      out[item] = { costo: porDefecto, unidadNegocio: fija };
    } else {
      throw new Error(
        `Sin costo promedio para el ítem ${item} en ${cfg.consultaCosto()}. ` +
          "Configurá SIESA_AJUSTE_COSTO_DEFAULT si querés un costo de respaldo.",
      );
    }
  }
  return out;
}

/**
 * Qué falta para poder mandar el ajuste. Vacío = todo listo.
 * Mismo criterio que la requisición: sin credenciales ni C.O. no hay POST.
 */
export function configAjusteFaltante(sede) {
  const faltan = [];
  if (!cfg.idSistema()) faltan.push("SIESA_AJUSTE_ID_SISTEMA");
  if (!cfg.key()) faltan.push("CONNI_KEY");
  if (!cfg.token()) faltan.push("CONNI_TOKEN");
  if (!resolverCO(sede)) {
    faltan.push(`centro de operación de la sede ${sede || "(sin origen)"}`);
  }
  return faltan;
}

/**
 * Arma el body del conector de ajuste a partir del origen y los faltantes.
 * Los nombres de campo están copiados TAL CUAL del contrato del conector 250295
 * (ej. "C.O MOVIMIENTO" con espacio, "consec_docto" en minúscula). No se "corrigen".
 *
 * @param {object} p
 * @param {string} p.bodega   - origen (bodega de entrada del ajuste)
 * @param {string} p.co       - centro de operación
 * @param {string} p.fecha    - AAAAMMDD
 * @param {{item:string, cantidad:number, costo:number, unidadNegocio:string}[]} p.lineas
 */
export function armarPayloadAjuste({ bodega, co, fecha, lineas }) {
  const documento = {
    // El conector 250295 exige el consecutivo en Documentos por su nombre crudo,
    // y espera los valores como STRING (igual que el resto del body). "0" = lo
    // asigna SIESA (F_CONSEC_AUTO_REG = 1, horneado en el conector).
    f350_consec_docto: "0",
    FECHA_DOCTO: fecha,
    BODEGA: bodega,
  };

  const movimientos = lineas.map((l, i) => ({
    // Consecutivo en "0": el conector va con F_CONSEC_AUTO_REG = 1, lo asigna SIESA.
    // Como string, igual que el resto del body (ver documento arriba).
    consec_docto: "0",
    nro_registro: String(i + 1),
    BODEGA: bodega,
    "C.O MOVIMIENTO": co,
    UNIDAD_MEDIDA: cfg.unidadMedida(),
    CANTIDAD: String(l.cantidad),
    COSTO_PROMEDIO: String(l.costo),
    ITEM: String(l.item),
    UNIDAD_NEGOCIO: String(l.unidadNegocio || ""),
  }));

  return { Documentos: [documento], Movimientos: movimientos };
}

/** ¿La respuesta de SIESA dice que el ajuste salió bien? (mismo criterio que la requisición) */
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

const aTexto = (v) => {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
};

function detalleError(data) {
  if (data == null) return "sin respuesta";
  if (typeof data === "string") return data.slice(0, 800);
  const errores = data.Errores ?? data.errores;
  if (Array.isArray(errores) && errores.length) return aTexto(errores).slice(0, 800);
  const d = data.detalle ?? data.mensaje ?? data.error;
  if (d != null) {
    const t = aTexto(d);
    if (t) return t.slice(0, 800);
  }
  return aTexto(data).slice(0, 800);
}

/**
 * Importa un ajuste de ENTRADA a SIESA por los faltantes de un despacho.
 * Una sola pasada, SIN reintento interno (igual que la requisición: reintentar
 * en memoria un write al ERP arriesga duplicar sin registro). El reintento y la
 * idempotencia viven afuera, en requisicion.service + `siesa_ajuste_estado`.
 *
 * @param {object} despacho - cabecera del despacho (necesita `origen`)
 * @param {{item:string, bodega:string, cantidad:number}[]} faltantes
 * @returns {Promise<{ok:true, docto:string, respuesta:object, payload:object}>}
 * @throws {Error} si falta config, o si SIESA rechaza / no responde
 */
export async function importarAjuste(despacho, faltantes) {
  const bodega = trim(despacho?.origen);
  const faltan = configAjusteFaltante(bodega);
  if (faltan.length) {
    throw new Error(`No se puede ajustar inventario: falta ${faltan.join(", ")}`);
  }
  if (!faltantes?.length) {
    return { ok: true, vacio: true, docto: null, respuesta: null, payload: null };
  }

  const datos = await getDatosItems(faltantes.map((f) => f.item));
  const lineas = faltantes.map((f) => ({
    item: f.item,
    cantidad: f.cantidad,
    costo: datos[f.item]?.costo ?? 0,
    unidadNegocio: datos[f.item]?.unidadNegocio ?? "",
  }));

  const payload = armarPayloadAjuste({
    bodega,
    co: resolverCO(bodega),
    fecha: fechaSiesa(new Date()),
    lineas,
  });

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
    validateStatus: () => true,
  });

  if (status >= 400 || !respuestaOk(data)) {
    throw new Error(`SIESA rechazó el ajuste [HTTP ${status}]: ${detalleError(data)}`);
  }

  return {
    ok: true,
    docto: String(data?.detalle?.NroDocto || data?.NroDocto || data?.nro_docto || ""),
    respuesta: data,
    payload,
  };
}
