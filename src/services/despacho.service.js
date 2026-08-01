import * as DespachoModel from "../models/Despacho.model.js";
import * as ItemModel from "../models/Item.model.js";
import * as FirmaModel from "../models/Firma.model.js";
import * as ManifiestoModel from "../models/Manifiesto.model.js";
import { createError } from "../middleware/errorHandler.js";
import {
  notificarRecoleccionCerrada,
  enviarComparativoAuditoria,
  enviarErrorSiesa,
  enviarManifiestoCarga,
} from "./notificacionesTraslado.service.js";
import { enviarRequisicion } from "./requisicion.service.js";
import { getStockLote } from "./siesaStock.service.js";
import { fechaHoraLegible } from "../config/tiempo.js";
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

/** Ítems en despachos activos (para avisar de traslados en curso). */
export function itemsEnDespachosActivos() {
  return DespachoModel.itemsEnDespachosActivos();
}

export async function obtener(id) {
  return DespachoModel.findById(id);
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
 * Crear un despacho nuevo.
 */
export async function crear(payload) {
  return DespachoModel.create(payload);
}

/* =============================================
   BORRADOR — el listado que el admin arma durante la semana (flujo General)
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
 *   → Pendiente_carga : terminó el conteo. Se sella `recoleccion_finalizada_at` y
 *                       se auto-clasifican los pendientes del flujo llano. NADA
 *                       sale todavía: el camión sigue sin cargarse.
 *   → Recolectado     : el camión se fue (con manifiesto). Recién acá:
 *                       1. Se marca el estado — lo único que falla hacia el usuario.
 *                       2. Salen los correos (cierre + faltantes).
 *                       3. Se importa la requisición a SIESA.
 *
 * 2 y 3 son efectos POSTERIORES y ninguno revierte el cierre: cuando el
 * despachador firma, la mercancía ya salió del camión. El despacho es un hecho
 * consumado, no una intención — si el ERP no contesta, la requisición queda
 * pendiente y el cron la reintenta (ver requisicion.service), pero la bodega no
 * se queda trabada esperando a SIESA.
 */
export async function cambiarEstado(id, estado, firmaData, despachadorId = null) {
  // Candado de propiedad SOLO al cerrar la recolección (→ Recolectado): ese cierre
  // es del despachador y dispara el envío a SIESA, así que no puede cerrarlo quien
  // no reclamó el despacho. El resto de transiciones (auditor/admin) pasan sin el
  // opt y conservan el comportamiento previo.
  const ownerGuard = estado === "Recolectado" ? { despachadorId } : {};

  // `updateStatus` valida la transición (En_recoleccion → Recolectado) y, con el
  // ownerGuard, la propiedad — ANTES de guardar la firma, para no dejar una firma
  // huérfana si el cierre es rechazado (403/409).
  const actualizado = await DespachoModel.updateStatus(id, estado, ownerGuard);

  // Recién con el estado ya avanzado, persistimos la firma.
  if (firmaData) {
    const rol = estado === "Recolectado" ? "despachador" : "auditor";
    await FirmaModel.create({ despacho_id: id, rol, firma_data: firmaData });
  }

  if (estado === "Pendiente_carga") {
    // #4 — Flujo Llano (00301→00401): auto-marcar pendientes como Agotado o
    // Fantasma según el stock en vivo. El despachador NO elige motivos en este
    // flujo (los oculta el front).
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
        const pendientes = (despacho.traslados_items || []).filter(
          (it) => it.cantidad_despachador == null,
        );
        if (pendientes.length > 0) {
          const stock = await getStockLote({
            sede: despacho.origen,
            items: pendientes.map((it) => it.codigo_item),
          });
          for (const item of pendientes) {
            const s = stock[item.codigo_item];
            const disponible = Number(s?.disponible ?? 0);
            if (disponible <= 0) {
              // Sin stock → Agotado
              await ItemModel.updateCantidadDespachador(item.id, 0, true, "sin_stock");
            } else {
              // Hay stock pero no se recolectó → Fantasma
              await ItemModel.updateCantidadDespachador(item.id, 0, false, "inventario_inflado");
            }
          }
        }
      }
    } catch (err) {
      console.error("[despacho] auto-marcado #4 falló (no bloquea):", err.message);
    }
  }

  if (estado === "Recolectado") {
    // 1. Avisar que la recolección cerró (ya con los motivos auto-marcados) y que
    //    se puede auditar.
    try {
      const despacho = await DespachoModel.findById(id);
      await notificarRecoleccionCerrada(despacho);
    } catch (err) {
      // El cierre YA ocurrió y no se toca; el correo es un efecto posterior.
      console.error("[despacho] notificación de cierre falló:", err.message);
    }

    // 2. Subir a SIESA con las cantidades del DESPACHADOR. La palabra la tiene el
    //    despachador: SIESA refleja lo que salió del camión. El auditor ya NO sube
    //    a SIESA — solo verifica y manda el correo comparativo (ver
    //    confirmarAuditoria). Patrón resiliente: marcar 'pendiente' ANTES de
    //    intentar, para que el cron lo levante si esta instancia muere en el envío.
    try {
      await marcarRequisicionPendiente(id);
      const despacho = await DespachoModel.findById(id);
      // Nunca lanza; { estado, motivo, siesaData?, httpStatus? }
      const r = await enviarRequisicion(despacho);
      // Si la subida NO salió (fallido/pendiente), avisar al líder de inventarios
      // con el JSON del error. Los 'omitido' son benignos (ya enviado / carrera).
      if (r && (r.estado === "fallido" || r.estado === "pendiente")) {
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
  { despachadorId, firmaData, pdfBase64 } = {},
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
  const despacho = await cambiarEstado(despachoId, "Recolectado", firmaData, despachadorId);

  // 4. Correo a inventarios con el PDF del manifiesto. VA DESPUÉS del cierre y es
  //    best-effort: la carga ya es un hecho y se subió a SIESA; un fallo de correo
  //    no puede tumbar el flujo. Por eso no se await-ea dentro de un try que
  //    propague — se atrapa acá mismo.
  enviarManifiestoCarga(despacho, doc, pdfBase64).catch((e) =>
    console.error("[despacho] correo del manifiesto falló:", e.message),
  );

  return { manifiesto: doc, despacho };
}

/** El manifiesto de un despacho (para el panel del admin y el del auditor). */
export async function obtenerManifiesto(despachoId) {
  return ManifiestoModel.porDespacho(despachoId);
}

/**
 * Registrar cantidad recolectada por el despachador para un item.
 * `motivo` (opcional): motivo del faltante — ver ItemModel.MOTIVOS_FALTANTE.
 */
export async function registrarRecoleccion(itemId, cantidad, agotado, motivo = null, nueva_um = null, nueva_cant_admin = null, nuevo_factor = null) {
  return ItemModel.updateCantidadDespachador(itemId, cantidad, agotado, motivo, nueva_um, nueva_cant_admin, nuevo_factor);
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

  const conteoAuditor = new Map(
    (itemsAuditor || []).map((i) => [i.id, Number(i.cantidad_auditor) || 0]),
  );

  let match = true;
  // Devolvemos TODOS los items comparados (no solo los que difieren) para que el
  // panel muestre la tabla completa; `match` indica si hubo alguna discrepancia.
  const visibles = (despacho.traslados_items || []).filter((it) => !noSalioDeOrigen(it));
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
export async function confirmarAuditoria(despachoId, { decision, auditorId, firmaData, items }) {
  const ESTADO_POR_DECISION = {
    aprobado: "Auditado",
    inconsistencia: "Recibido_con_inconsistencia",
    rechazado: "Rechazado",
  };
  const estadoFinal = ESTADO_POR_DECISION[decision];
  if (!estadoFinal) throw createError(400, `Decisión inválida: ${decision}`);

  // Persistir cantidades del auditor. Tres clases de ítem:
  //  - Nuevos (traen `nuevo:true`, sin `id`) → mercancía que NO venía en la lista
  //    original; se inserta marcada como agregado_por_auditor.
  //  - No recibidos (traen `no_recibido:true`) → el auditor reporta que no llegó
  //    físicamente; se marca como cantidad_auditor=0 + no_recibido=true (#5).
  //  - Existentes (traen `id`)  → se actualiza cantidad_auditor + diferencia.
  for (const item of items) {
    if (item?.nuevo || item?.id == null) {
      await ItemModel.insertItemAuditor(despachoId, item);
    } else if (item?.no_recibido) {
      await ItemModel.marcarNoRecibido(item.id);
    } else {
      await ItemModel.updateCantidadAuditor(item.id, item.cantidad_auditor);
    }
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
    await enviarComparativoAuditoria(despacho, decision);
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
