import * as CapacidadModel from "../models/Capacidad.model.js";
import { esDestinoAbc, destinosAbc } from "../config/flujos.js";
import { createError } from "../middleware/errorHandler.js";

/**
 * Destino de la petición: query (`?destino=`) o body, y Llano (00401) si no viene,
 * para que el front y los scripts anteriores a Machado sigan funcionando igual.
 * Solo se aceptan destinos de flujos A/B/C: la capacidad no significa nada en otro
 * flujo, y un destino mal escrito crearía filas huérfanas que nadie lee.
 */
function destinoDe(req) {
  const crudo = req.query?.destino ?? req.body?.destino;
  const destino = CapacidadModel.normDestino(crudo);
  if (!esDestinoAbc(destino)) {
    throw createError(
      400,
      `El destino ${destino} no tiene capacidad: los válidos son ${destinosAbc().join(", ")}.`,
    );
  }
  return destino;
}

/**
 * GET /api/capacidad[?destino=01201]
 * Lista las capacidades cargadas de un destino (Llano por defecto).
 */
export async function listar(req, res, next) {
  try {
    const data = await CapacidadModel.listar(destinoDe(req));
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * PUT /api/capacidad
 * Carga masiva desde el Excel (upsert). Body: { destino?, items: [{ item, capacidad }] }.
 * Solo toca las filas del destino indicado. Para Llano (00401, también si no se manda
 * `destino`) responde 403: ver el comentario en el cuerpo.
 */
export async function subir(req, res, next) {
  try {
    const destino = destinoDe(req);
    // La carga masiva NO está permitida para Llano, y la regla vive AQUÍ y no solo en
    // el front: el 2026-10-15 una carga de Excel (junto con un "eliminar todo")
    // destruyó 157 filas protegidas de Llano. Llano se mantiene por SRI o a mano. Sin
    // `destino` el valor es Llano, así que un cliente viejo también queda rechazado.
    if (destino === CapacidadModel.DESTINO_DEFECTO) {
      throw createError(
        403,
        "La carga masiva por Excel no está permitida para Girardota Llano (00401): su capacidad se mantiene con SRI o a mano. Indicá otro destino.",
      );
    }
    const { guardadas, saltadas } = await CapacidadModel.upsertBulk(req.body.items, destino);
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
    const data = await CapacidadModel.setMultiUm(req.params.codigo, req.body?.multi_um, destinoDe(req));
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
      destinoDe(req),
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
    const data = await CapacidadModel.eliminar(req.params.codigo, req.query.unidad || "", destinoDe(req));
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

// `eliminarTodos` (DELETE /api/capacidad) se eliminó el 2026-10-15 junto con el
// modelo que lo respaldaba. Vaciaba la tabla entera sin confirmación y por una ruta
// sin autenticación propia. Ver el comentario en Capacidad.model.js para el detalle
// del incidente. Para borrar una fila puntual está DELETE /api/capacidad/:codigo.
