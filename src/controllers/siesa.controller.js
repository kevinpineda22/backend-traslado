import * as SiesaService from "../services/siesa.service.js";

/**
 * GET /api/siesa/criterios
 * Lista los criterios de agrupación disponibles en SIESA.
 */
export async function listarCriterios(req, res, next) {
  try {
    const { data, error } = await SiesaService.getCriterios();
    if (error) return res.status(502).json({ error });

    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/siesa/productos
 * Query params:
 *   - criterios (string separado por comas, opcional)
 *   - id_bodega (string, default: PV001)
 */
export async function listarProductos(req, res, next) {
  try {
    let criterios = [];
    if (req.query.criterios) {
      try {
        criterios = JSON.parse(req.query.criterios);
        if (!Array.isArray(criterios)) criterios = [];
      } catch {
        criterios = req.query.criterios.split(",").map((s) => s.trim());
      }
    }

    const idBodega = req.query.id_bodega || "PV001";

    const { data, error, mensaje } = await SiesaService.getProductos({
      criterios,
      idBodega,
    });

    if (error) return res.status(502).json({ error });

    res.json({ ok: true, data, mensaje });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/siesa/sedes
 * Lista todas las sedes/bodegas disponibles como destino.
 */
export async function listarSedes(req, res, next) {
  try {
    const { data, error, mensaje } = await SiesaService.getSedes();
    if (error) return res.status(502).json({ error });

    res.json({ ok: true, data, mensaje });
  } catch (error) {
    next(error);
  }
}
