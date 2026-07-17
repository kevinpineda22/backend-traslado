import * as DespachoService from "../services/despacho.service.js";

/**
 * GET /api/despachos
 * Listar despachos. Query params opcionales:
 *   estado, despachador_id, sin_asignar, resumen=true (incluye agregación de items)
 */
/**
 * GET /api/despachos/estadisticas/motivos
 * Agregación de motivos de faltante para el dashboard.
 */
export async function estadisticasMotivos(_req, res, next) {
  try {
    const data = await DespachoService.estadisticasMotivos();
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

export async function listar(req, res, next) {
  try {
    const { estado, despachador_id, sin_asignar, resumen } = req.query;
    const filters = { estado, despachador_id, sin_asignar };

    if (resumen === "true") {
      const data = await DespachoService.listarConResumen(filters);
      return res.json({ ok: true, data });
    }

    const data = await DespachoService.listar(filters);
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
 * DELETE /api/despachos/:id
 * Eliminar un despacho (borra items y firmas por cascade).
 */
export async function eliminar(req, res, next) {
  try {
    const data = await DespachoService.eliminar(req.params.id);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * PATCH /api/despachos/:id/despachador
 * Reasignar (o quitar) el despachador. Body: { despachador_id }
 */
export async function reasignarDespachador(req, res, next) {
  try {
    const data = await DespachoService.reasignarDespachador(
      req.params.id,
      req.body?.despachador_id ?? null,
    );
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * PUT /api/despachos/:id/items
 * Editar los ítems de un despacho (solo Creado). Body: { items: [{ id, cantidad }] }
 */
export async function editarItems(req, res, next) {
  try {
    const items = req.body?.items;
    if (!Array.isArray(items)) {
      return res.status(400).json({ error: "Se esperaba un arreglo de items" });
    }
    const data = await DespachoService.editarItems(req.params.id, items);
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
 * POST /api/despachos/:id/iniciar
 * Iniciar recolección reclamando el despacho (modelo pool).
 * Si el despacho se creó sin despachador asignado, se asigna acá atómicamente.
 * Body: { despachador_id } (opcional si ya estaba pre-asignado)
 * 409 si otro despachador ya lo tomó.
 */
export async function iniciarRecoleccion(req, res, next) {
  try {
    const { despachador_id } = req.body;
    const data = await DespachoService.iniciarRecoleccion(
      req.params.id,
      despachador_id,
    );
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/despachos/:id/recolectar
 * Registrar la recolección de un item por el despachador.
 * Body: { items: [{ id, cantidad, agotado? }] }
 */
export async function recolectar(req, res, next) {
  try {
    const { items } = req.body;
    const resultados = [];

    for (const item of items) {
      const actualizado = await DespachoService.registrarRecoleccion(
        item.id,
        item.cantidad,
        item.agotado,
        item.motivo,
      );
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
