import * as DespachoService from "../services/despacho.service.js";
import * as DespachoModel from "../models/Despacho.model.js";

/**
 * GET /api/auditor/despachos
 * Listar despachos pendientes de auditoría (estado Recolectado).
 * No expone cantidades del despachador (auditoría ciega).
 */
export async function listarPendientes(req, res, next) {
  try {
    const data = await DespachoModel.findForAuditor();
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/auditor/despachos/:id
 * Obtener detalle de un despacho para auditoría (sin cantidades del despachador).
 */
export async function obtenerDetalle(req, res, next) {
  try {
    const despacho = await DespachoService.obtener(req.params.id);

    if (!despacho) return res.status(404).json({ error: "Despacho no encontrado" });

    // Auditoría ciega: ocultar cantidad_despachador y firma del despachador
    const { traslados_firmas, traslados_items, ...cabecera } = despacho;

    const itemsCiegos = traslados_items?.map((item) => ({
      id: item.id,
      codigo_item: item.codigo_item,
      descripcion: item.descripcion,
      unidad_medida: item.unidad_medida,
      cantidad_admin: item.cantidad_admin,
      // NOTA: cantidad_despachador y diferencia se ocultan intencionalmente
    }));

    res.json({
      ok: true,
      data: {
        ...cabecera,
        traslados_items: itemsCiegos,
        // Sin firmas del despachador
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/auditor/despachos/:id/auditar
 * Enviar auditoría: cantidades del auditor + firma.
 * El backend compara con cantidades del despachador y determina estado final.
 *
 * Body: {
 *   items: [{ id: uuid, cantidad_auditor: number }],
 *   firma_data: "data:image/png;base64,..."
 * }
 */
export async function auditar(req, res, next) {
  try {
    const { items, firma_data } = req.body;

    if (!items?.length) {
      return res.status(400).json({ error: "Debe enviar al menos un item para auditar" });
    }

    const resultado = await DespachoService.auditar(req.params.id, items, firma_data);

    res.json({
      ok: true,
      data: resultado,
    });
  } catch (error) {
    next(error);
  }
}
