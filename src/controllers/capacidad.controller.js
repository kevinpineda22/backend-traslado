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
/**
 * PATCH /api/capacidad/:codigo/multi-um
 * Marca si el ítem se puede pedir en varias UM a la vez sin que el panel avise.
 * Body: { multi_um: boolean }
 *
 * Ruta aparte de `actualizarUno` a propósito: ese endpoint escribe UNA fila
 * (ítem + UM) y este escribe TODAS las del ítem, porque la marca es del producto.
 * Mezclarlos haría que guardar la capacidad de una UM tocara filas que el usuario
 * no estaba editando.
 */
export async function marcarMultiUm(req, res, next) {
  try {
    const data = await CapacidadModel.setMultiUm(req.params.codigo, req.body?.multi_um);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

export async function actualizarUno(req, res, next) {
  try {
    const data = await CapacidadModel.actualizar(
      req.params.codigo,
      req.body.capacidad,
      req.body.descripcion,
      req.body.unidad,
      req.body.factor,
    );
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * DELETE /api/capacidad/:codigo
 * Elimina la capacidad de un ítem.
 */
export async function eliminarUno(req, res, next) {
  try {
    // unidad opcional (query): "" o ausente = la fila base.
    const data = await CapacidadModel.eliminar(req.params.codigo, req.query.unidad || "");
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * DELETE /api/capacidad
 * Elimina TODAS las capacidades cargadas.
 */
export async function eliminarTodos(_req, res, next) {
  try {
    const data = await CapacidadModel.eliminarTodos();
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}
