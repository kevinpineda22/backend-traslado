/* =============================================
   Lectura de los documentos de tránsito que YA están en SIESA.

   Este módulo no escribe nada: le pregunta a SIESA qué documentos de tránsito
   existen. Resuelve dos problemas distintos que el conector solo no puede.

   1. EL CONSECUTIVO QUE NO SE PUDO LEER
      La ENTRADA (CTE) referencia a la SALIDA (CTS) por su consecutivo. Ese
      número lo asigna SIESA y viene en la respuesta del conector… salvo cuando
      no viene. Eso ya pasó: `doctoDe()` devolvía "", la entrada no se podía
      armar y el par quedaba abierto (ver sql/030). Acá lo vamos a buscar a la
      fuente: si SIESA aceptó la salida, el documento existe y tiene número.

   2. LA ENTRADA QUE HIZO OTRO
      Hasta 2026-09-03 las entradas las venía creando una persona a mano en el
      ERP — 35 de 35 despachos, mismo día, apareo 1:1. Si el sistema empieza a
      crearlas sin mirar, el destino recibe la mercancía DOS VECES. Antes de
      importar una entrada preguntamos si ya existe.

   EL HILO QUE ATA TODO son las notas del documento. `notaDoc()` estampa
   `(despacho <uuid>)` en cada documento que sube este backend; de ahí sale el
   apareo. Un documento sin uuid en las notas es de otro (traslados manuales del
   equipo de inventarios) y se ignora — no es nuestro y no debemos tocarlo.

   La consulta se registra en Connekta (no se manda SQL por HTTP); el nombre va
   en `SIESA_CONSULTA_TRANSITO`. Ver docs/CONSULTA_TRANSITO_CONNEKTA.md.
   ============================================= */

const TIPO_SALIDA = "CTS";
const TIPO_ENTRADA = "CTE";

/** Nombre de la consulta registrada en Connekta. Sin esto el módulo no opera. */
const nombreConsulta = () => String(process.env.SIESA_CONSULTA_TRANSITO || "").trim();

/**
 * Vida del cache, en ms. Existe por el rate limit de Connekta (10 llamadas por
 * ventana): el cron procesa varios despachos seguidos y sin cache cada uno
 * gastaría una llamada.
 *
 * EL COSTO, DICHO EXPLÍCITAMENTE: una entrada creada a mano en los últimos N ms
 * puede no verse todavía. Esa ventana es el riesgo real de duplicar durante la
 * transición, y por eso el default es corto. La protección definitiva no es este
 * cache: es que la persona deje de crearlas.
 */
const cacheTtlMs = () => Number(process.env.SIESA_CONSULTA_TRANSITO_TTL_MS) || 30_000;

/**
 * Documentos que se traen EN UNA SOLA PÁGINA. No es una preferencia: es una
 * corrección.
 *
 * ── POR QUÉ NO SE PAGINA (2026-09-04) ──
 * La consulta registrada en Connekta NO puede llevar `ORDER BY` — Connekta lo
 * rechaza con un 500 de sintaxis (ver docs/CONSULTA_TRANSITO_CONNEKTA.md). Y sin
 * ORDER BY, SQL Server no garantiza NINGÚN orden entre una página y la siguiente:
 * pedir "página 1" y después "página 2" puede devolver filas repetidas de la
 * primera y, peor, SALTEARSE otras que no aparecen en ninguna.
 *
 * Eso no es teórico. Con 113 filas en 2 páginas, en una misma mañana:
 *   · la CTS 1757 y la CTE 1421 volvieron DOS veces (fila repetida entre páginas);
 *   · las CTE 1412, 1413 y 1415 no volvieron NUNCA, y el verificador reportó tres
 *     pares abiertos que estaban cerrados desde el 29 de agosto;
 *   · dos corridas seguidas dieron totales distintos (44/34 y 39/32 documentos).
 *
 * La fila repetida la tapa `indexar` (ver el Set `vistos`). La fila SALTEADA no la
 * tapa nada, y es la peligrosa: si la entrada de un despacho no viene,
 * `verificarEntradaPrevia` responde "no existe" y el sistema crea una SEGUNDA
 * entrada. Inventario duplicado en la tienda destino, por un renglón que el motor
 * decidió no mandar.
 *
 * Una sola página no tiene el problema: no hay "entre páginas" donde perderse.
 * Si algún día el universo no entra en una, `consultarTransito` lo detecta y
 * grita en vez de devolver datos incompletos en silencio.
 *
 * ── 1000 ES EL TECHO DE CONNEKTA, NO UNA ELECCIÓN ──
 * Pedir más devuelve un HTTP 400: "El valor de tamPag no puede superar los 1000
 * registros". Así que este número NO se sube. Cuando los documentos de la ventana
 * pasen de 1000 hay DOS salidas, en este orden:
 *
 *   1. ACHICAR la ventana de fechas del SQL. Es la barata y la que hay que probar
 *      primero: hoy son 60 días para ~113 documentos, y el apareo solo necesita
 *      cubrir los despachos que todavía puedan estar abiertos.
 *
 *   2. DARLE ORDEN A LA CONSULTA, y recién ahí volver a paginar. "Connekta no
 *      acepta ORDER BY" es media verdad, y conviene tenerla completa ANTES de
 *      quedarse sin ventana que achicar: lo que rechaza con un 500 es el ORDER BY
 *      DESNUDO, porque envuelve la consulta en una subconsulta y SQL Server no
 *      ordena ahí sin TOP/OFFSET. Con `OFFSET 0 ROWS` al final SÍ lo acepta — es
 *      lo que arregló `merkahorro_traslados_dev` y lo que hace que sus 77 páginas
 *      sean determinísticas (docs/CONTEXTO-Y-PENDIENTES-TRASLADOS.md §4.1). Para
 *      ésta sería:
 *
 *        ORDER BY D.f350_id_co, D.f350_id_tipo_docto, D.f350_consec_docto
 *        OFFSET 0 ROWS
 *
 *      Ojo con el efecto colateral: editar una consulta en Connekta le RESETEA los
 *      permisos, y hay que re-asignar nuestro consumidor o vuelve el 401 (que
 *      Connekta reporta igual que "esa consulta no existe").
 */
const TAM_PAGINA = 1000;

const RE_DESPACHO =
  /despacho\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/**
 * Saca el id de despacho de las notas de un documento de SIESA.
 *
 * Ojo con una sutileza que confunde al leer los datos crudos: las notas de la
 * ENTRADA también dicen "Traslado salida …". SIESA hereda las notas del
 * documento base al recibir el tránsito, así que el texto NO dice qué cara es —
 * eso lo dice el tipo de documento. Acá solo nos interesa el uuid.
 *
 * @param {string} notas - `f350_notas` del documento
 * @returns {string|null} uuid en minúsculas, o null si el documento no es nuestro
 */
export function despachoIdDeNotas(notas) {
  const m = RE_DESPACHO.exec(String(notas || ""));
  return m ? m[1].toLowerCase() : null;
}

/** ¿Está configurada la consulta? Sin nombre no se puede preguntar nada. */
export const consultaConfigurada = () => Boolean(nombreConsulta());

/** Error propio: distingue "no pude preguntar" de "pregunté y no hay". */
export class ConsultaTransitoError extends Error {
  constructor(mensaje, causa) {
    super(mensaje, causa ? { cause: causa } : undefined);
    this.name = "ConsultaTransitoError";
  }
}

let cache = null; // { at:number, salidas:Map, entradas:Map }

/**
 * Arma los dos índices (uuid → LISTA de documentos) a partir de las filas crudas.
 *
 * POR QUÉ UNA LISTA Y NO UN DOCUMENTO. Un despacho debería tener uno por cara,
 * pero en SIESA hay despachos con TRES salidas: son los duplicados que dejó el
 * bug del 19/08 (ver sql/030), y siguen ahí hasta que alguien los borre a mano.
 * Un mapa plano se quedaba con el primero que llegara — y como la consulta no
 * lleva ORDER BY, "el primero" es el que quiso el motor esa vez. Elegir un
 * consecutivo al azar para referenciarlo en la entrada es escribir mal en el ERP.
 *
 * Acá se guardan todos, ordenados por consecutivo para que el resultado sea
 * estable entre corridas. Qué hacer con los duplicados lo decide cada consulta:
 * no es lo mismo la salida (hay que ELEGIR una) que la entrada (solo importa si
 * EXISTE alguna).
 */
function indexar(filas) {
  const salidas = new Map();
  const entradas = new Map();
  // Un documento ya visto, por su identidad real. Ver la nota de abajo.
  const vistos = new Set();

  for (const f of filas) {
    const id = despachoIdDeNotas(f?.Notas);
    if (!id) continue; // documento manual del equipo de inventarios: no es nuestro

    const tipo = String(f?.Tipo || "").trim().toUpperCase();
    const indice = tipo === TIPO_SALIDA ? salidas : tipo === TIPO_ENTRADA ? entradas : null;
    if (!indice) continue;

    const nro = String(f?.Nro ?? "").trim();
    if (!nro || nro === "0") continue; // sin consecutivo no sirve para nada

    const co = String(f?.CO ?? "").trim();

    // UNA FILA REPETIDA NO ES UN DOCUMENTO REPETIDO.
    //
    // La identidad de un documento en SIESA es (C.O., tipo, consecutivo): es su
    // llave, no puede haber dos. Así que dos filas con el MISMO número son la
    // misma fila devuelta dos veces por la consulta, no dos documentos.
    //
    // Sin este filtro (2026-09-04) el verificador informaba "CTS 1757, 1757" y
    // "CTE 1419, 1419" como duplicados y pedía borrar las sobrantes — sobre
    // traslados sanos. Anular uno de esos habría roto un par que estaba bien.
    // Los duplicados de verdad son los del 19/08, y se ven solos: llevan números
    // DISTINTOS (CTS 4773, 4775, 4777).
    //
    // Además rompía funcionalidad, no solo el reporte: `buscarSalida` se niega a
    // elegir cuando ve más de una salida, así que un documento contado dos veces
    // dejaba al despacho sin consecutivo que referenciar.
    const clave = `${tipo}|${co}|${nro}`;
    if (vistos.has(clave)) continue;
    vistos.add(clave);

    const doc = { nro, co, fecha: f?.Fecha ?? null };
    const lista = indice.get(id);
    if (lista) lista.push(doc);
    else indice.set(id, [doc]);
  }

  // Orden estable por consecutivo. Sin esto el resultado depende del orden en que
  // Connekta devolvió las filas, que no está garantizado.
  const porNro = (a, b) =>
    Number(a.nro) - Number(b.nro) || String(a.nro).localeCompare(String(b.nro));
  for (const indice of [salidas, entradas]) {
    for (const lista of indice.values()) lista.sort(porNro);
  }

  return { salidas, entradas };
}

/**
 * Trae el estado del tránsito desde SIESA (con cache).
 *
 * @param {object} [opts]
 * @param {boolean} [opts.refrescar] - ignora el cache y vuelve a preguntar
 * @returns {Promise<{ salidas: Map<string,object>, entradas: Map<string,object> }>}
 * @throws {ConsultaTransitoError} si no está configurada o Connekta no responde
 */
export async function consultarTransito({ refrescar = false } = {}) {
  const nombre = nombreConsulta();
  if (!nombre) {
    throw new ConsultaTransitoError(
      "Falta SIESA_CONSULTA_TRANSITO: no se puede leer el estado del tránsito en SIESA.",
    );
  }

  if (!refrescar && cache && Date.now() - cache.at < cacheTtlMs()) {
    return { salidas: cache.salidas, entradas: cache.entradas };
  }

  let res;
  try {
    // IMPORT PEREZOSO A PROPÓSITO. `config/connekta.js` hace `process.exit(1)` al
    // cargarse si le faltan credenciales. Importarlo arriba haría que requisicion
    // .service (que ahora depende de este módulo) mate el proceso al arrancar en
    // cualquier entorno sin Connekta configurado — tests incluidos. Acá adentro,
    // el costo de esa config solo lo paga quien realmente va a consultar.
    const { ejecutarConsulta } = await import("../config/connekta.js");
    // UNA sola página, a propósito. Ver TAM_PAGINA: paginar sin ORDER BY saltea
    // filas, y una entrada que no llega hace que el sistema cree una segunda.
    res = await ejecutarConsulta(nombre, 1, TAM_PAGINA);
  } catch (e) {
    // Connekta devuelve el MISMO 401 para "sin permiso" y para "no existe esa
    // consulta". El mensaje lo dice para que nadie pierda una tarde con eso.
    throw new ConsultaTransitoError(
      `No se pudo leer el tránsito de SIESA con la consulta "${nombre}": ${e.message}. ` +
        `Un 401 acá significa que la consulta no existe con ese nombre O que nuestro ` +
        `conniKey no la tiene asignada — Connekta no distingue los dos casos.`,
      e,
    );
  }

  // LA LECTURA TIENE QUE SER COMPLETA O NO SIRVE.
  //
  // Todo lo que cuelga de esta consulta —el guard anti-duplicado, la recuperación
  // del consecutivo, la verificación del cierre manual— responde "no existe"
  // cuando un documento no llega. Y "no existe" es la respuesta que autoriza a
  // ESCRIBIR en el ERP. Devolver una lectura parcial en silencio es peor que no
  // leer nada: quien pregunta cree que sabe.
  //
  // Con más de una página estamos otra vez en el terreno del orden inestable, así
  // que se corta acá y se dice qué hacer. Frenar la entrada automática por esto es
  // exactamente lo correcto.
  if (res.totalPaginas > 1) {
    throw new ConsultaTransitoError(
      `La consulta "${nombre}" devolvió ${res.total} documentos y no entran en una página de ` +
        `${TAM_PAGINA}. Sin un ORDER BY estable el motor saltea filas entre páginas, y una ` +
        `entrada que no llega hace que el sistema cree una segunda. TAM_PAGINA no se puede ` +
        `subir: 1000 es el tope de Connekta. Salidas, en orden: ACHICAR la ventana de fechas ` +
        `del SQL (hoy son 60 días), o agregarle a la consulta ` +
        `"ORDER BY D.f350_id_co, D.f350_id_tipo_docto, D.f350_consec_docto OFFSET 0 ROWS" ` +
        `(el OFFSET es lo que Connekta necesita para aceptarlo) y volver a paginar.`,
    );
  }

  const { salidas, entradas } = indexar(res.datos || []);
  cache = { at: Date.now(), salidas, entradas };

  return { salidas, entradas };
}

/**
 * Consecutivo de la SALIDA (CTS) que SIESA le asignó a este despacho.
 *
 * ANTE UN DUPLICADO, NO ELIGE: devuelve null. Acá hay que quedarse con UN
 * consecutivo para que la entrada lo referencie, y si hay tres salidas del mismo
 * despacho no existe forma de saber cuál es la buena — el más bajo es el
 * original, pero puede ser justo el que anularon. Devolver null hace que el
 * despacho quede 'pendiente' con el motivo en el log, que es lo correcto: esto
 * lo resuelve una persona borrando los duplicados en SIESA, no una heurística.
 *
 * @returns {Promise<object|null>} `{ nro, co, fecha }` o null si no está o es ambiguo
 */
export async function buscarSalida(despachoId, opts) {
  const { salidas } = await consultarTransito(opts);
  const docs = salidas.get(String(despachoId).toLowerCase());
  if (!docs || docs.length === 0) return null;

  if (docs.length > 1) {
    console.warn(
      `[transito] ⚠️ despacho ${despachoId} tiene ${docs.length} SALIDAS en SIESA ` +
        `(${docs.map((d) => d.nro).join(", ")}) — son duplicados del bug de agosto. ` +
        `No se elige ninguna: hay que borrar las sobrantes en SIESA.`,
    );
    return null;
  }
  return docs[0];
}

/**
 * ¿SIESA ya tiene alguna salida de este despacho? Pregunta de EXISTENCIA.
 *
 * Es distinta de `buscarSalida` a propósito, y la diferencia importa. Aquella
 * contesta "cuál consecutivo referencio" y ante un duplicado devuelve null
 * porque no se puede elegir. Ésta contesta "¿la salida ya se mandó?", y ahí un
 * duplicado es un SÍ todavía más rotundo — devolver null haría que el sistema
 * mande otra.
 *
 * Usarla para decidir si mandar la salida. Usar `buscarSalida` para armar la
 * entrada. Confundirlas es el bug que esta función existe para evitar.
 *
 * @returns {Promise<boolean>}
 */
export async function existeSalida(despachoId, opts) {
  const { salidas } = await consultarTransito(opts);
  const docs = salidas.get(String(despachoId).toLowerCase());
  return Boolean(docs && docs.length > 0);
}

/**
 * ENTRADA (CTE) que ya existe para este despacho — la haya hecho este backend o
 * una persona en el ERP. Si devuelve algo, NO hay que importar otra.
 *
 * ANTE UN DUPLICADO, SÍ DEVUELVE UNA. La pregunta que contesta esta función no es
 * "cuál es la entrada buena" sino "¿ya hay alguna?". Con dos entradas la
 * respuesta sigue siendo sí, y frenar por ambigüedad haría que el sistema cree
 * una TERCERA — exactamente lo que este guard existe para impedir.
 *
 * @returns {Promise<object|null>} `{ nro, co, fecha }` o null si no hay ninguna
 */
export async function buscarEntrada(despachoId, opts) {
  const { entradas } = await consultarTransito(opts);
  const docs = entradas.get(String(despachoId).toLowerCase());
  if (!docs || docs.length === 0) return null;

  if (docs.length > 1) {
    console.warn(
      `[transito] ⚠️ despacho ${despachoId} tiene ${docs.length} ENTRADAS en SIESA ` +
        `(${docs.map((d) => d.nro).join(", ")}). El inventario del destino entró de más; ` +
        `hay que revisarlo. No se crea ninguna más.`,
    );
  }
  return docs[0];
}

/** Vacía el cache. Para los tests y para forzar una relectura tras un cambio. */
export function invalidarCache() {
  cache = null;
}
