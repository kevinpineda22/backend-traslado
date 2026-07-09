import * as DespachoModel from "../models/Despacho.model.js";
import * as ItemModel from "../models/Item.model.js";
import * as FirmaModel from "../models/Firma.model.js";
import { createError } from "../middleware/errorHandler.js";
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
 */
export async function cambiarEstado(id, estado, firmaData) {
  // Si hay firma, guardarla primero
  if (firmaData) {
    const rol = estado === "Recolectado" ? "despachador" : "auditor";
    await FirmaModel.create({ despacho_id: id, rol, firma_data: firmaData });
  }

  return DespachoModel.updateStatus(id, estado);
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
 */
export async function registrarRecoleccion(itemId, cantidad, agotado) {
  return ItemModel.updateCantidadDespachador(itemId, cantidad, agotado);
}

/**
 * Auditoría — Paso 1: COMPARAR (solo lectura, no firma, no cambia estado).
 * Revela la comparación entre lo que recolectó el despachador y lo que contó el
 * auditor. `match` es true si ninguna diferencia es distinta de 0.
 *
 * @param {string} despachoId
 * @param {Array<{id, cantidad_auditor}>} itemsAuditor
 * @returns {{ match: boolean, differences: Array }}
 */
export async function compararAuditoria(despachoId, itemsAuditor) {
  const despacho = await DespachoModel.findById(despachoId);
  if (!despacho) throw createError(404, "Despacho no encontrado");

  const conteoAuditor = new Map(
    itemsAuditor.map((i) => [i.id, Number(i.cantidad_auditor) || 0]),
  );

  let match = true;
  // Devolvemos TODOS los items comparados (no solo los que difieren) para que el
  // panel muestre la tabla completa; `match` indica si hubo alguna discrepancia.
  const differences = (despacho.traslados_items || []).map((item) => {
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

  // Persistir cantidades del auditor + diferencia por item
  for (const item of items) {
    await ItemModel.updateCantidadAuditor(item.id, item.cantidad_auditor);
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
  sheet.addRow([`Fecha: ${new Date(despacho.created_at).toLocaleString("es-CO")}`]);

  const buffer = await workbook.xlsx.writeBuffer();
  return buffer;
}
