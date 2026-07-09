import * as CapacidadModel from "../models/Capacidad.model.js";

/**
 * GET /api/capacidad
 * Lista todas las capacidades cargadas (para el módulo de gestión).
 */
export async function listar(_req, res, next) {
  try {
    const data = await CapacidadModel.listar();
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * PUT /api/capacidad
 * Carga masiva desde el Excel (upsert). Body: { items: [{ item, capacidad }] }
 */
export async function subir(req, res, next) {
  try {
    const total = await CapacidadModel.upsertBulk(req.body.items);
    res.json({ ok: true, total });
  } catch (error) {
    next(error);
  }
}

/**
 * PATCH /api/capacidad/:codigo
 * Edita la capacidad de un ítem. Body: { capacidad }
 */
export async function actualizarUno(req, res, next) {
  try {
    const data = await CapacidadModel.actualizar(
      req.params.codigo,
      req.body.capacidad,
      req.body.descripcion,
    );
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}
