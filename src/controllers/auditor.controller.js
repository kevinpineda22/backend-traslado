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
 * POST /api/auditor/despachos/:id/comparar
 * Paso 1: revela la comparación despachador vs auditor. No firma, no cambia estado.
 * Body: { items: [{ id, cantidad_auditor }] }
 * Resp: { ok, data: { match, differences: [...] } }
 */
export async function comparar(req, res, next) {
  try {
    const resultado = await DespachoService.compararAuditoria(
      req.params.id,
      req.body.items,
    );
    res.json({ ok: true, data: resultado });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/auditor/despachos/:id/confirmar
 * Paso 2: decisión + firma, finaliza el despacho.
 * Body: { decision, auditor_id?, firma_data, items: [{ id, cantidad_auditor }] }
 * Resp: { ok, data: { estado } }
 */
export async function confirmar(req, res, next) {
  try {
    const { decision, auditor_id, firma_data, items } = req.body;
    const resultado = await DespachoService.confirmarAuditoria(req.params.id, {
      decision,
      auditorId: auditor_id,
      firmaData: firma_data,
      items,
    });
    res.json({ ok: true, data: resultado });
  } catch (error) {
    next(error);
  }
}
