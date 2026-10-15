import { listar, normCodigo, actualizarCapacidadLote } from "../models/Capacidad.model.js";
import { createError } from "../middleware/errorHandler.js";

/* =============================================
   Capacidad de góndola medida por SRI — comparación en modo DRY-RUN.

   SRI mide la góndola (caras × profundidad × altura × factor de empaque) y la
   expone por una API de solo lectura. Este módulo trae esa medición, la cruza con
   `traslados_capacidad` y devuelve un REPORTE de lo que cambiaría. Nada más.

   POR QUÉ LA COMPARACIÓN NO ESCRIBE
   Existe para que una persona vea el impacto antes de que algo toque la tabla. Un
   número de capacidad mal convertido rompe el sugerido A/B/C en traslados reales,
   y deshacerlo exige saber cuál era el valor anterior. Por eso `compararConSri`
   solo lee. La ÚNICA función que escribe es `aplicarConSri` (al final del
   archivo), y solo escribe lo que ese mismo reporte listó, con confirmación.

   POR QUÉ LA COMPARACIÓN ES UNA FUNCIÓN PURA APARTE DEL CLIENTE HTTP
   Toda la lógica que puede equivocarse (conversión de unidades, mapeo de claves,
   clasificación de casos) vive en `compararCapacidad`, que recibe datos y devuelve
   datos. Así se prueba entera sin red y sin base. El cliente HTTP queda tan
   delgado que casi no tiene lógica propia que probar.
   ============================================= */

const URL_BASE_DEFECTO =
  "https://sri.merkahorro.com/lector_barras/api_consulta_capacidad_gondolas.php";

// POR QUÉ UN SOLO LUGAR PARA LA TIENDA
// El flujo Llano va 00301 → 00401 y SRI lo conoce por este nombre. Si el literal
// estuviera en el controlador, en el servicio y en los tests, renombrar la tienda
// en SRI obligaría a cambiar tres sitios y olvidar uno daría un reporte vacío en
// lugar de un error.
const TIENDA_DEFECTO = "GIRARDOTA LLANO";

const TIMEOUT_MS = 20_000;
const LIMITE_POR_PAGINA = 500; // máximo que acepta SRI

// POR QUÉ UN TOPE DE PÁGINAS
// `total_paginas` viene de un servicio externo. Si llegara corrupto (un número
// enorme), el ciclo de paginación mantendría el proceso pidiendo páginas sin fin.
// 200 páginas × 500 = 100 mil ítems, muy por encima de cualquier surtido real.
const MAX_PAGINAS = 200;

// Las capacidades se comparan con tolerancia para que el ruido de coma flotante
// (por ejemplo 2076 / 15) no aparezca como un "cambio" en el reporte.
const EPSILON = 1e-6;

const num = (v) => Number(v);
const redondear = (n) => Math.round(n * 1e4) / 1e4;

/** Tienda por defecto, configurable sin tocar código. */
export function tiendaPorDefecto() {
  return String(process.env.SRI_CAPACIDAD_TIENDA || "").trim() || TIENDA_DEFECTO;
}

/* =============================================
   CLIENTE HTTP (solo GET)
   ============================================= */

/**
 * Traduce un fallo de SRI a un error entendible para quien opera el sistema.
 * Un "Error 401" no dice qué hacer; "el token está mal o vencido" sí.
 *
 * Los errores de SRI se devuelven como 502 y no con el mismo código: si SRI
 * contesta 401, el que falló es el token que nosotros le mandamos, y un 401 hacia
 * el front se leería como "tu sesión venció".
 */
function errorDeSri(status, codigoSri) {
  const codigo = String(codigoSri || "").toUpperCase();
  if (status === 401 || codigo === "UNAUTHORIZED") {
    return createError(
      502,
      "SRI rechazó las credenciales: el token SRI_CAPACIDAD_TOKEN está mal o vencido.",
    );
  }
  if (status === 503 || codigo === "API_NOT_CONFIGURED") {
    return createError(502, "La API de capacidad de SRI no está configurada de su lado (API_NOT_CONFIGURED).");
  }
  if (status === 422 || codigo === "STORE_REQUIRED" || codigo === "INVALID_PARAMETER") {
    return createError(
      400,
      `SRI no aceptó los parámetros de la consulta (${codigo || "422"}). Revisá el nombre de la tienda.`,
    );
  }
  if (status === 404 || codigo === "ITEM_NOT_FOUND") {
    return createError(502, "SRI respondió que el recurso no existe (ITEM_NOT_FOUND).");
  }
  if (status === 405 || codigo === "METHOD_NOT_ALLOWED") {
    return createError(502, "SRI rechazó el método HTTP (METHOD_NOT_ALLOWED): el cliente solo debe usar GET.");
  }
  return createError(502, `SRI respondió con un error inesperado (HTTP ${status}).`);
}

/**
 * GET autenticado contra SRI.
 *
 * El token viaja SOLO en el header. Nunca se arma la URL con él ni se incluye en
 * ningún mensaje de error: un log con la llave la deja legible para cualquiera con
 * acceso a los logs.
 */
async function pedirSri(parametros, { fetchImpl = fetch } = {}) {
  const token = String(process.env.SRI_CAPACIDAD_TOKEN || "").trim();
  // Se valida ANTES de pedir: sin token la request fallaría con un 401 que
  // parece un problema de SRI cuando en realidad es de configuración nuestra.
  if (!token) {
    throw createError(
      503,
      "Falta la variable de entorno SRI_CAPACIDAD_TOKEN. Pedile el token a SRI y cargalo en el .env del backend.",
    );
  }

  const base = String(process.env.SRI_CAPACIDAD_URL || "").trim() || URL_BASE_DEFECTO;
  const url = new URL(base);
  for (const [k, v] of Object.entries(parametros)) url.searchParams.set(k, String(v));

  let respuesta;
  try {
    respuesta = await fetchImpl(url, {
      method: "GET",
      headers: { "X-API-Key": token, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      throw createError(504, `SRI no respondió en ${TIMEOUT_MS / 1000} segundos.`);
    }
    // Se usa `err.cause?.code` y no `err.message` completo: el mensaje de fetch
    // puede traer la URL y nos interesa controlar exactamente qué se escribe.
    throw createError(502, `No se pudo contactar a SRI (${err?.cause?.code || "error de red"}).`);
  }

  let cuerpo = null;
  try {
    cuerpo = await respuesta.json();
  } catch {
    cuerpo = null; // cuerpo no JSON: se resuelve abajo según el status
  }

  if (!respuesta.ok || cuerpo?.ok === false) {
    const codigoSri = cuerpo?.error?.codigo ?? cuerpo?.codigo ?? cuerpo?.error;
    throw errorDeSri(respuesta.status, typeof codigoSri === "string" ? codigoSri : "");
  }
  if (!cuerpo || typeof cuerpo !== "object") {
    throw createError(502, "SRI respondió algo que no es JSON.");
  }
  return cuerpo;
}

/**
 * Extrae ítems y total de páginas de una respuesta paginada.
 *
 * Es el ÚNICO lugar que conoce el sobre de la respuesta paginada. Si SRI lo
 * nombra distinto a lo esperado, falla fuerte y acá, en lugar de devolver un
 * reporte vacío que se lea como "no hay diferencias".
 *
 * LA FORMA REAL, VERIFICADA CONTRA EL CÓDIGO DE SRI
 * El sobre es `data.items` y `data.paginacion.total_paginas` — confirmado en
 * `lector_barras/api_consulta_capacidad_gondolas.php`, donde la respuesta se
 * arma con las claves `paginacion` e `items` dentro de `data`. La documentación
 * de la API no lo especifica, así que se deja anotado para no tener que volver
 * a leer el PHP.
 *
 * Se acepta además `data.total_paginas` sin anidar: no cuesta nada y cubre el
 * caso de que SRI aplane el sobre en alguna versión futura.
 */
function leerPagina(cuerpo) {
  const data = cuerpo?.data;
  const items = data?.items;
  const total = data?.paginacion?.total_paginas ?? data?.total_paginas;
  if (!Array.isArray(items) || !Number.isFinite(Number(total))) {
    throw createError(
      502,
      "La respuesta paginada de SRI no trae la forma esperada " +
        "(se esperaba data.items y data.paginacion.total_paginas).",
    );
  }
  return { items, totalPaginas: Number(total) };
}

/**
 * Trae TODOS los ítems de una tienda, recorriendo las páginas.
 * @returns {Promise<Array<object>>}
 */
export async function obtenerItemsSri({ tienda = tiendaPorDefecto(), fetchImpl } = {}) {
  const todos = [];
  let pagina = 1;
  let totalPaginas = 1;

  do {
    const cuerpo = await pedirSri({ tienda, pagina, limite: LIMITE_POR_PAGINA }, { fetchImpl });
    const leida = leerPagina(cuerpo);
    todos.push(...leida.items);
    totalPaginas = leida.totalPaginas;
    if (totalPaginas > MAX_PAGINAS) {
      throw createError(
        502,
        `SRI informa ${totalPaginas} páginas, más que el tope de seguridad (${MAX_PAGINAS}). Se aborta.`,
      );
    }
    pagina += 1;
  } while (pagina <= totalPaginas);

  return todos;
}

/* =============================================
   COMPARACIÓN (pura: sin red, sin base)
   ============================================= */

// POR QUÉ "UND" DE SRI YA NO SE MAPEA A NUESTRA FILA BASE (unidad "")
// SRI PARTICIONA la capacidad de un ítem por ubicación: cada rebanada de
// `capacidades_por_unidad_medida` guarda SOLO lo de las ubicaciones medidas en esa
// unidad de medida, y la suma de todas las rebanadas da `capacidad_total_tienda`.
// La rebanada "UND" es, por tanto, únicamente la parte de las ubicaciones que no
// tienen unidad de medida. NUESTRA fila base (sql/007_capacidad_multi_um.sql), en
// cambio, GUARDA EL TOTAL del ítem en unidades.
//
// Caso real, ítem 901 "SALCHICHAS ZENU VIENA TRAD X 150 GR":
//     capacidad_total_tienda 90 = rebanada P3 (54) + rebanada UND (36)
//     nuestra fila base: 90  ← ya era correcta
// Mapear UND → "" proponía 36 y habría pisado un 90 correcto. En el dry-run real
// 23 de 33 cambios sobre ítems con varias rebanadas eran de este tipo (por ej.
// 3269: 223 → 7). NO "arreglar" de vuelta al mapeo ingenuo: la fila base se compara
// contra `capacidad_total_tienda`, ver `compararCapacidad`.
//
// Las filas nuestras CON unidad de medida sí se comparan contra su rebanada
// homónima, y una fila nuestra con unidad "UND" literal también matchea por
// nombre. La comparación ignora mayúsculas y espacios para no perder un match por
// un "p15 ".
const claveUnidadSri = (um) => String(um ?? "").trim().toUpperCase();
const claveUnidadNuestra = (u) => String(u ?? "").trim().toUpperCase();

const claveCodigoNumerica = (c) => {
  const n = Number(c);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
};

/**
 * Cruza lo que mide SRI con lo que tenemos y arma el reporte. No escribe nada.
 *
 * CONVERSIÓN DE UNIDADES (el punto delicado)
 * SRI calcula `capacidad_total` EN UNIDADES BASE equivalentes. Nuestra tabla
 * guarda la capacidad EN LA UM de la fila, y el sistema la lleva a base con
 * `capacidadBase = capacidadUM × factor` (siesa.service.js). Por eso:
 *
 *     capacidad_propuesta = capacidad_total_SRI / factor
 *
 * POR QUÉ EL FACTOR ES EL NUESTRO Y NO EL `factor_um` DE SRI
 * El resto del sistema calcula con el factor de la fila. Dividir con el de SRI
 * introduciría una segunda fuente de verdad: la capacidad guardada dejaría de
 * multiplicar de vuelta al valor que SRI midió. Si los dos factores difieren, no
 * se decide nada solo: va como AVISO para que una persona lo resuelva.
 *
 * La fila base (unidad "") usa factor 1.
 *
 * GRANULARIDAD
 * `items_sri` e `items_nuestros` cuentan ÍTEMS distintos. Todos los demás
 * contadores cuentan PARES (ítem, unidad), porque ahí es donde se decide.
 *
 * @param {Array<object>} itemsSri      ítems tal como los devuelve SRI
 * @param {Array<object>} filasNuestras filas de traslados_capacidad (con `fijo`)
 * @param {{tienda?: string, ahora?: Date}} [opciones]
 */
export function compararCapacidad(itemsSri, filasNuestras, { tienda, ahora = new Date() } = {}) {
  const cambios = [];
  const saltados = [];
  const avisos = [];
  const resumen = {
    items_sri: 0,
    items_nuestros: 0,
    cambiarian: 0,
    iguales: 0,
    saltados_fijo: 0,
    sin_factor: 0,
    solo_en_sri: 0,
    solo_nuestros: 0,
    factor_discrepante: 0,
    // POR QUÉ UN CONTADOR EXTRA
    // Una capacidad 0 (o ilegible) en SRI no se propone: pisar una capacidad con
    // 0 haría que el sugerido deje de pedir el ítem. Sin este contador esos pares
    // no figurarían en ninguna cifra y el resumen no cuadraría con el detalle.
    sin_capacidad_sri: 0,
  };

  // --- Índice de lo nuestro: código normalizado → filas -------------------
  const nuestrosPorCodigo = new Map();
  for (const fila of filasNuestras || []) {
    const codigo = normCodigo(fila.codigo_item);
    if (!codigo) continue;
    if (!nuestrosPorCodigo.has(codigo)) nuestrosPorCodigo.set(codigo, []);
    nuestrosPorCodigo.get(codigo).push(fila);
  }

  // --- Índice de SRI: código normalizado → { descripcion, porUnidad } -----
  const sriPorCodigo = new Map();
  for (const item of itemsSri || []) {
    const codigo = normCodigo(item.item);
    if (!codigo) continue;
    if (!sriPorCodigo.has(codigo)) {
      sriPorCodigo.set(codigo, {
        descripcion: item.descripcion ?? "",
        porUnidad: new Map(),
        totalTienda: null,
      });
    }
    const destino = sriPorCodigo.get(codigo);
    for (const entrada of item.capacidades_por_unidad_medida || []) {
      destino.porUnidad.set(claveUnidadSri(entrada.unidad_medida), entrada);
    }
    // Total consolidado del ítem: es lo que se compara contra nuestra fila base.
    // Si SRI no lo trajera, la suma de las rebanadas es equivalente (SRI particiona).
    if (destino.totalTienda === null) {
      const declarado = item.capacidad_total_tienda;
      const total = declarado === null || declarado === undefined || declarado === "" ? NaN : num(declarado);
      destino.totalTienda = Number.isFinite(total)
        ? total
        : [...destino.porUnidad.values()].reduce((acc, e) => acc + (num(e.capacidad_total) || 0), 0);
    }
  }

  resumen.items_sri = sriPorCodigo.size;
  resumen.items_nuestros = nuestrosPorCodigo.size;

  const saltar = (codigo_item, descripcion, unidad, motivo, contador) => {
    saltados.push({ codigo_item, descripcion, unidad, motivo });
    resumen[contador] += 1;
  };

  const codigos = new Set([...nuestrosPorCodigo.keys(), ...sriPorCodigo.keys()]);

  for (const codigo of codigos) {
    const filas = nuestrosPorCodigo.get(codigo) || [];
    const sri = sriPorCodigo.get(codigo);

    // Un ítem se salta ENTERO si CUALQUIERA de sus filas está fijo. Es el mismo
    // OR que usa `multi_um`: el dato es del producto y no debe depender de qué
    // fila mire la consulta (ver sql/040_capacidad_fijo.sql). Se evalúa antes que
    // todo lo demás: si una persona definió la capacidad, no importa si SRI lo
    // trae o si el factor cuadra.
    const fijo = filas.some((f) => f.fijo === true);

    // Pares (unidad) de este ítem: la unión de lo que hay de cada lado.
    // La fila base ("") se compara contra el total consolidado del ítem. Del lado
    // de SRI solo se agrega como par propio cuando no tenemos NINGUNA fila del
    // ítem (así sigue saliendo un único solo_en_sri); si tenemos filas, la base
    // entra por el lado nuestro. La rebanada "UND" de SRI NO es un par propio (ya
    // está dentro de ese total); solo cuenta si tenemos una fila "UND" literal.
    const unidadesNuestras = filas.map((f) => claveUnidadNuestra(f.unidad));
    const unidadesSri = sri
      ? [...(filas.length === 0 ? [""] : []), ...[...sri.porUnidad.keys()].filter((u) => u !== "UND" || unidadesNuestras.includes("UND"))]
      : [];
    const unidades = new Set([...unidadesNuestras, ...unidadesSri]);

    for (const unidad of [...unidades].sort()) {
      const filasDelPar = filas.filter((f) => claveUnidadNuestra(f.unidad) === unidad);
      // Fila base: entrada sintética con el TOTAL del ítem y factor 1. Las demás
      // unidades usan su rebanada homónima.
      const entrada = !sri
        ? undefined
        : unidad === ""
          ? { capacidad_total: sri.totalTienda, factor_um: 1, factor_variable: false }
          : sri.porUnidad.get(unidad);
      const descripcionSri = sri?.descripcion ?? "";

      if (fijo) {
        const base = filasDelPar[0];
        saltar(
          base?.codigo_item ?? codigo,
          base?.descripcion || descripcionSri,
          base ? String(base.unidad ?? "").trim() : unidad,
          "fijo",
          "saltados_fijo",
        );
        continue;
      }

      if (filasDelPar.length === 0) {
        // SRI lo mide y no tenemos fila. Es un candidato a crear, pero crear es
        // escribir, y este corte no escribe.
        saltar(codigo, descripcionSri, unidad, "solo_en_sri", "solo_en_sri");
        continue;
      }

      if (!entrada) {
        for (const f of filasDelPar) {
          saltar(f.codigo_item, f.descripcion || descripcionSri, String(f.unidad ?? "").trim(), "solo_nuestros", "solo_nuestros");
        }
        continue;
      }

      // Dos filas que normalizan al mismo par (p. ej. "0000019" y "19") no
      // deberían existir. Se avisa en lugar de elegir una en silencio.
      if (filasDelPar.length > 1) {
        avisos.push({
          codigo_item: codigo,
          unidad,
          aviso: `Hay ${filasDelPar.length} filas que normalizan al mismo ítem y unidad; se reporta cada una.`,
        });
      }

      for (const fila of filasDelPar) {
        const unidadFila = String(fila.unidad ?? "").trim();
        const descripcion = fila.descripcion || descripcionSri;

        // Factor NUESTRO. La fila base no tiene factor guardado: es 1.
        const factor = unidad === "" ? 1 : num(fila.factor);
        if (!(factor > 0)) {
          saltar(fila.codigo_item, descripcion, unidadFila, "sin_factor", "sin_factor");
          continue;
        }

        // Los avisos que no dependen de la capacidad van primero para que
        // aparezcan aunque el par termine sin cambio.
        const factorSri = num(entrada.factor_um);
        if (Number.isFinite(factorSri) && factorSri > 0 && Math.abs(factorSri - factor) > EPSILON) {
          resumen.factor_discrepante += 1;
          avisos.push({
            codigo_item: fila.codigo_item,
            unidad: unidadFila,
            aviso: `Factor discrepante: el nuestro es ${factor} y el de SRI es ${factorSri}. Se usó el nuestro para dividir.`,
          });
        }
        if (entrada.factor_variable === true) {
          avisos.push({
            codigo_item: fila.codigo_item,
            unidad: unidadFila,
            aviso: `SRI marca el factor como variable (entre ${entrada.factor_min} y ${entrada.factor_max}); la conversión es aproximada.`,
          });
        }

        const totalSri = num(entrada.capacidad_total);
        if (!Number.isFinite(totalSri) || totalSri <= 0) {
          resumen.sin_capacidad_sri += 1;
          avisos.push({
            codigo_item: fila.codigo_item,
            unidad: unidadFila,
            aviso:
              Number.isFinite(totalSri) && totalSri === 0
                ? "SRI informa capacidad_total 0; no se propone pisar la capacidad actual con 0."
                : "SRI trae una capacidad_total ilegible; no se propone ningún cambio.",
          });
          continue;
        }

        // La fila base recibe un total consolidado: quien revise el reporte debe
        // saber que no salió de una sola medición.
        if (unidad === "" && sri.porUnidad.size > 1) {
          avisos.push({
            codigo_item: fila.codigo_item,
            unidad: unidadFila,
            // DICE "UNIDADES DE MEDIDA", NO "UBICACIONES"
            // `porUnidad.size` cuenta rebanadas por UM, y cada rebanada puede
            // abarcar varias ubicaciones físicas (SRI las cuenta aparte, en
            // `cantidad_ubicaciones`). Llamarlas "ubicaciones" haría que quien
            // revisa el reporte compare este número contra el de góndolas y
            // concluya que algo no cuadra.
            aviso: `SRI mide este ítem en ${sri.porUnidad.size} unidades de medida distintas (${[...sri.porUnidad.keys()].join(", ")}); la capacidad propuesta es la SUMA de todas.`,
          });
        }

        const actual = num(fila.capacidad) || 0;
        const propuesta = redondear(totalSri / factor);

        if (!Number.isInteger(propuesta)) {
          avisos.push({
            codigo_item: fila.codigo_item,
            unidad: unidadFila,
            aviso: `La capacidad propuesta (${propuesta}) no es entera: ${totalSri} no es múltiplo del factor ${factor}.`,
          });
        }

        if (Math.abs(propuesta - actual) <= EPSILON) {
          resumen.iguales += 1;
          continue;
        }

        cambios.push({
          codigo_item: fila.codigo_item,
          descripcion,
          unidad: unidadFila,
          capacidad_actual: actual,
          capacidad_propuesta: propuesta,
          diferencia: redondear(propuesta - actual),
          factor,
        });
      }
    }
  }

  // Orden estable para que dos corridas sobre los mismos datos den el mismo
  // reporte y se puedan comparar a ojo.
  const porCodigoYUnidad = (a, b) =>
    claveCodigoNumerica(normCodigo(a.codigo_item)) - claveCodigoNumerica(normCodigo(b.codigo_item)) ||
    String(a.unidad).localeCompare(String(b.unidad));
  cambios.sort(porCodigoYUnidad);
  saltados.sort(porCodigoYUnidad);
  avisos.sort(porCodigoYUnidad);

  resumen.cambiarian = cambios.length;

  return {
    ok: true,
    tienda: tienda ?? tiendaPorDefecto(),
    consultado_en: ahora.toISOString(),
    resumen,
    cambios,
    saltados,
    avisos,
  };
}

/* =============================================
   ORQUESTACIÓN (lee SRI, lee nuestra tabla, compara)
   ============================================= */

/**
 * Genera el reporte dry-run. Solo lee: dos lecturas (SRI y `traslados_capacidad`)
 * y una comparación en memoria.
 */
export async function compararConSri({ tienda, fetchImpl, filas: filasLeidas } = {}) {
  const tiendaFinal = String(tienda || "").trim() || tiendaPorDefecto();
  // SRI primero: si el token falta o está vencido, se falla sin haber leído la
  // tabla entera por nada.
  const itemsSri = await obtenerItemsSri({ tienda: tiendaFinal, fetchImpl });
  // `filas` solo lo pasa `aplicarConSri`, para que la comparación y la guarda de
  // `fijo` trabajen sobre la MISMA lectura de la tabla. Sin él, se lee aquí.
  const filas = filasLeidas ?? (await listar());
  return compararCapacidad(itemsSri, filas, { tienda: tiendaFinal });
}

/* =============================================
   APLICAR (la ÚNICA función de esta integración que escribe)
   ============================================= */

// Tamaño de tanda: lo bastante chico para que una falla frene pronto y se sepa
// exactamente dónde quedó, lo bastante grande para no hacer 500 viajes seriales.
const TAMANO_TANDA = 50;

/**
 * Aplica a `traslados_capacidad` EXACTAMENTE las filas de `cambios` del reporte.
 *
 * Reusa `compararConSri` (la misma función que genera el reporte revisado): no hay
 * una segunda comparación que pueda diferir de la que una persona leyó.
 *
 * @param {{tienda?: string, esperados?: unknown, fetchImpl?: Function, comparar?: Function, ahora?: Date}} opciones
 *   `comparar` es inyectable solo para poder forzar casos en tests.
 */
export async function aplicarConSri({ tienda, esperados, fetchImpl, comparar = compararConSri, ahora = new Date() } = {}) {
  // Se valida ANTES de leer SRI: un body mal formado no debe costar tráfico ni
  // dejar la duda de si algo se escribió.
  if (typeof esperados !== "number" || !Number.isInteger(esperados) || esperados < 0) {
    throw createError(
      400,
      "Falta `esperados` en el body: debe ser un entero con la cantidad de cambios del reporte que revisaste.",
    );
  }

  const filas = await listar();
  const reporte = await comparar({ tienda, fetchImpl, filas });
  const cambios = reporte.cambios;

  // POR QUÉ `esperados` ES OBLIGATORIO
  // Entre que una persona revisa el reporte y decide aplicar, SRI puede haber
  // cambiado. Aplicar un conjunto distinto del que se revisó es exactamente el
  // accidente que esta integración tiene que evitar. Si el número de hoy no es el
  // que se vio, no se escribe nada y se vuelve a revisar.
  if (cambios.length !== esperados) {
    throw createError(
      409,
      `El reporte cambió desde que lo revisaste: esperabas ${esperados} cambios y ahora hay ${cambios.length}. No se escribió nada; vuelve a consultar /comparar.`,
    );
  }

  // POR QUÉ UNA GUARDA QUE REPITE LO QUE `compararCapacidad` YA HACE
  // Los ítems con `fijo = true` son capacidades que una persona definió a mano y
  // que el negocio pidió explícitamente no tocar. La comparación ya los excluye,
  // pero una guarda redundante contra un bug futuro en ella cuesta diez líneas;
  // recuperarse de haberlas pisado en silencio cuesta mucho más. Mismo criterio
  // que la comparación: el ítem entero está protegido si CUALQUIERA de sus filas
  // es fija, y los códigos se normalizan (ceros a la izquierda).
  const fijos = new Set(filas.filter((f) => f.fijo === true).map((f) => normCodigo(f.codigo_item)));
  const infractores = cambios.filter((c) => fijos.has(normCodigo(c.codigo_item)));
  if (infractores.length > 0) {
    const codigos = [...new Set(infractores.map((c) => c.codigo_item))];
    throw createError(
      500,
      `Abortado sin escribir nada: ${codigos.length} ítem(s) con fijo = true aparecen en los cambios (${codigos.join(", ")}). Es un bug en la comparación.`,
    );
  }

  const escritos = [];
  const fallidos = [];
  let noIntentados = 0;

  for (let i = 0; i < cambios.length; i += TAMANO_TANDA) {
    const tanda = cambios.slice(i, i + TAMANO_TANDA);
    const { escritas, fallidas } = await actualizarCapacidadLote(
      tanda.map((c) => ({ codigo_item: c.codigo_item, unidad: c.unidad, capacidad: c.capacidad_propuesta })),
    );
    const anteriorPor = new Map(tanda.map((c) => [`${c.codigo_item}|${c.unidad}`, c]));
    for (const e of escritas) {
      const c = anteriorPor.get(`${e.codigo_item}|${e.unidad}`);
      escritos.push({
        codigo_item: e.codigo_item,
        unidad: e.unidad,
        capacidad_anterior: c.capacidad_actual,
        capacidad_nueva: e.capacidad,
      });
    }
    if (fallidas.length > 0) {
      fallidos.push(...fallidas);
      // Se frena: seguir escribiendo a ciegas tras una falla deja una tabla a
      // medias que nadie revisó.
      noIntentados = cambios.length - i - tanda.length;
      break;
    }
  }

  return {
    ok: fallidos.length === 0,
    tienda: reporte.tienda,
    aplicado_en: ahora.toISOString(),
    esperados,
    aplicados: escritos.length,
    resumen: reporte.resumen,
    escritos,
    fallidos,
    ...(fallidos.length > 0 && { no_intentados: noIntentados }),
  };
}
