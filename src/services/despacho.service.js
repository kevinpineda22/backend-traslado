import * as DespachoModel from "../models/Despacho.model.js";
import * as ItemModel from "../models/Item.model.js";
import * as FirmaModel from "../models/Firma.model.js";
import { createError } from "../middleware/errorHandler.js";
import { notificarRecoleccionCerrada } from "./notificacionesTraslado.service.js";
import { enviarRequisicion } from "./requisicion.service.js";
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

/**
 * Cambiar estado de un despacho.
 *
 * Al cerrar la recolección (→ Recolectado) pasan tres cosas, en este orden:
 *   1. Se marca el estado. Esto es lo único que puede fallar hacia el usuario.
 *   2. Salen los correos (cierre + faltantes).
 *   3. Se importa la requisición a SIESA.
 *
 * 2 y 3 son efectos POSTERIORES y ninguno revierte el cierre: cuando el
 * despachador firma, la mercancía ya salió del camión. El despacho es un hecho
 * consumado, no una intención — si el ERP no contesta, la requisición queda
 * pendiente y el cron la reintenta (ver requisicion.service), pero la bodega no
 * se queda trabada esperando a SIESA.
 */
export async function cambiarEstado(id, estado, firmaData) {
  // Si hay firma, guardarla primero
  if (firmaData) {
    const rol = estado === "Recolectado" ? "despachador" : "auditor";
    await FirmaModel.create({ despacho_id: id, rol, firma_data: firmaData });
  }

  // `updateStatus` valida la transición (En_recoleccion → Recolectado). Esa
  // validación es también la primera barrera contra un doble envío a SIESA: un
  // segundo intento de cerrar el mismo despacho no llega hasta acá abajo.
  const actualizado = await DespachoModel.updateStatus(id, estado);

  if (estado === "Recolectado") {
    try {
      // Los motivos ya están persistidos (el front hace POST /recolectar antes
      // de firmar), así que el despacho que leemos acá está completo.
      const despacho = await DespachoModel.findById(id);

      // Marcamos la requisición como pendiente ANTES de intentarla: si esta
      // instancia se muere en el intento (timeout de Vercel), el cron la
      // encuentra igual. Un envío que nadie registró es un envío perdido.
      await marcarRequisicionPendiente(id);

      // En paralelo: son independientes y ninguno debe demorar al otro.
      // `enviarRequisicion` nunca lanza; el correo tampoco.
      await Promise.all([
        notificarRecoleccionCerrada(despacho),
        enviarRequisicion(despacho),
      ]);
    } catch (err) {
      // Llegar acá significa que falló leer el despacho o marcarlo. El cierre YA
      // ocurrió y no se toca; la requisición la levanta el cron.
      console.error("[despacho] efectos del cierre fallaron:", err.message);
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
    const cantidadDespachador = Number(item.cantidad_despachador) || 0;
    const diferencia = cantidadAuditor - cantidadDespachador;
    if (diferencia !== 0) match = false;

    return {
      id: item.id,
      codigo_item: item.codigo_item,
      descripcion: item.descripcion,
      cantidad_despachador: cantidadDespachador,
      cantidad_auditor: cantidadAuditor,
      diferencia,
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

  // Persistir cantidades del auditor. Dos clases de ítem:
  //  - Existentes (traen `id`)  → se actualiza cantidad_auditor + diferencia.
  //  - Nuevos (traen `nuevo:true`, sin `id`) → mercancía que NO venía en la lista
  //    original; se inserta marcada como agregado_por_auditor.
  for (const item of items) {
    if (item?.nuevo || item?.id == null) {
      await ItemModel.insertItemAuditor(despachoId, item);
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

  // Columnas
  sheet.columns = [
    { header: "Item", key: "codigo", width: 15 },
    { header: "Descripción", key: "descripcion", width: 40 },
    { header: "UM", key: "um", width: 8 },
    { header: "Cant. Admin", key: "cantAdmin", width: 14 },
    { header: "Cant. Despachador", key: "cantDespachador", width: 18 },
    { header: "Cant. Auditor", key: "cantAuditor", width: 14 },
    { header: "Diferencia", key: "diferencia", width: 14 },
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
    sheet.addRow({
      codigo: item.codigo_item,
      descripcion: item.descripcion,
      um: item.unidad_medida,
      cantAdmin: item.cantidad_admin ?? "-",
      cantDespachador: tipo === "final" ? (item.cantidad_despachador ?? "-") : "-",
      cantAuditor: tipo === "final" ? (item.cantidad_auditor ?? "-") : "-",
      diferencia: tipo === "final" ? (item.diferencia ?? "-") : "-",
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
