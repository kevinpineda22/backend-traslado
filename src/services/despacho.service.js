import * as DespachoModel from "../models/Despacho.model.js";
import * as ItemModel from "../models/Item.model.js";
import * as FirmaModel from "../models/Firma.model.js";
import ExcelJS from "exceljs";

/**
 * Listar despachos con filtros opcionales.
 */
export async function listar(filters) {
  return DespachoModel.findAll(filters);
}

/**
 * Obtener detalle completo de un despacho.
 */
export async function obtener(id) {
  return DespachoModel.findById(id);
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
 * Registrar cantidad recolectada por el despachador para un item.
 */
export async function registrarRecoleccion(itemId, cantidad) {
  return ItemModel.updateCantidadDespachador(itemId, cantidad);
}

/**
 * Auditar un despacho: registrar cantidades del auditor y calcular diferencias.
 */
export async function auditar(despachoId, items, firmaData) {
  // Guardar firma del auditor
  if (firmaData) {
    await FirmaModel.create({
      despacho_id: despachoId,
      rol: "auditor",
      firma_data: firmaData,
    });
  }

  // Actualizar cada item con la cantidad del auditor
  const resultados = [];
  for (const item of items) {
    const actualizado = await ItemModel.updateCantidadAuditor(item.id, item.cantidad_auditor);
    resultados.push(actualizado);
  }

  // Determinar estado final
  const hayDiferencias = resultados.some((r) => r.diferencia !== 0);
  const estadoFinal = hayDiferencias ? "Rechazado" : "Auditado";

  await DespachoModel.updateStatus(despachoId, estadoFinal);

  return {
    estado: estadoFinal,
    hayDiferencias,
    items: resultados,
  };
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
