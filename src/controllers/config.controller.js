import * as ConfigModel from "../models/Config.model.js";

/**
 * GET /api/config
 * Devuelve la config de reposición (cadencias Llano + cubrimiento General).
 */
export async function obtener(_req, res, next) {
  try {
    const data = await ConfigModel.obtener();
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * PUT /api/config
 * Guarda la config. Body: { llano: { A, B, C }, general: { periodoCubrimiento } }
 */
export async function guardar(req, res, next) {
  try {
    const data = await ConfigModel.guardar(req.body);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}
