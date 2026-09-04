import { supabase } from "../config/supabase.js";
import * as DespachoModel from "../models/Despacho.model.js";
import { FLUJOS } from "../config/flujos.js";
import { tomarLock, liberarLock } from "./lock.service.js";
import {
  importarSalida,
  importarEntrada,
  ConfigSiesaError,
  configFaltante,
} from "./siesaRequisicion.service.js";
import {
  importarAjuste,
  detectarFaltantes,
  ajusteAutoHabilitado,
} from "./siesaAjuste.service.js";
import {
  buscarSalida,
  buscarEntrada,
  existeSalida,
  consultaConfigurada,
} from "./siesaTransito.consulta.js";

/* =============================================
   Orquestación del envío de requisiciones a SIESA

   El único trabajo de este módulo es que una requisición se envíe UNA VEZ.
   Dos envíos = dos requisiciones = movimientos de inventario que nunca pasaron,
   y eso no lo arregla nadie desde la app: hay que ir a pedirle a SIESA que los
   borre. Por eso todo acá está construido alrededor de no duplicar.

   Tres defensas, porque una sola no alcanza:
     1. `siesa_estado = 'enviado'` es terminal. Jamás se reenvía.
     2. Un lock por despacho (tabla compartida) impide que el cron de reintentos
        y el cierre del despachador manden a la vez desde instancias distintas.
     3. La transición a 'enviando' es condicional (`.neq("siesa_estado","enviado")`):
        si otro ya lo marcó, la carrera se pierde en la BD, no en memoria.

   El TOPE de intentos existe por la misma razón: si SIESA acepta pero se corta
   la respuesta, reintentar duplicaría. Preferimos parar y avisar antes que
   insistir a ciegas.
   ============================================= */

const TABLE = "traslados_despachos";
const MAX_INTENTOS = Number(process.env.SIESA_REQUISICION_MAX_INTENTOS) || 5;
const LOCK_TTL_S = 120;
// Tope del historial de intentos que se guarda por despacho. No crece sin límite.
const MAX_LOG_INTENTOS = 50;

const lockDe = (despachoId) => `siesa:requisicion:${despachoId}`;

/**
 * ¿El envío se quedó SIN RESPUESTA? Entonces no sabemos si llegó.
 *
 * Esta es la distinción que faltaba. Un rechazo de SIESA es un fallo: sabemos
 * que NO se procesó y reintentar es seguro. Un timeout no es un fallo, es una
 * INCÓGNITA: SIESA pudo haber procesado la salida y haberse cortado solo la
 * respuesta de vuelta. Reintentar ahí duplica el movimiento en el ERP.
 *
 * Ya pasó: un traslado quedó dos veces en SIESA porque el intento 1 dio timeout
 * a los 60 s, quedó como "pendiente" y el cron lo reintentó.
 *
 * Se es DELIBERADAMENTE conservador: cualquier error sin respuesta cuenta como
 * incierto, aunque algunos (un DNS que no resuelve) nunca hayan llegado a mandar
 * nada. No se pueden distinguir desde acá, y equivocarse hacia "no sé" cuesta que
 * alguien destrabe un traslado; equivocarse hacia "falló" cuesta ir a pedirle a
 * SIESA que borre un movimiento.
 */
function sinRespuesta(err) {
  if (err instanceof ConfigSiesaError) return false; // nunca se mandó nada
  // Con status HTTP hubo respuesta: SIESA contestó, aunque sea un rechazo.
  if (err?.httpStatus != null) return false;
  const codigo = String(err?.code || "").toUpperCase();
  if (["ECONNABORTED", "ETIMEDOUT", "ECONNRESET", "EPIPE"].includes(codigo)) return true;
  return /timeout|timed out|socket hang up|network error|aborted/i.test(
    String(err?.message || ""),
  );
}

/**
 * Modo SOLO SALIDA. Mientras SIESA devuelve los consecutivos de la salida de forma
 * inestable, la ENTRADA (que los necesita) se PAUSA: se manda solo la salida y el
 * par se cierra a mano cuando haya consecutivos.
 *
 * Con el modo prendido, una salida aceptada es TERMINAL — el despacho pasa a
 * 'enviado' apenas SIESA acepta la salida, sin intentar la entrada. Al ser terminal
 * (defensa 1), NO se reintenta: es lo que garantiza una única subida a SIESA.
 */
function soloSalida() {
  return ["1", "true", "on", "si", "sí"].includes(
    String(process.env.SIESA_SOLO_SALIDA || "").trim().toLowerCase(),
  );
}

/**
 * ¿Hay que preguntarle a SIESA si la entrada ya existe, antes de crearla?
 *
 * Prendido por default, y se apaga a propósito solo cuando ya no queda nadie
 * creando entradas a mano. Ver `verificarEntradaPrevia` para qué protege.
 */
function verificarEntrada() {
  const v = String(process.env.SIESA_ENTRADA_VERIFICAR ?? "1").trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(v);
}

/**
 * Consigue el consecutivo de la salida cuando la respuesta del conector no lo
 * trajo. NO manda nada al ERP: lee.
 *
 * Este es el agujero que dejó el par abierto durante dos semanas. SIESA aceptaba
 * la salida pero `doctoDe()` devolvía "", y sin consecutivo la entrada no se
 * puede armar. El número siempre estuvo en SIESA — nos faltaba ir a buscarlo.
 *
 * @returns {Promise<string|null>} el consecutivo, o null si no se pudo resolver
 */
async function resolverConsecutivoSalida(despacho) {
  if (!consultaConfigurada()) return null;
  try {
    // `refrescar` porque la salida se acaba de importar: un cache de hace unos
    // segundos es anterior al documento que estamos buscando.
    const doc = await buscarSalida(despacho.id, { refrescar: true });
    if (!doc) return null;
    console.log(
      `[requisicion] 🔎 despacho ${despacho.id}: consecutivo de salida recuperado de SIESA (${doc.nro}).`,
    );
    return doc.nro;
  } catch (e) {
    console.warn(
      `[requisicion] no se pudo consultar el consecutivo de salida de ${despacho.id}: ${e.message}`,
    );
    return null;
  }
}

/**
 * ¿Ya existe la entrada de este despacho en SIESA?
 *
 * POR QUÉ ESTO EXISTE: hasta 2026-09-03 las entradas las creaba una persona a
 * mano en el ERP (35 de 35 despachos, mismo día, apareo 1:1 verificado). Si el
 * sistema empieza a crearlas sin mirar, durante la transición el destino recibe
 * la mercancía DOS VECES — el espejo exacto del incidente de la salida
 * duplicada del 19/08, del otro lado del tránsito.
 *
 * Si no se puede consultar, se FRENA en vez de mandar a ciegas: es la política
 * que este módulo ya declara arriba. Un traslado trabado se destraba en un
 * minuto; una entrada duplicada hay que ir a que SIESA la borre.
 *
 * @returns {Promise<{ existe: boolean, doc?: object }>}
 * @throws {Error} si hay que verificar y no se pudo — el envío no debe seguir
 */
async function verificarEntradaPrevia(despacho) {
  if (!verificarEntrada()) return { existe: false };

  if (!consultaConfigurada()) {
    const err = new Error(
      "No se puede verificar si la entrada ya existe en SIESA: falta SIESA_CONSULTA_TRANSITO. " +
        "Se frena para no duplicar la entrada. Configurá la consulta o apagá " +
        "SIESA_ENTRADA_VERIFICAR solo si ya nadie las crea a mano.",
    );
    err.fase = "verificacion";
    throw err;
  }

  let doc;
  try {
    doc = await buscarEntrada(despacho.id);
  } catch (e) {
    const err = new Error(`No se pudo verificar la entrada previa en SIESA: ${e.message}`);
    err.fase = "verificacion";
    throw err;
  }

  return doc ? { existe: true, doc } : { existe: false };
}

/**
 * ¿Está en SIESA el documento que CIERRA este despacho?
 *
 * Se le pregunta al ERP, no a nuestra base. Sirve para contrastar lo que una
 * persona declara desde el panel contra lo que realmente hay (ver
 * `resolverIncierto`).
 *
 * QUÉ DOCUMENTO CIERRA depende del modo: en el flujo completo es la ENTRADA (la
 * salida sola deja la mercancía en tránsito, fuera de las dos bodegas); con
 * `SIESA_SOLO_SALIDA` la entrada se hace a mano a propósito, así que lo que se
 * puede exigir es la salida.
 *
 * OJO CON `existe` VS `doc`. No son lo mismo y la diferencia importa:
 * `buscarSalida` devuelve null cuando hay VARIAS salidas del despacho — se niega
 * a elegir una, y con razón. Pero "hay tres" no es "no hay ninguna": tomar ese
 * null por ausencia haría que el panel le dijera a una persona que el documento
 * no está, justo en los despachos más rotos. Por eso la existencia se pregunta
 * aparte, y `doc` queda en null cuando no se puede señalar UNO solo.
 *
 * @returns {Promise<{cara:"entrada"|"salida", existe:boolean, doc:object|null}>}
 * @throws {Error} si no se pudo preguntar — "no sé" NO es "no está"
 */
async function buscarCierreEnSiesa(despachoId) {
  const cara = soloSalida() ? "salida" : "entrada";

  if (!consultaConfigurada()) {
    const err = new Error("No se puede verificar en SIESA: falta SIESA_CONSULTA_TRANSITO.");
    err.noSePudoVerificar = true;
    throw err;
  }

  try {
    // `refrescar`: el documento pudo crearse hace segundos, justo antes de que la
    // persona apretara el botón. Un cache viejo diría "no está" sobre algo que sí.
    if (cara === "salida") {
      const existe = await existeSalida(despachoId, { refrescar: true });
      const doc = existe ? await buscarSalida(despachoId) : null;
      return { cara, existe, doc };
    }

    const doc = await buscarEntrada(despachoId, { refrescar: true });
    return { cara, existe: Boolean(doc), doc };
  } catch (e) {
    const err = new Error(`No se pudo consultar SIESA: ${e.message}`);
    err.noSePudoVerificar = true;
    throw err;
  }
}

/** Marca el estado del envío en la cabecera del despacho. */
async function marcar(despachoId, patch) {
  const { error } = await supabase.from(TABLE).update(patch).eq("id", despachoId);
  if (error) console.error(`[requisicion] no se pudo marcar ${despachoId}:`, error.message);
}

/**
 * Historial de intentos, APPEND-ONLY. Antes `siesa_error` guardaba solo el último
 * intento y el anterior se perdía. Para certificar que a SIESA se sube UNA sola vez
 * hay que poder ver CADA intento, no el último: qué pasó, cuándo, en qué fase, si
 * hubo ajuste. Cada entrada es una foto del intento. Se topea a los últimos N.
 *
 * @param {object} despacho - el despacho recién leído (trae `siesa_intentos_log`)
 * @param {object} entrada  - la entrada del intento actual
 * @returns {object[]} el log con la entrada nueva anexada
 */
function anexarIntento(despacho, entrada) {
  const prev = Array.isArray(despacho.siesa_intentos_log) ? despacho.siesa_intentos_log : [];
  return [...prev, entrada].slice(-MAX_LOG_INTENTOS);
}

/** ¿Se hizo un ajuste de inventario para este despacho? (para el log del intento) */
const ajusteDelIntento = (despacho) =>
  despacho.siesa_ajuste_estado === "hecho" ? "hecho" : null;

/**
 * Traslada `siesaData`/`httpStatus` de un error a otro que lo envuelve.
 *
 * `importarSalida` adjunta la respuesta CRUDA de SIESA al error. Cuando ese
 * error se re-envuelve en un `new Error(...)` para agregar contexto, esos campos se
 * pierden y el correo al líder de inventarios llega sin el JSON — que es
 * justamente el dato que sirve para diagnosticar.
 */
function conSiesaData(errNuevo, errOriginal) {
  if (errOriginal?.siesaData !== undefined) errNuevo.siesaData = errOriginal.siesaData;
  if (errOriginal?.httpStatus !== undefined) errNuevo.httpStatus = errOriginal.httpStatus;
  return errNuevo;
}

/**
 * Importa la SALIDA en tránsito y, si SIESA la rechaza por FALTANTE DE STOCK y el
 * ajuste automático está habilitado, inserta las unidades faltantes con un ajuste
 * de entrada y reintenta la salida UNA vez.
 *
 * POR QUÉ SOLO ENVUELVE LA SALIDA — el faltante de stock (registro 470) lo
 * dispara la validación de la BODEGA ORIGEN, que solo ocurre en la salida. La
 * entrada valida contra el docto de tránsito, no contra stock: nunca tira 470.
 *
 * Idempotencia del ajuste (defensa contra inventario fantasma duplicado):
 *   - El ajuste es un write al ERP. Solo se hace si `siesa_ajuste_estado` NO es
 *     'hecho'. Una vez hecho, jamás se repite: si el traslado sigue fallando por
 *     faltante tras un ajuste previo, se corta y se avisa (necesita ojo humano).
 *   - Corre DENTRO del lock del despacho (lo toma `enviarRequisicion`), así que
 *     no hay dos ajustes simultáneos para el mismo despacho.
 *
 * Devuelve lo mismo que `importarSalida`, o lanza (lo maneja el catch de
 * `enviarRequisicion`, que marca la requisición pendiente/fallida como siempre).
 *
 * @param {object} despacho - cabecera + items (recién leído de la BD)
 */
async function enviarSalidaConAjuste(despacho) {
  try {
    return await importarSalida(despacho);
  } catch (err) {
    const autoOn = ajusteAutoHabilitado();
    const faltantes = autoOn ? detectarFaltantes(err.siesaData) : [];
    // Log conclusivo: dice si el flag está prendido y cuántos faltantes se
    // detectaron. Si autoOn=false → falta la env var; si autoOn=true y
    // faltantes=0 → el rechazo no es por stock (o no se pudo parsear la respuesta).
    console.log(
      `[requisicion] despacho ${despacho.id}: rechazo SIESA — ajusteAuto=${autoOn}, faltantes=${faltantes.length}`,
    );

    if (!autoOn) throw err;
    if (!faltantes.length) throw err; // el rechazo NO es por falta de stock

    if (despacho.siesa_ajuste_estado === "hecho") {
      // Ya insertamos stock antes y SIGUE rechazando por faltante. No re-ajustamos
      // (duplicaría inventario). Puede ser otro ítem o un ajuste anterior corto.
      // Se re-adjunta `siesaData`: envolver el error en uno nuevo perdía la
      // respuesta cruda de SIESA, que es justo lo que se manda por correo.
      throw conSiesaData(
        new Error(
          `El traslado sigue sin stock tras un ajuste ya hecho: ${err.message}. ` +
            "No se re-ajusta para no duplicar inventario — revisar manualmente.",
        ),
        err,
      );
    }

    let aj;
    try {
      aj = await importarAjuste(despacho, faltantes);
    } catch (e) {
      await marcar(despacho.id, {
        siesa_ajuste_estado: "fallido",
        siesa_ajuste_error: String(e.message).slice(0, 1000),
      });
      // `e` es el fallo del AJUSTE; `err` es el rechazo original del traslado.
      // Se conserva la respuesta cruda del rechazo original, que es la que explica
      // por qué se intentó ajustar.
      throw conSiesaData(new Error(`Ajuste de inventario falló: ${e.message}`), err);
    }

    await marcar(despacho.id, {
      siesa_ajuste_estado: "hecho",
      siesa_ajuste_docto: aj.docto || null,
      siesa_ajuste_at: new Date().toISOString(),
      siesa_ajuste_payload: aj.payload || null,
      siesa_ajuste_error: null,
    });
    // Y en el objeto en memoria, por si algo lo relee en esta misma pasada.
    despacho.siesa_ajuste_estado = "hecho";

    const itemsTxt = faltantes.map((f) => `${f.item}×${f.cantidad}`).join(", ");
    console.log(
      `[requisicion] 🩹 despacho ${despacho.id}: ajuste de entrada hecho (docto ${
        aj.docto || "s/n"
      }; ${itemsTxt}). Reintentando el traslado.`,
    );

    // Reintento único: si vuelve a fallar, cae al catch de enviarRequisicion.
    return await importarSalida(despacho);
  }
}

/**
 * Envía la transferencia EN TRÁNSITO completa: SALIDA (clase 65) y luego ENTRADA
 * (clase 66) referenciando el consecutivo de la salida. Son DOS writes al ERP en
 * una operación; el orden es obligado y la entrada depende del docto de la salida.
 *
 * IDEMPOTENCIA DEL PAR (defensa contra salida duplicada):
 *   El docto de la salida se PERSISTE apenas SIESA la acepta, ANTES de intentar
 *   la entrada. Si la entrada falla (o el proceso muere), el reintento ve
 *   `siesa_salida_docto` ya cargado y SALTA la salida: manda solo la entrada con
 *   ese consecutivo. Re-mandar la salida duplicaría el movimiento de tránsito.
 *
 * Devuelve el docto de la ENTRADA como `docto` (el que cierra el par) y ambos
 * payloads bajo `payload: { salida, entrada }`. `vacio:true` si no hay ítems.
 *
 * @param {object} despacho - cabecera + items (recién leído de la BD)
 */
async function enviarTransito(despacho) {
  // IDEMPOTENCIA ANCLADA EN LA HORA DE ACEPTACIÓN, NO EN EL CONSECUTIVO.
  //
  // El bug que duplicaba inventario: SIESA aceptaba la salida (movía inventario)
  // pero el código no lograba LEER el consecutivo (doctoDe → ""). Con el docto
  // vacío, `siesa_salida_docto` quedaba "" (falsy), y un guard que dependa del
  // docto creía que la salida NUNCA entró → la re-mandaba en cada reintento.
  //
  // La prueba de que la salida entró NO es el consecutivo (que puede no leerse),
  // es la HORA en que SIESA la aceptó. Por eso el guard mira `siesa_salida_at`:
  // si tiene valor, la salida ya movió inventario y JAMÁS se re-manda.
  let salidaYaEnviada =
    Boolean(despacho.siesa_salida_at) || Boolean(despacho.siesa_salida_docto);

  // SEGUNDA RED: LA VERDAD ESTÁ EN SIESA, NO EN NUESTRA BASE.
  //
  // El guard de arriba solo sabe lo que alcanzamos a escribir. Los despachos
  // ANTERIORES a la migración 030 tienen `siesa_salida_at` en null porque la
  // columna no existía cuando se mandaron — y varios de ellos SÍ tienen su
  // salida en SIESA (los del 19/08, algunos por triplicado). Para esas filas el
  // guard dice "nunca se mandó" y manda otra: inventario saliendo de bodega de
  // nuevo. Es el mismo desastre del 19/08, servido por un hueco de datos.
  //
  // Si SIESA dice que ya hay una salida de este despacho, ya se mandó. Punto.
  // Se usa `existeSalida` (existencia) y NO `buscarSalida` (cuál): con salidas
  // duplicadas la segunda devuelve null, y tomar eso por "no hay" sería
  // exactamente el bug que esto viene a tapar.
  //
  // Si no se puede consultar, se sigue con el guard de la BD y se avisa: frenar
  // todos los traslados porque Connekta no responde es peor que el riesgo que
  // cubre esta red, que es un caso de datos viejos.
  if (!salidaYaEnviada && consultaConfigurada()) {
    try {
      if (await existeSalida(despacho.id)) {
        salidaYaEnviada = true;
        const ahora = new Date().toISOString();
        await marcar(despacho.id, { siesa_salida_at: ahora });
        despacho.siesa_salida_at = ahora;
        console.warn(
          `[requisicion] 🛡️ despacho ${despacho.id}: SIESA ya tiene la salida pero nuestra ` +
            `base no lo registraba. NO se re-manda. Se ancla ahora para que no vuelva a pasar.`,
        );
      }
    } catch (e) {
      console.warn(
        `[requisicion] no se pudo confirmar en SIESA si la salida de ${despacho.id} ya existe ` +
          `(${e.message}). Se sigue con el estado de la base.`,
      );
    }
  }

  let salidaDocto = despacho.siesa_salida_docto || null;
  let salidaPayload = despacho.siesa_salida_payload || null;
  let salidaRespuesta = despacho.siesa_salida_respuesta || null;

  if (!salidaYaEnviada) {
    let salida;
    try {
      salida = await enviarSalidaConAjuste(despacho);
    } catch (e) {
      if (!e.fase) e.fase = "salida";
      throw e;
    }
    if (salida.vacio) return { vacio: true }; // nada recolectado: no hay par que crear

    salidaDocto = salida.docto || null;
    salidaPayload = salida.payload;
    salidaRespuesta = salida.respuesta || null;

    // Persistir la ACEPTACIÓN de inmediato, anclada en `siesa_salida_at`. Este es
    // el punto crítico de la idempotencia: si el proceso muere después de esto, el
    // reintento ve la salida ya enviada y NO la re-manda (no duplica el tránsito),
    // AUNQUE no se haya podido leer el consecutivo. Guardamos también la respuesta
    // cruda de SIESA — es la constancia de la subida y de dónde sale el docto.
    const ahora = new Date().toISOString();
    await marcar(despacho.id, {
      siesa_salida_docto: salidaDocto,
      siesa_salida_at: ahora,
      siesa_salida_payload: salidaPayload,
      siesa_salida_respuesta: salidaRespuesta,
    });
    despacho.siesa_salida_at = ahora; // por si algo relee en esta misma pasada
    despacho.siesa_salida_docto = salidaDocto;

    console.log(
      `[requisicion] ➡️ despacho ${despacho.id}: salida en tránsito importada (docto ${
        salidaDocto || "SIN CONSECUTIVO LEÍDO"
      }).`,
    );
  } else {
    console.log(
      `[requisicion] ↩️ despacho ${despacho.id}: salida ya enviada (docto ${
        salidaDocto || "s/n"
      }). No se re-manda — se evita duplicar el movimiento.`,
    );
  }

  // MODO SOLO SALIDA — la entrada se pausa a propósito (le faltan los consecutivos
  // de SIESA). La salida ya movió inventario: el despacho es TERMINAL y el par se
  // cierra a mano cuando SIESA entregue los consecutivos. Sin entrada, sin
  // reintento, sin duplicado.
  if (soloSalida()) {
    return {
      soloSalida: true,
      docto: null, // no hay entrada en este modo
      salidaDocto,
      salidaRespuesta,
      payload: { salida: salidaPayload },
    };
  }

  // FLUJO COMPLETO — la entrada referencia el consecutivo de la salida.
  //
  // Si el conector no devolvió el consecutivo, se lo pedimos a SIESA leyendo los
  // documentos de tránsito. Antes, acá el flujo moría: `importarEntrada` lanzaba
  // "No hay consecutivo de salida" y el par quedaba abierto para siempre.
  if (!salidaDocto) {
    salidaDocto = await resolverConsecutivoSalida(despacho);
    if (salidaDocto) {
      await marcar(despacho.id, { siesa_salida_docto: salidaDocto });
      despacho.siesa_salida_docto = salidaDocto;
    }
  }

  // GUARD ANTI-DUPLICADO. Se pregunta SIEMPRE, incluso con el consecutivo en
  // mano: la entrada pudo haberla creado una persona en el ERP mientras esto
  // corría. Si ya existe, no se importa otra — se adopta la que está.
  const previa = await verificarEntradaPrevia(despacho);
  if (previa.existe) {
    console.log(
      `[requisicion] 🛑 despacho ${despacho.id}: la entrada YA existe en SIESA ` +
        `(docto ${previa.doc.nro}, ${previa.doc.fecha || "s/f"}). No se crea otra.`,
    );
    return {
      docto: previa.doc.nro,
      entradaExterna: true,
      salidaDocto,
      salidaRespuesta,
      payload: { salida: salidaPayload, entrada: null },
    };
  }

  let entrada;
  try {
    entrada = await importarEntrada(despacho, salidaDocto);
  } catch (e) {
    if (!e.fase) e.fase = "entrada";
    throw e;
  }

  return {
    docto: entrada.docto,
    salidaDocto,
    salidaRespuesta,
    payload: { salida: salidaPayload, entrada: entrada.payload },
  };
}

/**
 * Envía la requisición de UN despacho a SIESA, si corresponde.
 * Nunca lanza: devuelve qué pasó. El despacho ya está cerrado; esto es un efecto
 * posterior y no puede tumbar nada.
 *
 * @param {object|string} despachoOId - el despacho (con items) o su id
 * @param {object} [opts]
 * @param {boolean} [opts.forzar] - ignora el tope de intentos. Solo para el
 *   reintento MANUAL desde el panel: alguien miró el error, lo corrigió y pide
 *   otra pasada. NO saltea la defensa de 'enviado' (eso duplicaría inventario).
 * @returns {Promise<{estado:'enviado'|'pendiente'|'fallido'|'omitido', motivo?:string,
 *   siesaData?:any, httpStatus?:number}>} `siesaData` es la respuesta CRUDA de SIESA
 *   cuando el fallo vino del ERP (ausente en timeouts y fallos de red).
 */
/** Rechazo de una declaración que SIESA contradice. 409 + `expose` para que el panel lo muestre. */
function errorVerificacion(mensaje) {
  const e = new Error(mensaje);
  e.statusCode = 409;
  e.expose = true;
  e.verificacion = "contradicha";
  return e;
}

/**
 * Contrasta contra SIESA lo que la persona declara desde el panel.
 *
 * Devuelve el `sello` que queda escrito en el historial: la frase que, dentro de
 * seis meses, le va a decir a quien audite si ese cierre se comprobó o se creyó.
 *
 * @param {string} despachoId
 * @param {"enviado"|"reintentar"} resultado
 * @param {boolean} forzar - cerrar aunque SIESA no confirme
 * @returns {Promise<{estado:string, sello:string, doc:object|null}>}
 * @throws {Error} 409 si SIESA contradice la declaración y no se forzó
 */
async function verificarDeclaracion(despachoId, resultado, forzar) {
  let hallazgo;
  try {
    hallazgo = await buscarCierreEnSiesa(despachoId);
  } catch (e) {
    // NO SE PUDO PREGUNTAR ≠ NO ESTÁ. Frenar todos los cierres porque Connekta no
    // responde deja a la gente sin salida frente a un panel en rojo; aceptar en
    // silencio es lo que vinimos a arreglar. Se acepta y se deja dicho.
    if (!e.noSePudoVerificar) throw e;
    console.warn(`[requisicion] despacho ${despachoId}: no se pudo verificar — ${e.message}`);
    return { estado: "no-verificable", sello: `SIN VERIFICAR (${e.message})`, doc: null };
  }

  const { cara, existe, doc } = hallazgo;
  const nombre = cara === "salida" ? "la salida" : "la entrada";

  if (resultado === "enviado") {
    if (existe) {
      return {
        estado: "confirmada",
        sello: `verificado en SIESA: ${nombre} ${doc?.nro ?? "existe (duplicada)"}`,
        doc,
      };
    }
    if (forzar) {
      return { estado: "forzada", sello: `FORZADO: SIESA no encuentra ${nombre}`, doc: null };
    }
    throw errorVerificacion(
      `SIESA no encuentra ${nombre} de este traslado, así que no se puede dar por subido. ` +
        `Marcarlo igual lo deja como TERMINAL y la mercancía queda en tránsito, fuera de las dos ` +
        `bodegas, sin que nadie lo vuelva a ver. Creá ${nombre} en el ERP y volvé a intentar; ` +
        `si estás segura de que está y la consulta no la ve, usá "cerrar sin verificar".`,
    );
  }

  // "reintentar" — devolverlo a la cola sobre un documento que SÍ existe lo manda
  // de nuevo y duplica el movimiento. Es el 19/08 hecho a mano.
  if (existe && !forzar) {
    throw errorVerificacion(
      `SIESA SÍ tiene ${nombre} de este traslado${doc?.nro ? ` (${doc.nro})` : ""}. ` +
        `Devolverlo a la cola lo subiría por segunda vez y duplicaría el movimiento de inventario. ` +
        `Si el documento del ERP está mal, anulalo allá primero.`,
    );
  }
  if (existe) {
    return { estado: "forzada", sello: `FORZADO: vuelve a la cola con ${nombre} ya en SIESA`, doc: null };
  }
  return { estado: "confirmada", sello: `verificado en SIESA: ${nombre} no está`, doc: null };
}

/**
 * Cierra un envío trabado con lo que una persona vio en SIESA.
 *
 * Aplica a los dos estados que quedan esperando a un humano:
 *   · "incierto" → SIESA no respondió y no se sabe si entró (sql/033).
 *   · "fallido"  → se agotaron los intentos. Muchos de estos terminan
 *     resolviéndose A MANO en SIESA, y hasta ahora la app no se enteraba: seguía
 *     mostrándolos en rojo, con un botón de "Forzar reintento" que los habría
 *     mandado OTRA VEZ y duplicado el movimiento. Marcarlos cierra esa puerta,
 *     porque "enviado" sí es terminal.
 *
 * Los dos caminos declaran algo sobre el ERP:
 *
 *   "enviado"    → el documento SÍ está en SIESA. Se marca enviado y no se manda
 *                  nada más. Es terminal, así que ya nadie lo vuelve a tocar.
 *   "reintentar" → NO está. Vuelve a "pendiente" y el cron lo retoma por el
 *                  camino normal.
 *
 * ── LA DECLARACIÓN SE CONTRASTA CONTRA SIESA (2026-09-04) ──
 * Antes se creía sin más, y las dos direcciones podían hacer daño:
 *
 *   · Un "enviado" sobre algo que NO está deja la mercancía en tránsito —fuera
 *     de la bodega origen y de la destino— y `enviado` es TERMINAL: el despacho
 *     desaparece de los tableros, el cron no lo levanta, nadie lo vuelve a ver.
 *     Es un hueco de inventario que se apaga solo.
 *   · Un "reintentar" sobre algo que SÍ está manda el documento de nuevo y
 *     DUPLICA el movimiento. Es el desastre del 19/08 servido a mano.
 *
 * Así que se le pregunta a SIESA y se exige que la realidad coincida con lo que
 * la persona dice haber visto. No es desconfianza: es que a las 6 de la mañana,
 * con veinte despachos en rojo, cualquiera se confunde de fila.
 *
 * `forzar` deja pasar igual — hay casos legítimos donde la consulta no ve el
 * documento (fuera de la ventana del SQL, o creado sin el uuid en las notas) —
 * pero queda escrito en el log que se cerró SIN verificar. La escapatoria existe;
 * silenciosa, no.
 *
 * Cuando la verificación encuentra el documento, se guarda su consecutivo en
 * `siesa_docto`. Antes quedaba en null y no había forma de saber, mirando la
 * base, con qué documento se había cerrado el despacho.
 *
 * No se toca `siesa_intentos`: el historial tiene que seguir mostrando que hubo
 * un envío sin respuesta. Borrar ese rastro es perder la única pista de por qué
 * un documento podría estar duplicado.
 *
 * @param {string} despachoId
 * @param {"enviado"|"reintentar"} resultado - lo que la persona verificó
 * @param {string} [quien] - correo de quien lo resolvió (queda como constancia)
 * @param {object} [opts]
 * @param {boolean} [opts.forzar] - cerrar aunque SIESA no confirme
 */
export async function resolverIncierto(despachoId, resultado, quien = null, { forzar = false } = {}) {
  const { data: despacho } = await supabase
    .from(TABLE)
    .select("id, siesa_estado, siesa_intentos, siesa_intentos_log")
    .eq("id", despachoId)
    .maybeSingle();

  if (!despacho) {
    const e = new Error("Despacho no encontrado");
    e.statusCode = 404;
    e.expose = true;
    throw e;
  }
  if (!["incierto", "fallido"].includes(despacho.siesa_estado)) {
    const e = new Error(
      `Este traslado no necesita resolverse a mano: su envío a SIESA está en ` +
        `"${despacho.siesa_estado}".`,
    );
    e.statusCode = 409;
    e.expose = true;
    throw e;
  }
  if (!["enviado", "reintentar"].includes(resultado)) {
    const e = new Error('resultado debe ser "enviado" o "reintentar"');
    e.statusCode = 400;
    e.expose = true;
    throw e;
  }

  const verificacion = await verificarDeclaracion(despachoId, resultado, forzar);

  const estado = resultado === "enviado" ? "enviado" : "pendiente";
  const firma = quien ? " — " + quien : "";
  const sello =
    resultado === "enviado"
      ? `Resuelto A MANO en SIESA (venia de "${despacho.siesa_estado}") · ${verificacion.sello}${firma}`
      : `Vuelve a la cola (venia de "${despacho.siesa_estado}") · ${verificacion.sello}${firma}`;

  const patch = {
    siesa_estado: estado,
    siesa_enviado_at: resultado === "enviado" ? new Date().toISOString() : null,
    siesa_error: null,
    siesa_intentos_log: anexarIntento(despacho, {
      n: Number(despacho.siesa_intentos) || 0,
      at: new Date().toISOString(),
      estado,
      fase: "resolucion-manual",
      verificacion: verificacion.estado,
      error: sello,
    }),
  };

  // El consecutivo que confirmó la verificación. Sin esto `siesa_docto` quedaba
  // en null y no había forma de saber, mirando la base, con qué documento del ERP
  // se cerró el despacho.
  if (resultado === "enviado" && verificacion.doc?.nro) {
    patch.siesa_docto = String(verificacion.doc.nro);
  }

  await marcar(despachoId, patch);

  console.log(
    `[requisicion] 🔎 despacho ${despachoId} resuelto a mano: ${resultado} ` +
      `(${verificacion.sello})${quien ? ` (${quien})` : ""}`,
  );
  return { estado, resultado, verificacion: verificacion.estado, docto: verificacion.doc?.nro ?? null };
}

export async function enviarRequisicion(despachoOId, { forzar = false } = {}) {
  const id = typeof despachoOId === "string" ? despachoOId : despachoOId?.id;
  if (!id) return { estado: "omitido", motivo: "sin id" };

  // Defensa 2: un solo enviador a la vez para este despacho, entre instancias.
  const lock = lockDe(id);
  if (!(await tomarLock(lock, LOCK_TTL_S, "envio-requisicion"))) {
    return { estado: "omitido", motivo: "otro envío en curso" };
  }

  try {
    // Releemos SIEMPRE de la BD: quien nos llamó pudo traer un objeto viejo, y
    // "ya se envió" es justo el dato que no podemos permitirnos leer desactualizado.
    const despacho = await DespachoModel.findById(id);
    if (!despacho) return { estado: "omitido", motivo: "no existe" };

    // Defensa 4: un resultado INCIERTO no se manda de nuevo por las buenas.
    //
    // El cron ya no lo levanta (solo toca "pendiente"), pero el botón de rescate
    // del panel sí llegaría hasta acá. Apretarlo sobre un incierto es justo la
    // acción que duplica: no sabemos si el envío anterior entró. Se exige `forzar`,
    // que en el panel corresponde a "ya verifiqué en SIESA y NO está".
    if (despacho.siesa_estado === "incierto" && !forzar) {
      return {
        estado: "omitido",
        motivo:
          "el envío anterior no respondió y no se sabe si entró. Verificá en SIESA " +
          "antes de reintentar: si la salida está, marcala como enviada.",
      };
    }

    // Defensa 1: 'enviado' es terminal.
    if (despacho.siesa_estado === "enviado") {
      return { estado: "omitido", motivo: "ya enviado" };
    }

    // El chequeo de config va DESPUÉS de leer el despacho (el centro de
    // operación depende del origen) y ANTES de contar el intento: una variable
    // de entorno que falta no es SIESA fallando, y reintentar no la va a crear.
    // Si consumiera intentos, un fin de semana de cron dejaría todo en 'fallido'
    // por algo que se arregla cargando una variable.
    const faltan = configFaltante(despacho.origen, despacho.destino);
    if (faltan.length) {
      const motivoCfg = `Configuración incompleta: falta ${faltan.join(", ")}`;
      await marcar(id, {
        siesa_estado: "pendiente",
        siesa_error: motivoCfg,
        siesa_intentos_log: anexarIntento(despacho, {
          n: Number(despacho.siesa_intentos) || 0,
          at: new Date().toISOString(),
          estado: "pendiente",
          fase: "config",
          error: motivoCfg,
        }),
      });
      console.error(`[requisicion] ⚠️ despacho ${id} sin enviar — falta ${faltan.join(", ")}`);
      return { estado: "pendiente", motivo: "config" };
    }

    const intentos = Number(despacho.siesa_intentos) || 0;
    if (intentos >= MAX_INTENTOS && !forzar) {
      await marcar(id, { siesa_estado: "fallido" });
      return {
        estado: "fallido",
        motivo: `máximo de intentos alcanzado (${intentos}/${MAX_INTENTOS})`,
        agotado: true,
      };
    }

    // Defensa 3: la carrera se resuelve en la BD. Si otra instancia ya lo marcó
    // como enviado entre nuestro read y este update, no pisamos nada.
    const { data: reservado, error: errReserva } = await supabase
      .from(TABLE)
      .update({ siesa_intentos: intentos + 1 })
      .eq("id", id)
      .neq("siesa_estado", "enviado")
      .select("id")
      .maybeSingle();

    if (errReserva) throw new Error(`No se pudo reservar el envío: ${errReserva.message}`);
    if (!reservado) return { estado: "omitido", motivo: "ya enviado (carrera)" };

    try {
      const r = await enviarTransito(despacho);
      const ahora = new Date().toISOString();

      if (r.vacio) {
        // Despacho sin nada recolectado: no hay transferencia que crear.
        await marcar(id, {
          siesa_estado: "enviado",
          siesa_error: null,
          siesa_enviado_at: ahora,
          siesa_docto: null,
          siesa_intentos_log: anexarIntento(despacho, {
            n: intentos + 1,
            at: ahora,
            estado: "enviado",
            fase: "vacio",
            resultado: "sin ítems recolectados",
          }),
        });
        return { estado: "enviado", motivo: "sin ítems recolectados" };
      }

      if (r.soloSalida) {
        // MODO SOLO SALIDA — terminal apenas SIESA acepta la salida. `siesa_docto`
        // toma el consecutivo de la SALIDA (no hay entrada que cierre el par), y
        // `siesa_salida_respuesta` deja la constancia cruda de la subida.
        await marcar(id, {
          siesa_estado: "enviado",
          siesa_error: null,
          siesa_docto: r.salidaDocto || null,
          siesa_enviado_at: ahora,
          siesa_payload: r.payload || null,
          siesa_salida_respuesta: r.salidaRespuesta || null,
          siesa_intentos_log: anexarIntento(despacho, {
            n: intentos + 1,
            at: ahora,
            estado: "enviado",
            fase: "salida",
            resultado: "solo salida",
            salida_docto: r.salidaDocto || null,
            ajuste: ajusteDelIntento(despacho),
          }),
        });
        console.log(
          `[requisicion] ✅ despacho ${id}: SOLO SALIDA enviada (docto ${
            r.salidaDocto || "SIN CONSECUTIVO LEÍDO"
          }). Entrada pausada.`,
        );
        return { estado: "enviado", soloSalida: true };
      }

      // `siesa_docto` = docto de la ENTRADA (cierra el par). El de la salida ya
      // quedó en `siesa_salida_docto` cuando se importó. `siesa_payload` lleva los
      // dos documentos { salida, entrada } para poder auditar el par completo.
      await marcar(id, {
        siesa_estado: "enviado",
        siesa_error: null,
        siesa_docto: r.docto || null,
        siesa_entrada_externa: Boolean(r.entradaExterna),
        siesa_enviado_at: ahora,
        siesa_payload: r.payload || null,
        siesa_salida_respuesta: r.salidaRespuesta || null,
        siesa_intentos_log: anexarIntento(despacho, {
          n: intentos + 1,
          at: ahora,
          estado: "enviado",
          fase: "entrada",
          // "adoptada" = la entrada ya existía en SIESA y este backend NO la creó.
          resultado: r.entradaExterna ? "entrada adoptada" : "completo",
          salida_docto: r.salidaDocto || null,
          entrada_docto: r.docto || null,
          ajuste: ajusteDelIntento(despacho),
        }),
      });
      console.log(
        `[requisicion] ✅ despacho ${id} en tránsito completo (salida ${
          r.salidaDocto || "s/n"
        } → entrada ${r.docto || "s/n"}${r.entradaExterna ? ", adoptada de SIESA" : ""})`,
      );
      return { estado: "enviado", entradaExterna: Boolean(r.entradaExterna) };
    } catch (err) {
      const esConfig = err instanceof ConfigSiesaError;
      const agotado = intentos + 1 >= MAX_INTENTOS;
      // SIN RESPUESTA ⇒ "incierto", y ahí se FRENA. El cron solo levanta
      // "pendiente", así que este no se reintenta solo: espera a que alguien mire
      // en SIESA y decida (ver sql/033). Es la política que este módulo ya
      // declaraba en su encabezado — "preferimos parar y avisar antes que insistir
      // a ciegas" — y que hasta ahora no estaba implementada.
      //
      // Config incompleta no consume el cupo de reintentos: no es SIESA fallando.
      const estado = esConfig
        ? "pendiente"
        : sinRespuesta(err)
          ? "incierto"
          : agotado
            ? "fallido"
            : "pendiente";
      const msg = String(err.message).slice(0, 1000);

      await marcar(id, {
        siesa_estado: estado,
        siesa_error: msg,
        siesa_intentos_log: anexarIntento(despacho, {
          n: intentos + 1,
          at: new Date().toISOString(),
          estado,
          fase: err.fase || "envio",
          error: msg,
          http_status: err.httpStatus ?? null,
          ajuste: ajusteDelIntento(despacho),
        }),
      });
      if (estado === "incierto") {
        console.error(
          `[requisicion] ⚠️ despacho ${id}: SIESA no respondió (${err.message}). ` +
            "NO se reintenta solo — hay que verificar en SIESA si la salida entró.",
        );
      } else {
        console.error(
          `[requisicion] ❌ despacho ${id} intento ${intentos + 1}/${MAX_INTENTOS}: ${err.message}`,
        );
      }
      // `siesaData` viaja en el retorno (no se persiste) para que el correo de error
      // pueda mostrar el JSON crudo del rechazo. Puede venir undefined: un timeout
      // o un fallo de red no tiene respuesta que adjuntar.
      return {
        estado,
        motivo: err.message,
        siesaData: err.siesaData,
        httpStatus: err.httpStatus,
      };
    }
  } finally {
    await liberarLock(lock);
  }
}

/**
 * Reintenta las requisiciones que quedaron pendientes. Lo llama el cron.
 * Solo toca 'pendiente': 'fallido' agotó sus intentos y necesita que alguien
 * mire qué pasó — insistir solo sería ruido.
 *
 * @param {number} limite - cuántas procesar por corrida
 */
export async function reintentarPendientes(limite = 20) {
  const { data, error } = await supabase
    .from(TABLE)
    .select("id")
    .eq("siesa_estado", "pendiente")
    .lt("siesa_intentos", MAX_INTENTOS)
    .order("updated_at", { ascending: true })
    .limit(limite);

  if (error) throw new Error(`Error al listar requisiciones pendientes: ${error.message}`);
  if (!data?.length) return { procesados: 0, enviados: 0, resultados: [] };

  // En SERIE, no en paralelo: SIESA ya nos tiró deadlocks por concurrencia con
  // el snapshot, y acá cada request ESCRIBE. No hay ningún apuro que justifique
  // el riesgo — son 20 documentos, no 77 páginas.
  const resultados = [];
  for (const { id } of data) {
    resultados.push({ id, ...(await enviarRequisicion(id)) });
  }

  const enviados = resultados.filter((r) => r.estado === "enviado").length;
  console.log(`[requisicion] reintento: ${enviados}/${resultados.length} enviados`);
  return { procesados: resultados.length, enviados, resultados };
}

/**
 * Resumen para el panel/monitor: cuántas hay en cada estado y si la config está
 * completa para CADA sede origen. Reportar solo el global escondería el caso
 * real: el C.O. cargado para una sede y faltando para otra.
 */
export async function estadoRequisiciones() {
  const { data, error } = await supabase
    .from(TABLE)
    .select("id, origen, destino, siesa_estado, siesa_intentos, siesa_error, siesa_docto")
    .not("siesa_estado", "is", null);

  if (error) throw new Error(`Error al leer estado de requisiciones: ${error.message}`);

  const conteo = { pendiente: 0, enviado: 0, fallido: 0 };
  for (const r of data || []) {
    if (conteo[r.siesa_estado] != null) conteo[r.siesa_estado] += 1;
  }

  // El PORQUÉ de cada una que no llegó. Sin esto hay que ir a bucear a los logs
  // de Vercel para enterarse de algo que el sistema ya sabe — y una cola que
  // cuesta mirar es una cola que nadie mira.
  const problemas = (data || [])
    .filter((r) => r.siesa_estado !== "enviado")
    .map((r) => ({
      id: r.id,
      ruta: `${r.origen} → ${r.destino}`,
      estado: r.siesa_estado,
      intentos: r.siesa_intentos,
      error: r.siesa_error,
    }));

  const origenes = [...new Set(Object.values(FLUJOS).map((f) => f.origen))];
  const config = {};
  for (const sede of origenes) {
    const faltan = configFaltante(sede);
    config[sede] = faltan.length ? { listo: false, falta: faltan } : { listo: true };
  }

  // `problemas` se armaba y se descartaba: el estado reportaba "3 pendientes"
  // sin decir POR QUÉ, y el porqué solo estaba en los logs de Vercel.
  return {
    ...conteo,
    problemas,
    config,
    listoParaEnviar: origenes.every((s) => config[s].listo),
  };
}
