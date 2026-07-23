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

    // Los no enviados se omiten ENTEROS. Esto no rompe la ceguera: el auditor
    // nunca supo que existían, así que no puede deducir nada de su ausencia
    // (no tiene la lista original del admin contra la cual comparar).
    // MISMA regla que usa compararAuditoria — ver DespachoService.noSalioDeOrigen.
    const itemsCiegos = (traslados_items || [])
      .filter((it) => !DespachoService.noSalioDeOrigen(it))
      .map((item) => ({
        id: item.id,
        codigo_item: item.codigo_item,
        descripcion: item.descripcion,
        unidad_medida: item.unidad_medida,
        // factor: necesario para convertir a UND cuando el auditor cuenta en la
        // unidad (pack) del ítem, ej: 9 P3 × factor 3 = 27 UND. Es un atributo
        // del producto, NO revela cuánto despachó nadie: no rompe la ceguera.
        factor: item.factor,
        cantidad_admin: item.cantidad_admin,
        categoria: item.categoria,
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
 * Paso 1: dice SI cuadra y, si no, QUÉ hay que recontar. No firma, no cambia estado.
 *
 * Body: { items: [{ id, cantidad_auditor }] }
 * Resp: { ok, data: { match, recontar: [{ id, codigo_item, descripcion }] } }
 *
 * Devuelve la lista a recontar SIN cantidades ni diferencias, a propósito. Si
 * mandáramos los números y solo los escondiéramos en la UI, cualquiera los ve
 * abriendo la pestaña de red del navegador: ocultarlos en el front sería teatro.
 * La auditoría ciega se sostiene en el backend o no se sostiene.
 */
export async function comparar(req, res, next) {
  try {
    const { match, differences } = await DespachoService.compararAuditoria(
      req.params.id,
      req.body.items,
    );

    const recontar = differences
      .filter((d) => Number(d.diferencia) !== 0)
      .map((d) => ({
        id: d.id,
        codigo_item: d.codigo_item,
        descripcion: d.descripcion,
      }));

    res.json({ ok: true, data: { match, recontar } });
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
