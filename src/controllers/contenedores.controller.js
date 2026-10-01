import * as ContenedoresService from "../services/contenedores.service.js";
import * as RecepcionContenedores from "../services/recepcionContenedores.service.js";

/**
 * GET /api/despachos/:id/recepcion-canastillas — para el ADMIN (no ciego):
 * por canastilla, esperado contra contado, y los productos mal ubicados.
 */
export async function detalleRecepcion(req, res, next) {
  try {
    res.json({ ok: true, data: await RecepcionContenedores.detalleAdmin(req.params.id) });
  } catch (error) {
    next(error);
  }
}

/* Contenedores de un despacho (migración 037). Ver contenedores.service. */

/** GET /api/despachos/:id/contenedores */
export async function listar(req, res, next) {
  try {
    const data = await ContenedoresService.listar(req.params.id);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/despachos/:id/contenedores
 * Body: { despachador_id, numero }
 * Resp: { ok, data: contenedor, aviso } — `aviso` si el número figura en otro traslado activo.
 */
export async function crear(req, res, next) {
  try {
    const { contenedor, aviso } = await ContenedoresService.crear(
      req.params.id,
      req.body.numero,
      req.body.despachador_id ?? null,
    );
    res.status(201).json({ ok: true, data: contenedor, aviso });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/despachos/:id/contenedores/asignar
 * Body: { despachador_id, asignaciones: [{ contenedor_id, item_id, cantidad }] }
 * Resp: { ok, data: [escritos], rechazados: [{ contenedor_id, item_id, codigo, error }] }
 */
export async function asignar(req, res, next) {
  try {
    const { resultados, rechazados } = await ContenedoresService.asignar(
      req.params.id,
      req.body.despachador_id ?? null,
      req.body.asignaciones,
    );
    res.json({ ok: true, data: resultados, rechazados });
  } catch (error) {
    next(error);
  }
}

/** POST /api/despachos/:id/contenedores/:cid/cerrar */
export async function cerrar(req, res, next) {
  try {
    const data = await ContenedoresService.cerrar(
      req.params.id,
      req.params.cid,
      req.body?.despachador_id ?? null,
    );
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/** POST /api/despachos/:id/contenedores/:cid/reabrir */
export async function reabrir(req, res, next) {
  try {
    const data = await ContenedoresService.reabrir(
      req.params.id,
      req.params.cid,
      req.body?.despachador_id ?? null,
    );
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/** DELETE /api/despachos/:id/contenedores/:cid — solo vacío. */
export async function borrar(req, res, next) {
  try {
    const data = await ContenedoresService.borrar(
      req.params.id,
      req.params.cid,
      req.body?.despachador_id ?? req.query.despachador_id ?? null,
    );
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}
