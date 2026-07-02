import * as DespachoService from "../services/despacho.service.js";

/**
 * GET /api/despachos
 * Listar despachos. Query params opcionales: estado, despachador_id
 */
export async function listar(req, res, next) {
  try {
    const { estado, despachador_id } = req.query;
    const data = await DespachoService.listar({ estado, despachador_id });
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/despachos/:id
 * Obtener detalle completo de un despacho.
 */
export async function obtener(req, res, next) {
  try {
    const data = await DespachoService.obtener(req.params.id);
    if (!data) return res.status(404).json({ error: "Despacho no encontrado" });

    // Auditoría ciega: si viene ?auditor=true, ocultar cantidad_despachador
    if (req.query.auditor === "true" && data.traslados_items) {
      data.traslados_items = data.traslados_items.map((item) => {
        const { cantidad_despachador, ...rest } = item;
        return rest;
      });
    }

    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/despachos
 * Crear un nuevo despacho.
 * Body: { destino, despachador_id, admin_id, criterios, items[] }
 */
export async function crear(req, res, next) {
  try {
    const data = await DespachoService.crear(req.body);
    res.status(201).json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * PATCH /api/despachos/:id/estado
 * Avanzar el estado de un despacho.
 * Body: { estado, firma_data? }
 */
export async function cambiarEstado(req, res, next) {
  try {
    const { estado, firma_data } = req.body;
    const data = await DespachoService.cambiarEstado(req.params.id, estado, firma_data);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/despachos/:id/recolectar
 * Registrar la recolección de un item por el despachador.
 * Body: { items: [{ id, cantidad }] }
 */
export async function recolectar(req, res, next) {
  try {
    const { items } = req.body;
    const resultados = [];

    for (const item of items) {
      const actualizado = await DespachoService.registrarRecoleccion(item.id, item.cantidad);
      resultados.push(actualizado);
    }

    res.json({ ok: true, data: resultados });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/despachos/:id/planilla
 * Generar planilla Excel del despacho.
 * Query param: tipo = "recoleccion" | "final"
 */
export async function planilla(req, res, next) {
  try {
    const tipo = req.query.tipo || "recoleccion";
    const buffer = await DespachoService.generarPlanilla(req.params.id, tipo);

    const filename = `despacho-${req.params.id.slice(0, 8)}-${tipo}.xlsx`;

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (error) {
    next(error);
  }
}
