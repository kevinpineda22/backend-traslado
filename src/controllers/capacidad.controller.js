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
    const { guardadas, saltadas } = await CapacidadModel.upsertBulk(req.body.items);
    // `saltadas` nunca va vacío al cliente por omisión: si una carga no escribió lo
    // que el usuario mandó, tiene que verlo. Callarlo fue lo que dejó pasar el
    // incidente del 2026-10-15 sin que nadie lo notara hasta días después.
    res.json({
      ok: true,
      total: guardadas,
      saltadas,
      ...(saltadas.length > 0 && {
        aviso: `${saltadas.length} ítem(s) no se tocaron porque su capacidad está protegida: ${saltadas.join(", ")}.`,
      }),
    });
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

// `eliminarTodos` (DELETE /api/capacidad) se eliminó el 2026-10-15 junto con el
// modelo que lo respaldaba. Vaciaba la tabla entera sin confirmación y por una ruta
// sin autenticación propia. Ver el comentario en Capacidad.model.js para el detalle
// del incidente. Para borrar una fila puntual está DELETE /api/capacidad/:codigo.
