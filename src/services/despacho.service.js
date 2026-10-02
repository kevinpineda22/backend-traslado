import * as DespachoModel from "../models/Despacho.model.js";
import * as ItemModel from "../models/Item.model.js";
import * as FirmaModel from "../models/Firma.model.js";
import * as ManifiestoModel from "../models/Manifiesto.model.js";
import * as ConteoModel from "../models/RecepcionConteo.model.js";
import * as ContenedoresService from "./contenedores.service.js";
import * as ContenedorModel from "../models/Contenedor.model.js";
import * as RecepcionContenedores from "./recepcionContenedores.service.js";
import { createError } from "../middleware/errorHandler.js";
import {
  notificarRecoleccionCerrada,
  enviarComparativoAuditoria,
  enviarErrorSiesa,
  enviarInciertoSiesa,
  enviarManifiestoCarga,
} from "./notificacionesTraslado.service.js";
import { enviarRequisicion } from "./requisicion.service.js";
import { consultaConfigurada } from "./siesaTransito.consulta.js";
import { getStockLote } from "./siesaStock.service.js";
import { fichaDeItem } from "./siesa.service.js";
// Namespace a propósito, no import con nombre: los tests de recepción y
// contenedores mockean siesa.service.js con una lista fija de exports, y un import
// con nombre que el mock no trae hace fallar el import del servicio ENTERO (se
// caían 52 tests por una columna informativa). Con el namespace, un mock sin
// `clasesLlanoDeItems` deja la columna A/B/C vacía — lo mismo que pasa si la
// lectura falla — en vez de romper todo. En producción el módulo real la exporta.
import * as SiesaService from "./siesa.service.js";
import { getFlujoPorDestino } from "../config/flujos.js";
import { fechaHoraLegible } from "../config/tiempo.js";
import { analitica as calcularAnalitica } from "./analitica.service.js";
import ExcelJS from "exceljs";

/**
 * Listar despachos con filtros opcionales.
 */
export async function listar(filters) {
  return DespachoModel.findAll(filters);
}

/**
 * Listar despachos con resumen de items (para el monitor).
 * Cada despacho incluye conteo de items completos/incompletos/agotados/pendientes.
 */
export async function listarConResumen(filters = {}) {
  return DespachoModel.findAllWithResumen(filters);
}

/**
 * Obtener detalle completo de un despacho.
 */
/** Estadísticas de motivos de faltante (para el dashboard). */
export function estadisticasMotivos() {
  return ItemModel.estadisticasMotivos();
}

/** Analítica agregada para el Dashboard (ver analitica.service). */
export function analitica(opts) {
  return calcularAnalitica(opts);
}

/** Ítems en despachos activos (para avisar de traslados en curso). */
export function itemsEnDespachosActivos() {
  return DespachoModel.itemsEnDespachosActivos();
}

/**
 * @param {string} id
 * @param {object} [opts]
 * @param {boolean} [opts.conClase] - adjunta la clase A/B/C a los ítems de Llano.
 *   Opt-in: solo la usa el monitor. El panel del recibidor también lee por acá y
 *   arma sus ítems con una lista blanca que la descarta, así que calcularla ahí
 *   eran consultas al snapshot pagadas en el celular para nada.
 */
export async function obtener(id, { conClase = false } = {}) {
  const despacho = await DespachoModel.findById(id);
  if (!despacho || !conClase) return despacho;
  return conClaseLlano(despacho);
}

/**
 * Adjunta la clase A/B/C a cada ítem de un despacho del flujo Llano, para que el
 * monitor pueda mostrarla. En General no hay clases: el despacho vuelve intacto.
 *
 * Best-effort: si la lectura del snapshot falla, el detalle sale igual sin la
 * columna. Un dato informativo no puede tumbar la pantalla que se usa para
 * seguir el traslado. Ver `clasesLlanoDeItems` para por qué se deriva.
 */
async function conClaseLlano(despacho) {
  if (getFlujoPorDestino(despacho.destino)?.logica !== "abc") return despacho;
  const items = despacho.traslados_items || [];
  if (items.length === 0) return despacho;

  try {
    const clases = await SiesaService.clasesLlanoDeItems(
      despacho.destino,
      items.map((it) => it.codigo_item),
    );
    despacho.traslados_items = items.map((it) => ({
      ...it,
      // null (y no "ninguno") cuando el ítem no está en el snapshot: "no sé" y
      // "no tiene clase" son cosas distintas, y el monitor las pinta distinto.
      clase: clases.get(String(it.codigo_item).trim()) ?? null,
    }));
  } catch (err) {
    console.error(`[despacho] no se pudo leer la clase A/B/C de ${despacho.id}:`, err.message);
  }
  return despacho;
}

/**
 * Eliminar un despacho (cascade borra items y firmas).
 */
export async function eliminar(id) {
  return DespachoModel.eliminar(id);
}

/**
 * Reasignar (o quitar) el despachador de un despacho.
 */
export async function reasignarDespachador(id, despachadorId) {
  return DespachoModel.updateDespachador(id, despachadorId);
}

/**
 * Editar los ítems de un despacho (solo en estado Creado).
 */
export async function editarItems(id, items) {
  return DespachoModel.editarItems(id, items);
}

/**
 * Marca (o desmarca) renglones que NO entraron a SIESA.
 *
 * Pasa derecho al modelo, donde viven las guardas (estado del despacho y
 * pertenencia de los items). Es una ANOTACION: no mueve cantidades ni motivos.
 */
export async function marcarItemsSiesaOmitido(id, itemIds, omitido, correo) {
  return DespachoModel.marcarItemsSiesaOmitido(id, itemIds, omitido, correo);
}

/**
 * Crear un despacho nuevo.
 */
export async function crear(payload) {
  return DespachoModel.create(payload);
}

/* =============================================
   BORRADOR — el listado que el admin arma durante la semana (los dos flujos)
   ============================================= */

/**
 * Abre o engorda el listado de una ruta, en UNA sola operación.
 *
 * El panel no tiene que saber si el borrador ya existe: manda los ítems y este
 * método decide. Si el front tuviera que consultar primero y crear después, dos
 * pestañas abiertas podrían crear dos borradores para la misma ruta — y el índice
 * único de la base rechazaría el segundo con un error que el admin no entiende.
 *
 * Semántica de ítem repetido: REEMPLAZAR (decisión del negocio). El panel avisa
 * antes; acá se ejecuta.
 *
 * @param {object} payload - igual que `crear`, con { origen, destino, items[] }
 * @returns {Promise<{despacho:object, agregados:number, actualizados:number, creado:boolean}>}
 */
export async function agregarAlListado(payload) {
  const { origen, destino, items } = payload;

  const existente = await DespachoModel.findBorrador(origen, destino);
  if (!existente) {
    const despacho = await DespachoModel.create({ ...payload, estado: "Borrador" });
    return { despacho, agregados: items.length, actualizados: 0, creado: true };
  }

  const { agregados, actualizados } = await DespachoModel.agregarItemsBorrador(
    existente.id,
    items,
  );
  return {
    despacho: await DespachoModel.findBorrador(origen, destino),
    agregados,
    actualizados,
    creado: false,
  };
}

/** El listado abierto de una ruta (con sus ítems), o null. */
export async function obtenerListado(origen, destino) {
  return DespachoModel.findBorrador(origen, destino);
}

/** Todos los listados abiertos, para mostrarlos en el panel del admin. */
export async function listarListados() {
  return DespachoModel.findBorradores();
}

/**
 * Finalizar el listado: pasa a "Creado" y recién ahí lo ve el despachador.
 * Es el punto sin retorno del flujo semanal — después de esto no se agregan ítems.
 */
export async function finalizarListado(id, despachadorId = null) {
  return DespachoModel.finalizarBorrador(id, { despachadorId });
}

/**
 * Reabrir el listado: "Creado" → "Borrador". Deshace el envío a despacho para que
 * se le puedan seguir agregando productos. Solo vale mientras nadie empezó a
 * recolectar — el modelo es el que lo verifica.
 */
export async function reabrirListado(id) {
  return DespachoModel.reabrirBorrador(id);
}

/** Descartar un listado completo sin despacharlo. */
export async function descartarListado(id) {
  return DespachoModel.descartarBorrador(id);
}

/**
 * Cambiar estado de un despacho.
 *
 * El cierre son DOS pasos desde la 017, porque contar y cargar el camión ocurren
 * en momentos distintos:
 *
 *   → Pendiente_carga : terminó el conteo. Se sella `recoleccion_finalizada_at`,
 *                       se auto-clasifican los pendientes del flujo llano y SALEN
 *                       los correos de cierre (cierre + faltantes). El camión sigue
 *                       sin cargarse, pero compras/inventarios ya se enteran de los
 *                       faltantes sin esperar al transporte.
 *   → Recolectado     : el camión se fue (con manifiesto). Recién acá:
 *                       1. Se marca el estado — lo único que falla hacia el usuario.
 *                       2. Se importa la requisición a SIESA.
 *                       3. Sale el correo del manifiesto (PDF) — ver cargarCamion.
 *
 * 2 y 3 son efectos POSTERIORES y ninguno revierte el cierre: cuando el
 * despachador firma, la mercancía ya salió del camión. El despacho es un hecho
 * consumado, no una intención — si el ERP no contesta, la requisición queda
 * pendiente y el cron la reintenta (ver requisicion.service), pero la bodega no
 * se queda trabada esperando a SIESA.
 */
export async function cambiarEstado(id, estado, firmaData, despachadorId = null) {
  // SIN candado de propiedad, ni siquiera al cerrar (→ Recolectado).
  //
  // Antes el cierre exigía ser el dueño, y eso CONTRADECÍA a `assertPuedeCargar`,
  // que desde la recolección multiusuario (023) deja cargar el camión a cualquiera
  // ("le toca a la que esté cuando llega el camión, no a la que apretó Iniciar").
  // Las dos validaciones corren en el mismo cierre: la primera dejaba pasar y la
  // segunda tiraba 403 — pero recién DESPUÉS de que la persona llenó el manifiesto
  // y firmó dos veces. El panel lo tapaba porque tampoco le mostraba el despacho a
  // quien no era el dueño; en cuanto se muestra (que es lo que se pide), el 403
  // aparece. Política confirmada: cargar el camión es de cualquier despachador.
  //
  // Lo que impide un cierre doble NO es la propiedad sino el estado: `updateStatus`
  // ata el UPDATE al estado leído, así que de dos cierres simultáneos el segundo se
  // lleva un 409.
  //
  // `despachadorId` queda en la firma de la función para no tocar a los llamadores,
  // pero acá ya no se usa. La trazabilidad de QUIÉN cargó no se pierde: vive en el
  // manifiesto, que `cargarCamion` arma aparte con su propio `despachador_id`.
  //
  // La transición se valida ANTES de guardar la firma, para no dejar una firma
  // huérfana si el cierre es rechazado (409).
  //
  // Terminar de contar con contenedores (037) exige que estén todos cerrados y
  // recalcula el total de lo que hay en ellos — ver validarParaFinalizar. Va
  // antes del cambio de estado: si algo no cuadra, el despacho sigue en
  // recolección y la persona lo corrige ahí.
  if (estado === "Pendiente_carga") await ContenedoresService.validarParaFinalizar(id);

  const actualizado = await DespachoModel.updateStatus(id, estado);

  // Recién con el estado ya avanzado, persistimos la firma.
  if (firmaData) {
    const rol = estado === "Recolectado" ? "despachador" : "auditor";
    await FirmaModel.create({ despacho_id: id, rol, firma_data: firmaData });
  }

  if (estado === "Pendiente_carga") {
    // #4 — Flujo Llano (00301→00401): el despachador NO elige motivos (el front le
    // oculta el selector), así que los pone el sistema. Los tres del maestro:
    //   · no se recolectó y no hay stock  → Agotado (sin_stock)
    //   · no se recolectó pero HAY stock  → Inventario Fantasma (inventario_inflado)
    //   · se recolectó menos de lo pedido → Surtido parcial (surtido_parcial)
    //
    // Corre acá y no en `Recolectado` porque es una consecuencia de HABER
    // TERMINADO DE CONTAR, no de que el camión se haya ido: lo que quedó pendiente
    // ya no se va a recolectar. Además se consulta el stock en vivo, y cuanto más
    // cerca del conteo, más fiel es. Igual queda resuelto antes del cierre, así que
    // los correos y SIESA lo siguen viendo hecho.
    //
    // Best-effort: si falla, los pendientes quedan como están y el despacho igual
    // avanza.
    try {
      const despacho = await DespachoModel.findById(id);
      if (despacho.flujo === "llano") {
        // QUÉ CUENTA COMO PENDIENTE — no alcanza con `cantidad_despachador == null`.
        //
        // El front, un paso antes de este cambio de estado, llama a /recolectar con
        // TODOS los renglones del despacho, incluidos los que nadie tocó, y esos
        // viajan en 0. O sea: para cuando corre esta clasificación ya no queda un
        // solo `null` y el filtro viejo encontraba SIEMPRE cero pendientes. Por eso
        // no aparecía ni un motivo automático — ni Agotado ni Inventario Fantasma.
        //
        // Un 0 SIN motivo y sin `agotado` es exactamente lo mismo que un null: nadie
        // recolectó ese ítem. Un 0 CON motivo ya lo clasificó una persona y no se
        // toca — la decisión del despachador manda sobre la automática.
        const pendientes = (despacho.traslados_items || []).filter(
          (it) =>
            !it.motivo &&
            !it.agotado &&
            (it.cantidad_despachador == null || Number(it.cantidad_despachador) === 0),
        );
        // El tercer motivo del maestro: se recolectó ALGO, pero menos de lo pedido.
        // No depende del stock en vivo (por definición había algo en la góndola), así
        // que se resuelve sin consultar SIESA. Sin esta rama, el flujo llano solo
        // sabía marcar los faltantes totales y los renglones a medias quedaban sin
        // motivo — que es la mitad de los faltantes que ve compras.
        const parciales = (despacho.traslados_items || []).filter((it) => {
          if (it.motivo || it.agotado) return false;
          const recogido = Number(it.cantidad_despachador);
          const pedido = Number(it.cantidad_admin) || 0;
          return recogido > 0 && pedido > 0 && recogido < pedido;
        });

        // Escrituras del SISTEMA (sin dueño), acotadas a este despacho igual que
        // las de una persona.
        for (const item of parciales) {
          await ItemModel.updateCantidadDespachador(
            item.id,
            Number(item.cantidad_despachador),
            false,
            "surtido_parcial",
            null,
            null,
            null,
            null,
            id,
          );
        }

        if (pendientes.length > 0) {
          const stock = await getStockLote({
            sede: despacho.origen,
            items: pendientes.map((it) => it.codigo_item),
          });
          // UN FALLO DE LA CONSULTA NO ES UN CERO.
          //
          // `getStockLote` devuelve `{ disponible: 0, error: true }` cuando SIESA no
          // contesta —un 401 de permisos sobre la consulta estándar, por ejemplo—, y
          // leer ese 0 como "no hay stock" marcaba TODOS los pendientes como Agotado.
          // Eso no es un motivo mal puesto: es inventar la novedad que compras y la
          // API de integraciones leen como verdad, y borra por completo el caso
          // Inventario Fantasma — que es justo el que hay que perseguir.
          //
          // Sin dato no se clasifica. El renglón queda sin motivo y lo resuelve una
          // persona, como antes de que existiera esta automatización.
          let sinDato = 0;
          for (const item of pendientes) {
            const s = stock[item.codigo_item];
            if (!s || s.error) {
              sinDato++;
              continue;
            }
            const disponible = Number(s.disponible ?? 0);
            if (disponible <= 0) {
              // Sin stock → Agotado
              await ItemModel.updateCantidadDespachador(item.id, 0, true, "sin_stock", null, null, null, null, id);
            } else {
              // Hay stock pero no se recolectó → Fantasma
              await ItemModel.updateCantidadDespachador(item.id, 0, false, "inventario_inflado", null, null, null, null, id);
            }
          }
          if (sinDato > 0) {
            console.error(
              `[despacho] llano ${id}: ${sinDato} faltante(s) SIN clasificar — la consulta ` +
                `de stock a SIESA falló. Revisar permisos de la consulta estándar.`,
            );
          }
        }

        console.log(
          `[despacho] llano ${id}: auto-clasificados ${pendientes.length} faltante(s) total(es) ` +
            `y ${parciales.length} parcial(es)`,
        );
      }
    } catch (err) {
      console.error("[despacho] auto-marcado #4 falló (no bloquea):", err.message);
    }

    // Correo de cierre de recolección (cierre + faltantes + inflado): sale ACÁ, al
    // TERMINAR DE CONTAR, no al cargar el camión. Antes esperaba a `Recolectado` y
    // compras/inventarios se enteraban de los faltantes recién cuando el transporte
    // llegaba —horas después—; moverlo acá los avisa apenas cierra la recolección.
    //
    // Va DESPUÉS de la auto-clasificación del flujo llano (arriba) para que los
    // motivos automáticos ya estén puestos y el correo los muestre. Se relee el
    // despacho para tomar esos motivos recién escritos.
    //
    // SIESA y el correo del manifiesto (PDF) NO se movieron: siguen colgando de
    // `Recolectado` (subir camión), porque reflejan que la mercancía salió DE
    // VERDAD en el camión. Best-effort: nunca revierte el cierre del conteo.
    //
    // Se REENVÍA si el despachador vuelve a recolección y re-finaliza: el correo
    // lleva siempre el estado más reciente del conteo (decisión de negocio).
    try {
      const despacho = await DespachoModel.findById(id);
      await notificarRecoleccionCerrada(despacho);
    } catch (err) {
      console.error("[despacho] notificación de cierre falló:", err.message);
    }
  }

  if (estado === "Recolectado") {
    // El correo de cierre YA salió al finalizar la recolección (Pendiente_carga).
    // Acá queda subir a SIESA con las cantidades del DESPACHADOR. La palabra la tiene el
    //    despachador: SIESA refleja lo que salió del camión. El auditor ya NO sube
    //    a SIESA — solo verifica y manda el correo comparativo (ver
    //    confirmarAuditoria). Patrón resiliente: marcar 'pendiente' ANTES de
    //    intentar, para que el cron lo levante si esta instancia muere en el envío.
    try {
      await marcarRequisicionPendiente(id);
      const despacho = await DespachoModel.findById(id);
      // Nunca lanza; { estado, motivo, siesaData?, httpStatus? }
      const r = await enviarRequisicion(despacho);
      // Si la subida NO salió, avisar al líder de inventarios. Los 'omitido' son
      // benignos (ya enviado / carrera).
      //
      // 'incierto' va por otro correo, y esa separación es el arreglo de un
      // incidente concreto (09/09/2026, despacho 5f4ed946). Hasta hoy este `if`
      // no lo incluía: el ÚNICO estado que exige una persona era el único que no
      // le avisaba a ninguna. Y no alcanza con agregarlo acá, porque el mensaje
      // que hace falta es el opuesto — un "error al subir" empuja a ir al ERP y
      // hacer el documento a mano, que es exactamente lo que pasó y lo que
      // duplica movimientos. El correo de incierto pide lo contrario: esperar,
      // porque el barrido lo verifica contra SIESA en los próximos minutos.
      if (r && r.estado === "incierto") {
        // Sin la consulta de tránsito no hay barrido que lo resuelva, así que no
        // se le promete a nadie una verificación que no va a ocurrir.
        const situacion = consultaConfigurada() ? "detectado" : "trabado";
        await enviarInciertoSiesa(despacho, { situacion, detalle: r.motivo }).catch((e) =>
          console.error("[despacho] correo de incierto SIESA falló:", e.message),
        );
      } else if (r?.esperandoEntrada) {
        // NO es un error: la salida entró y la entrada sale sola en unos minutos
        // (SIESA necesita ese rato para dejar la salida lista). Sin esta rama,
        // el cierre normal de CADA despacho mandaría un correo de error, y una
        // alarma que suena siempre es una alarma que nadie mira.
        console.log(`[despacho] ${id}: salida en SIESA, la entrada queda en cola.`);
      } else if (r && (r.estado === "fallido" || r.estado === "pendiente")) {
        await enviarErrorSiesa(despacho, r).catch((e) =>
          console.error("[despacho] correo de error SIESA falló:", e.message),
        );
      }
    } catch (err) {
      console.error("[despacho] envío a SIESA falló (queda pendiente):", err.message);
    }
  }

  return actualizado;
}

/**
 * Deja la requisición en 'pendiente' si todavía no se envió.
 * Es la red de seguridad: si el proceso muere durante el envío, el cron la ve.
 */
async function marcarRequisicionPendiente(id) {
  await DespachoModel.marcarSiesaPendiente(id);
}

/**
 * Iniciar recolección reclamando el despacho (modelo pool).
 * Atómico: solo funciona si sigue en "Creado", dos despachadores no lo toman a la vez.
 * Si el despacho se creó sin despachador asignado, se asigna en este paso.
 */
export async function iniciarRecoleccion(id, despachadorId) {
  return DespachoModel.iniciarRecoleccion(id, despachadorId);
}

/**
 * Abandonar la recolección: el dueño suelta el despacho, que vuelve al pool
 * LIMPIO (reset de cantidades). Dos pasos, en orden:
 *   1. Flip atómico con candado de propiedad (valida dueño + estado). Si falla
 *      (403/409/404), NO se resetea nada.
 *   2. Reset de las cantidades de los ítems: el próximo cuenta y firma desde cero.
 */
export async function abandonarRecoleccion(id, despachadorId) {
  if (!despachadorId) {
    const e = new Error("Falta identificar al despachador que abandona");
    e.statusCode = 400;
    e.expose = true;
    throw e;
  }
  const despacho = await DespachoModel.abandonarRecoleccion(id, despachadorId);
  await ItemModel.resetRecoleccionByDespacho(id);
  // Los contenedores son parte del conteo: si quedaran, el próximo encontraría
  // canastillas "llenas" con productos que el reset acaba de poner sin contar.
  await ContenedoresService.borrarTodos(id);
  return despacho;
}

/**
 * Verificar que un despachador puede escribir sobre la recolección de un despacho
 * (existe, está En_recoleccion y es suyo). Candado de propiedad — ver el modelo.
 */
export async function assertPuedeRecolectar(despachoId, despachadorId) {
  return DespachoModel.assertPuedeRecolectar(despachoId, despachadorId);
}

/**
 * Envía lo que ya está listo y pasa lo pendiente a un traslado nuevo.
 *
 * Solo el flujo LLANO. En General finalizar EXIGE que cada renglón esté
 * resuelto, así que no existe el escenario de "lo dejo a medias": la persona
 * tiene que decidir producto por producto antes de cerrar. El llano es el que
 * auto-clasifica lo que quedó sin tocar, y por eso es el que necesita esta
 * salida (ver el encabezado de sql/032).
 */
export async function dividirEnPartes(id) {
  const despacho = await DespachoModel.findById(id);
  if (!despacho) throw createError(404, "Despacho no encontrado");
  if ((despacho.flujo || "general") !== "llano") {
    throw createError(
      409,
      "Enviar por partes es del flujo Llano. En General hay que resolver cada producto antes de cerrar.",
    );
  }
  // Las canastillas CERRADAS viajan en esta primera parte con todo su contenido
  // (lo que tiene unidades nunca se muda). Una ABIERTA es una que alguien está
  // llenando: partir ahora dejaría su contenido a medio declarar.
  const abiertos = await ContenedoresService.hayAbiertos(id);
  if (abiertos.length) {
    throw createError(
      409,
      `Cerrá ${abiertos.length === 1 ? "la canastilla" : "las canastillas"} ${abiertos
        .map((c) => c.numero)
        .join(", ")} antes de enviar la primera parte.`,
    );
  }
  return DespachoModel.dividirEnPartes(id);
}

/**
 * CAMIÓN CARGADO — cierra la recolección con el manifiesto de carga.
 *
 * Es el reemplazo del cierre directo: antes el despachador firmaba y el despacho
 * pasaba a `Recolectado` de una. Ahora primero llena el manifiesto (quién se lleva
 * la carga, en qué camión, cuánto pesa) y este endpoint hace las dos cosas.
 *
 * POR QUÉ ACÁ Y NO EN `cambiarEstado`
 * El disparo de SIESA NO se movió: sigue colgando de `Recolectado`. Lo que se
 * movió es CUÁNDO el despacho llega a ese estado — ahora es cuando el camión sale
 * de verdad, no cuando el despachador terminó de contar. Todo lo que colgaba de
 * `Recolectado` (correos, auto-clasificación del flujo llano, subida a SIESA, y el
 * `disponible_at` que arranca el reloj del auditor) sigue igual y ahora ocurre en
 * el momento correcto.
 *
 * ORDEN DE LAS OPERACIONES — importa:
 *   1. Guard: existe, no inactivo, en `Pendiente_carga` y del despachador que
 *      llama. Va PRIMERO para no dejar un manifiesto huérfano si el cierre iba a
 *      ser rechazado igual (403/409).
 *   2. Manifiesto.
 *   3. Cierre `Pendiente_carga` → `Recolectado`, y con él SIESA y los correos.
 *
 * Si el paso 3 falla (por ejemplo, otro despachador cerró en el medio), el
 * manifiesto ya quedó escrito. Por eso el paso 2 REUSA el existente en vez de
 * fallar con "ya tiene manifiesto": un reintento tiene que poder completar el
 * cierre, no quedar trabado por su propio intento anterior.
 *
 * @param {string} despachoId
 * @param {object} manifiesto - datos del formulario (vehículo, conductor, ruta, peso)
 * @param {object} opts
 * @param {string} opts.despachadorId
 * @param {string} [opts.firmaData] - firma del despachador (base64)
 * @returns {Promise<{manifiesto:object, despacho:object}>}
 */
export async function cargarCamion(
  despachoId,
  manifiesto = {},
  { despachadorId, firmaData, firmaConductor, pdfBase64 } = {},
) {
  // 1. ¿Puede cargar? (existe, no inactivo, está Pendiente_carga y es suyo)
  await DespachoModel.assertPuedeCargar(despachoId, despachadorId);

  // 2. Manifiesto — idempotente ante un reintento del cierre.
  let doc = await ManifiestoModel.porDespacho(despachoId);
  if (!doc) {
    doc = await ManifiestoModel.crear(despachoId, {
      ...manifiesto,
      despachador_id: despachadorId,
    });
  }

  // 3. Cierre. Acá se dispara todo lo que cuelga de `Recolectado`.
  //    `cambiarEstado` persiste la firma del DESPACHADOR (rol 'despachador').
  const despacho = await cambiarEstado(despachoId, "Recolectado", firmaData, despachadorId);

  // 3b. Firma del CONDUCTOR — se guarda junto a la del despachador para que la
  //     reimpresión del manifiesto pueda re-estampar ambas. Va DESPUÉS del cierre
  //     (que ya validó propiedad y transición) y es best-effort: el camión ya
  //     salió, un fallo al guardar la firma no puede tumbar el cierre.
  if (firmaConductor) {
    try {
      await FirmaModel.create({
        despacho_id: despachoId,
        rol: "conductor",
        firma_data: firmaConductor,
      });
    } catch (e) {
      console.error("[despacho] no se pudo guardar la firma del conductor:", e.message);
    }
  }

  // 4. Correo a inventarios con el PDF del manifiesto. VA DESPUÉS del cierre y es
  //    best-effort: la carga ya es un hecho y se subió a SIESA; un fallo de correo
  //    no puede tumbar el flujo. Por eso no se await-ea dentro de un try que
  //    propague — se atrapa acá mismo.
  //    Se relee el despacho COMPLETO en vez de reusar el que devuelve el cierre:
  //    `updateStatus` devuelve la cabecera sola, sin `traslados_items`, y el correo
  //    informa cuántos renglones salieron. Con la cabecera pelada ese conteo decía
  //    siempre "0 de 0".
  DespachoModel.findById(despachoId)
    .then((completo) => enviarManifiestoCarga(completo || despacho, doc, pdfBase64))
    .catch((e) => console.error("[despacho] correo del manifiesto falló:", e.message));

  return { manifiesto: doc, despacho };
}

/** El manifiesto de un despacho (para el panel del admin y el del auditor). */
/**
 * Todos los manifiestos, con filtro de fecha. Ver el modelo para el porqué de
 * mostrarlos todos y no solo los propios.
 */
export async function listarManifiestos(opts) {
  return ManifiestoModel.listarTodos(opts);
}

export async function obtenerManifiesto(despachoId) {
  const doc = await ManifiestoModel.porDespacho(despachoId);
  if (!doc) return null;

  // Adjuntamos las firmas del DESPACHADOR y el CONDUCTOR para que la reimpresión
  // del manifiesto (front) las re-estampe en el PDF. La del AUDITOR queda afuera a
  // propósito: no pertenece al manifiesto, vive solo en la zona de auditoría.
  // Best-effort: si la lectura falla, el manifiesto igual se devuelve (la
  // reimpresión saldrá sin firmas, como antes de esto).
  const firmas = {};
  try {
    const registros = await FirmaModel.findByDespacho(despachoId);
    for (const f of registros || []) {
      // `findByDespacho` viene ordenada asc por fecha: la última de cada rol gana.
      if (f.rol === "despachador" || f.rol === "conductor") firmas[f.rol] = f.firma_data;
    }
  } catch (e) {
    console.error("[despacho] no se pudieron leer las firmas del manifiesto:", e.message);
  }

  // Canastillas que viajaron (037), para que la reimpresión las liste igual que
  // el PDF que se generó al cargar. Best-effort: sin esto sale como antes.
  let contenedores = null;
  try {
    const [despacho, lista] = await Promise.all([
      DespachoModel.findById(despachoId),
      ContenedorModel.listarPorDespacho(despachoId),
    ]);
    contenedores = ContenedoresService.resumenParaManifiesto(despacho?.traslados_items || [], lista);
  } catch (e) {
    console.error("[despacho] no se pudieron leer los contenedores del manifiesto:", e.message);
  }

  return { ...doc, firmas, contenedores };
}

/**
 * Registrar cantidad recolectada por el despachador para un item.
 * `motivo` (opcional): motivo del faltante — ver ItemModel.MOTIVOS_FALTANTE.
 * `despachoId`: el renglón TIENE que ser de ese despacho (ver el modelo).
 */
export async function registrarRecoleccion(itemId, cantidad, agotado, motivo = null, nueva_um = null, nueva_cant_admin = null, nuevo_factor = null, recolectadoPor = null, despachoId = null, cantidadSuelta = null) {
  return ItemModel.updateCantidadDespachador(itemId, cantidad, agotado, motivo, nueva_um, nueva_cant_admin, nuevo_factor, recolectadoPor, despachoId, cantidadSuelta);
}

/** Renglones por tanda en `registrarLoteRecoleccion`. */
export const TANDA_RECOLECCION = 8;

/**
 * Escribe un lote de conteos del despachador (`POST /:id/recolectar`).
 *
 * TRES RESPUESTAS POR RENGLÓN, y solo una es un error de verdad:
 *   · escrito                     → va en `resultados`.
 *   · RENGLON_TOMADO              → lo cuenta otra persona: va en `conflictos`
 *                                   para que el front lo marque como ajeno.
 *   · RENGLON_FUERA_DEL_DESPACHO  → ya no es de este traslado (se mudó a la parte
 *                                   2 o se quitó): va en `fuera_de_despacho`. No
 *                                   se escribe en ningún lado, y el front deja de
 *                                   reintentarlo porque la respuesta es 200.
 * Cualquier otro error (red, 422 de tope) se propaga: no es un choque esperable y
 * esconderlo sería perder el conteo en silencio.
 *
 * POR QUÉ DE A TANDAS, CON UNA CERCA ENTRE TANDA Y TANDA
 * El cierre del front manda TODOS los renglones en un solo POST, y escribirlos
 * lleva segundos. Antes el estado del despacho se miraba una sola vez al entrar:
 * si en ese rato otro celular cerraba, abandonaba o partía el traslado, el POST
 * seguía escribiendo como si nada — así fue como un cierre le escribió ceros a la
 * parte 2 de otro traslado. Ahora, antes de cada tanda se vuelve a verificar que
 * el despacho siga En_recoleccion; si cambió, se corta con 409 y lo que no se
 * escribió queda pendiente en el celular (el front no lo borra ante un error).
 *
 * Dentro de la tanda se escribe en paralelo: son renglones distintos (el lote se
 * deduplica antes, gana la última aparición de cada id) y así un cierre de 300
 * renglones no se acerca al tiempo máximo de la función en Vercel.
 *
 * @param {string} despachoId
 * @param {Array<object>} items - [{ id, cantidad, agotado?, motivo?, nueva_unidad_medida?, ... }]
 * @param {string|null} despachadorId - correo de quien cuenta
 * @returns {Promise<{resultados: object[], conflictos: object[], fuera_de_despacho: object[]}>}
 */
export async function registrarLoteRecoleccion(despachoId, items, despachadorId = null) {
  await DespachoModel.assertPuedeRecolectar(despachoId, despachadorId);

  const unicos = [...new Map((items || []).map((it) => [it.id, it])).values()];

  const resultados = [];
  const conflictos = [];
  const fuera = [];

  for (let desde = 0; desde < unicos.length; desde += TANDA_RECOLECCION) {
    if (desde > 0) await DespachoModel.assertPuedeRecolectar(despachoId, despachadorId);

    const tanda = unicos.slice(desde, desde + TANDA_RECOLECCION);
    const salidas = await Promise.allSettled(
      tanda.map((item) =>
        registrarRecoleccion(
          item.id,
          item.cantidad,
          item.agotado,
          item.motivo,
          item.nueva_unidad_medida,
          item.nueva_cantidad_admin,
          item.nuevo_factor,
          despachadorId,
          despachoId,
          item.cantidad_suelta ?? null,
        ),
      ),
    );

    let errorGrave = null;
    salidas.forEach((s, i) => {
      if (s.status === "fulfilled") {
        resultados.push(s.value);
        return;
      }
      const err = s.reason;
      if (err?.codigo === "RENGLON_TOMADO") {
        conflictos.push({ item_id: tanda[i].id, dueno: err.dueno, error: err.message });
      } else if (err?.codigo === "RENGLON_FUERA_DEL_DESPACHO") {
        fuera.push({ item_id: tanda[i].id, error: err.message });
        console.warn(
          `[recolectar] ${despachoId}: el renglón ${tanda[i].id} ya no es de este despacho — no se escribió`,
        );
      } else if (!errorGrave) {
        errorGrave = err;
      }
    });
    // Se espera a que termine la tanda entera antes de propagar: lo que ya se
    // escribió queda escrito, y el reintento del front es idempotente.
    if (errorGrave) throw errorGrave;
  }

  return { resultados, conflictos, fuera_de_despacho: fuera };
}

/**
 * ¿Este ítem NO salió de la bodega origen?
 * Marcado agotado, o recolectado en 0 ⇒ nunca subió al camión.
 *
 * Esta es la MISMA regla con la que el auditor recibe su lista (ver
 * auditor.controller). Tiene que ser una sola: si el auditor no ve un ítem pero
 * la comparación sí lo cuenta, aparece una diferencia que él no puede resolver
 * ni entender. Lo que se oculta y lo que se compara deben coincidir siempre.
 *
 * `cantidad_despachador == null` es "nunca se registró", no "no se envió": ese
 * ítem sigue visible y sigue comparándose.
 */
export function noSalioDeOrigen(item) {
  return (
    item.agotado === true ||
    (item.cantidad_despachador != null && Number(item.cantidad_despachador) === 0)
  );
}

/**
 * ¿El ítem NO debe llegar al auditor? Une dos motivos distintos:
 *   1. No salió de origen (agotado / recolectado en 0) — no hay nada físico.
 *   2. El admin lo EXCLUYÓ (`siesa_omitido`) — se maneja aparte, fuera del
 *      flujo automático, así que tampoco entra a la recepción.
 *
 * OJO: un excluido SÍ salió de origen (su cantidad no se toca), por eso NO va
 * dentro de noSalioDeOrigen — ese nombre mentiría, y el correo de faltantes que
 * lo usa cuenta lo que físicamente no viajó, cosa que un excluido sí hizo.
 *
 * Tiene que ser la MISMA regla en la lista del auditor y en la comparación: si
 * el auditor no ve un ítem pero la comparación lo cuenta, le aparece una
 * diferencia fantasma que no puede resolver.
 */
export function ocultoParaAuditor(item) {
  return noSalioDeOrigen(item) || item.siesa_omitido === true;
}

/**
 * Auditoría — Paso 1: COMPARAR (solo lectura, no firma, no cambia estado).
 * Revela la comparación entre lo que recolectó el despachador y lo que contó el
 * auditor. `match` es true si ninguna diferencia es distinta de 0.
 *
 * Solo compara los ítems que el auditor pudo ver (los que salieron de origen).
 *
 * @param {string} despachoId
 * @param {Array<{id, cantidad_auditor}>} itemsAuditor
 * @returns {{ match: boolean, differences: Array }}
 */
export async function compararAuditoria(despachoId, itemsAuditor) {
  const despacho = await DespachoModel.findById(despachoId);
  if (!despacho) throw createError(404, "Despacho no encontrado");

  // Con canastillas (038), todas cerradas o declaradas no recibidas.
  await RecepcionContenedores.validarParaComparar(despachoId);

  // Trazabilidad (#1): el primer comparar marca el inicio de la auditoría.
  // Best-effort e idempotente — nunca frena la comparación.
  await DespachoModel.marcarAuditoriaIniciada(despachoId).catch((e) =>
    console.error("[auditoría] no se pudo marcar inicio:", e.message),
  );

  // Y refresca la señal de actividad para el barrido de alertas: comparar es
  // trabajo del auditor igual que abrir. Sin esto, un recuento largo entre el
  // Comparar y el Confirmar podría quedar fuera de la ventana de gracia y el
  // traslado se inactivaría con la persona todavía contando. Ver migración 015.
  await DespachoModel.marcarAuditoriaAbierta(despachoId).catch(() => {});

  // El conteo que se compara es el del SERVIDOR (todos los auditores sumados)
  // cuando existe. El del cuerpo queda solo para un panel viejo que todavía no
  // guarda escaneo por escaneo — ver `conteoDeRecepcion`.
  const { porItem, hayConteos } = await conteoDeRecepcion(despachoId);
  const conteoAuditor = hayConteos
    ? new Map([...porItem].map(([id, c]) => [id, c.cantidad]))
    : new Map((itemsAuditor || []).map((i) => [i.id, Number(i.cantidad_auditor) || 0]));

  let match = true;
  // Devolvemos TODOS los items comparados (no solo los que difieren) para que el
  // panel muestre la tabla completa; `match` indica si hubo alguna discrepancia.
  const visibles = (despacho.traslados_items || []).filter((it) => !ocultoParaAuditor(it));
  const differences = visibles.map((item) => {
    const cantidadAuditor = conteoAuditor.has(item.id)
      ? conteoAuditor.get(item.id)
      : 0;
    // Canonicalización a UND: el auditor cuenta y envía en UND. El despachador
    // guardó en la unidad del ítem, pero `cantidad_despachador × factor` da SIEMPRE
    // el total real en UND (el factor queda sincronizado con la unidad guardada).
    // Así la comparación es en la misma unidad y no compara peras con manzanas.
    const cantidadDespachador =
      (Number(item.cantidad_despachador) || 0) * (Number(item.factor) || 1);
    const diferencia = cantidadAuditor - cantidadDespachador;
    if (diferencia !== 0) match = false;

    return {
      id: item.id,
      codigo_item: item.codigo_item,
      descripcion: item.descripcion,
      cantidad_despachador: cantidadDespachador,
      cantidad_auditor: cantidadAuditor,
      diferencia,
      no_recibido: item.no_recibido || false,
    };
  });

  return { match, differences };
}

/**
 * Completa código, descripción y UM de un ítem que el auditor agregó fuera de
 * lista, consultando SIESA por lo que se escaneó.
 *
 * Best-effort a propósito: si la consulta falla, se inserta lo que mandó el front.
 * Un renglón sin descripción es un problema de lectura; perder el conteo del
 * auditor por un timeout de SIESA es un problema de inventario.
 */
async function completarFichaItem(item) {
  // Se consulta SIEMPRE, aunque el front ya haya mandado descripción. Antes se
  // salía temprano en ese caso, y con eso se perdían dos cosas que el front NO
  // tiene: el `grupo` (para que el ítem caiga en su pasillo y no en "Sin grupo")
  // y la traducción del código de barras al código SIESA — que es lo que hace que
  // la FOTO cargue, porque el catálogo de imágenes se busca por código SIESA.
  try {
    const ficha = await fichaDeItem(item?.codigo_item);
    return {
      ...item,
      // El código resuelto manda sobre el escaneado: si el lector devolvió un EAN,
      // guardarlo crudo deja el renglón sin imagen para siempre.
      codigo_item: ficha.codigo_item || item?.codigo_item,
      // La descripción del front gana: puede ser la que el auditor escribió a mano
      // para algo que ningún catálogo conoce.
      descripcion: item?.descripcion || ficha.descripcion || null,
      unidad_medida: item?.unidad_medida || ficha.unidad_medida || "UND",
      grupo: item?.grupo || ficha.grupo || null,
      categoria: item?.categoria || ficha.subgrupo || null,
    };
  } catch (err) {
    console.error("[auditoria] no se pudo completar la ficha del ítem:", err.message);
    return item;
  }
}

/**
 * Auditoría — Paso 2: CONFIRMAR (decisión + firma, finaliza el despacho).
 * Persiste cantidad_auditor y diferencia por item, la firma del auditor y el
 * auditor_id, y avanza el estado según la decisión.
 *
 * @param {string} despachoId
 * @param {object} payload
 * @param {"aprobado"|"inconsistencia"|"rechazado"} payload.decision
 * @param {string} [payload.auditorId]
 * @param {string} payload.firmaData
 * @param {Array<{id, cantidad_auditor}>} payload.items
 * @returns {{ estado: string }}
 */
/** Estados en los que se puede confirmar la recepción. */
const ESTADOS_AUDITABLES = ["Recolectado", "En_recepcion"];

/**
 * El conteo de la recepción según el SERVIDOR (migración 036): lo que guardaron
 * todos los auditores, escaneo por escaneo, consolidado por producto.
 *
 * POR QUÉ MANDA SOBRE LO QUE TRAE EL CUERPO
 * Con varios auditores, el celular que firma no es dueño de todo el conteo: lo
 * de su compañero está acá, no en su pantalla. Y aunque cuente uno solo, lo que
 * está en la base es lo que sobrevivió — el borrador del celular puede ser una
 * foto vieja de otra pestaña.
 *
 * `hayConteos = false` es un panel VIEJO (todavía en caché del navegador al
 * desplegar) que no guarda por escaneo: ahí el cuerpo es la única fuente y se
 * usa como antes. Sin este respaldo, ese auditor firmaría todo en cero.
 */
async function conteoDeRecepcion(despachoId) {
  try {
    return ConteoModel.consolidar(await ConteoModel.listarPorDespacho(despachoId));
  } catch (err) {
    // Sin la tabla (migración sin correr) o con la base caída a medias, se
    // comporta como antes. Firmar con el conteo del cuerpo es lo que se hacía
    // hasta hoy; firmar en cero no se hizo nunca.
    console.error("[auditoría] no se pudo leer el conteo del servidor:", err.message);
    return { porItem: new Map(), extras: [], hayConteos: false };
  }
}

/**
 * Arma los ítems a confirmar desde el conteo del servidor, con la MISMA forma
 * que mandaba el panel (`construirPayloadAuditoria` + `construirPayloadExtras`):
 *
 *   · No recibido → cantidad 0 + no_recibido.
 *   · Contado     → lo contado; si quedó en 0 tras un "Recontar" que nadie
 *                   volvió a escanear, lo último que alguien contó de verdad
 *                   (el previo). El 0 del reset no es una medición.
 *   · Sin filas   → 0, igual que un renglón que el panel mandaba sin contar.
 *   · Fuera de lista → `nuevo: true`, solo si se contó algo.
 */
function itemsDesdeConteo(visibles, { porItem, extras }) {
  const existentes = visibles.map((it) => {
    const c = porItem.get(it.id);
    if (!c) return { id: it.id, cantidad_auditor: 0 };
    if (c.noRecibido) return { id: it.id, cantidad_auditor: 0, no_recibido: true };
    const cantidad = c.cantidad > 0 ? c.cantidad : Number(c.previo) || 0;
    return { id: it.id, cantidad_auditor: cantidad };
  });
  const nuevos = extras
    .filter((e) => e.cantidad > 0)
    .map((e) => ({
      nuevo: true,
      codigo_item: e.codigo_item,
      descripcion: e.descripcion || undefined,
      unidad_medida: e.unidad_medida || undefined,
      cantidad_auditor: e.cantidad,
    }));
  return [...existentes, ...nuevos];
}

/** Código sin el relleno de ceros de SIESA ("0189202" → "189202"). */
const codigoSinCeros = (c) => {
  const t = String(c ?? "").trim();
  return t.replace(/^0+/, "") || t;
};

export async function confirmarAuditoria(despachoId, { decision, auditorId, firmaData, items: itemsCuerpo }) {
  const ESTADO_POR_DECISION = {
    aprobado: "Auditado",
    inconsistencia: "Recibido_con_inconsistencia",
    rechazado: "Rechazado",
  };
  const estadoFinal = ESTADO_POR_DECISION[decision];
  if (!estadoFinal) throw createError(400, `Decisión inválida: ${decision}`);

  // GUARDA ANTES DE ESCRIBIR. Antes el estado se validaba recién al final
  // (`updateStatus`), DESPUÉS de haber pisado los conteos: un segundo confirmar
  // —el reintento de una red lenta, dos pestañas— reescribía la recepción de un
  // traslado ya cerrado y recién ahí rebotaba con 409. Los datos ya estaban
  // cambiados.
  const despacho = await DespachoModel.findById(despachoId);
  if (!despacho) throw createError(404, "Despacho no encontrado");
  if (despacho.inactivo) {
    throw createError(
      409,
      "Este traslado está inactivo. Reactivalo desde el panel de alertas para continuar.",
    );
  }
  if (!ESTADOS_AUDITABLES.includes(despacho.estado)) {
    throw createError(
      409,
      `Este traslado ya está en ${despacho.estado}: la recepción se confirmó antes. No se modificó nada.`,
    );
  }

  // Con canastillas (038), todas resueltas antes de firmar — también acá y no
  // solo en comparar: confirmar es la puerta que escribe.
  await RecepcionContenedores.validarParaComparar(despachoId);

  const renglones = despacho.traslados_items || [];
  const renglonPorId = new Map(renglones.map((r) => [r.id, r]));

  // Lo que se firma es el conteo del servidor si existe (ver conteoDeRecepcion).
  const conteo = await conteoDeRecepcion(despachoId);
  const items = conteo.hayConteos
    ? itemsDesdeConteo(
        renglones.filter((r) => !ocultoParaAuditor(r)),
        conteo,
      )
    : itemsCuerpo;

  // Pertenencia, también ANTES de escribir: un id que no es de este traslado no
  // puede terminar con el conteo de otro. Se rechaza entero y no se ignora: el
  // conteo sigue en el dispositivo del auditor y una recarga lo resuelve.
  const existentes = items.filter((it) => !(it?.nuevo || it?.id == null));
  const ajenos = existentes.filter((it) => !renglonPorId.has(it.id));
  if (ajenos.length > 0) {
    throw createError(
      422,
      `${ajenos.length} producto(s) del conteo no pertenecen a este traslado. Recargá la recepción antes de firmar: no se guardó nada.`,
    );
  }

  // PLAN DEL VALOR FINAL DE CADA RENGLÓN, calculado solo con lo que trae ESTE
  // confirmar — nunca sumando sobre lo que ya hay en la base. Así un reintento
  // escribe exactamente lo mismo que el primer intento.
  //
  // Antes el sobrante que coincidía con un renglón existente se SUMABA a su
  // `cantidad_auditor` guardado: si el primer intento escribía y fallaba después
  // (red, firma), el reintento volvía a sumar y la recepción quedaba con el doble.
  //
  //  - Existentes (traen `id`) → cantidad_auditor + diferencia.
  //  - No recibidos (`no_recibido:true`) → el auditor reporta que no llegó
  //    físicamente; cantidad_auditor=0 + no_recibido=true (#5).
  //  - Nuevos (`nuevo:true`, sin `id`) → mercancía que NO venía en la lista. Si
  //    su código ya es un renglón del traslado, se suma a lo que ESTE conteo dice
  //    de ese renglón; si no, se inserta marcado como agregado_por_auditor.
  const plan = new Map(); // renglonId → { cantidad, noRecibido }
  for (const it of existentes) {
    plan.set(
      it.id,
      it.no_recibido
        ? { cantidad: 0, noRecibido: true }
        : { cantidad: Number(it.cantidad_auditor) || 0, noRecibido: false },
    );
  }

  // Se completa la ficha ANTES de decidir. El auditor agrega escaneando, y lo que
  // devuelve el lector suele ser un EAN sin descripción: resolverlo a código SIESA
  // es lo que permite reconocer que ese "extra" es un renglón que ya estaba, y lo
  // que evita un renglón sin nombre ni imagen en la comparativa y en el correo.
  // De a uno, no en paralelo: cada ficha es una consulta a Connekta, que tiene
  // límite de peticiones, y los sobrantes de una recepción son pocos.
  const nuevos = [];
  for (const it of items.filter((x) => x?.nuevo || x?.id == null)) {
    nuevos.push(await completarFichaItem(it));
  }

  const aInsertar = new Map(); // código normalizado → ítem nuevo (con cantidades sumadas)
  for (const extra of nuevos) {
    const clave = codigoSinCeros(extra.codigo_item);
    const cantidad = Number(extra.cantidad_auditor) || 0;
    const renglon = renglones.find((r) => codigoSinCeros(r.codigo_item) === clave);
    if (renglon) {
      const previo = plan.get(renglon.id);
      // Si se contó algo, llegó: el conteo anula un "no recibido" del mismo renglón.
      plan.set(renglon.id, {
        cantidad: (previo && !previo.noRecibido ? previo.cantidad : 0) + cantidad,
        noRecibido: false,
      });
      console.warn(
        `[auditoría] ${extra.codigo_item} ya es un renglón del despacho ${despachoId}: se suma a ese renglón en vez de duplicarlo.`,
      );
    } else if (aInsertar.has(clave)) {
      const acumulado = aInsertar.get(clave);
      acumulado.cantidad_auditor = (Number(acumulado.cantidad_auditor) || 0) + cantidad;
    } else {
      aInsertar.set(clave, { ...extra, cantidad_auditor: cantidad });
    }
  }

  // Escritura del plan.
  for (const [renglonId, { cantidad, noRecibido }] of plan) {
    if (noRecibido) await ItemModel.marcarNoRecibido(renglonId, despachoId);
    else await ItemModel.updateCantidadAuditor(renglonId, cantidad, despachoId);
  }
  for (const extra of aInsertar.values()) {
    await ItemModel.insertItemAuditor(despachoId, extra);
  }

  // Firma del auditor
  if (firmaData) {
    await FirmaModel.create({
      despacho_id: despachoId,
      rol: "auditor",
      firma_data: firmaData,
    });
  }

  // Quién auditó
  if (auditorId) {
    await DespachoModel.updateAuditor(despachoId, auditorId);
  }

  // Avanzar estado (valida la transición)
  await DespachoModel.updateStatus(despachoId, estadoFinal);

  // La subida a SIESA ya NO ocurre acá: la dispara el DESPACHADOR al cerrar la
  // recolección (ver cambiarEstado), con SUS cantidades. El auditor es control
  // documental — su salida es el correo con la tabla comparativa al líder de
  // inventarios. Best-effort: el cierre de la auditoría ya está persistido.
  try {
    const despacho = await DespachoModel.findById(despachoId);
    // Lo de las canastillas (038) va como una línea más; sin canastillas, null.
    const canastillas = await RecepcionContenedores.detalleAdmin(despachoId)
      .then(RecepcionContenedores.textoResumenCorreo)
      .catch(() => null);
    await enviarComparativoAuditoria(despacho, decision, { canastillas });
  } catch (err) {
    console.error("[auditoría] correo comparativo falló:", err.message);
  }

  return { estado: estadoFinal };
}

/**
 * Generar planilla Excel de un despacho.
 * @param {string} despachoId
 * @param {string} tipo - "recoleccion" | "final"
 */
export async function generarPlanilla(despachoId, tipo) {
  const despacho = await DespachoModel.findById(despachoId);
  if (!despacho) throw new Error("Despacho no encontrado");

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Backend Traslados — Merkahorro";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet(
    tipo === "recoleccion" ? "Plano Recolección" : "Plano Final",
  );

  // Columnas. En el plano FINAL todo va canonicalizado a UND para que la fila sea
  // coherente: el despachador guarda en la UM del renglón y el auditor en UND, así
  // que mezclarlos daba filas sin sentido ("despachó 2, contó 96, diferencia 0").
  // En el plano de RECOLECCIÓN se deja la UM del ítem: el despachador recoge packs,
  // no unidades, y ahí la UM nativa es la información útil.
  const esFinal = tipo === "final";
  const sufijoUnd = esFinal ? " (UND)" : "";
  sheet.columns = [
    { header: "Item", key: "codigo", width: 15 },
    { header: "Descripción", key: "descripcion", width: 40 },
    { header: "UM", key: "um", width: 8 },
    { header: `Cant. Admin${sufijoUnd}`, key: "cantAdmin", width: 14 },
    { header: `Cant. Despachador${sufijoUnd}`, key: "cantDespachador", width: 18 },
    { header: `Cant. Auditor${sufijoUnd}`, key: "cantAuditor", width: 14 },
    { header: `Diferencia${sufijoUnd}`, key: "diferencia", width: 14 },
    { header: "Estado", key: "estado", width: 14 },
  ];

  // Estilo header
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF2D1578" },
  };

  // Datos
  despacho.traslados_items?.forEach((item) => {
    const factor = Number(item.factor) || 1;
    // `?? "-"` se conserva: null es "nunca se registró", distinto de un 0 real.
    sheet.addRow({
      codigo: item.codigo_item,
      descripcion: item.descripcion,
      um: item.unidad_medida,
      cantAdmin:
        item.cantidad_admin == null
          ? "-"
          : esFinal
            ? Number(item.cantidad_admin) * factor
            : item.cantidad_admin,
      cantDespachador:
        esFinal && item.cantidad_despachador != null
          ? ItemModel.despachadoEnUnd(item)
          : "-",
      // cantidad_auditor ya está en UND: el auditor cuenta y guarda en UND.
      cantAuditor: esFinal ? (item.cantidad_auditor ?? "-") : "-",
      diferencia: esFinal ? (item.diferencia ?? "-") : "-",
      estado: item.aceptado === true ? "OK" : item.aceptado === false ? "Rechazado" : "Pendiente",
    });
  });

  // Meta-info del despacho
  sheet.addRow([]);
  sheet.addRow([`Despacho: ${despacho.id}`]);
  sheet.addRow([`Origen: ${despacho.origen} → Destino: ${despacho.destino}`]);
  sheet.addRow([`Estado: ${despacho.estado}`]);
  sheet.addRow([`Fecha: ${fechaHoraLegible(despacho.created_at)}`]);

  const buffer = await workbook.xlsx.writeBuffer();
  return buffer;
}
