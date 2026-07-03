import * as SiesaService from "../services/siesa.service.js";
import { refrescarSnapshot } from "../services/snapshot.service.js";
import { listarFlujos, getFlujoPorDestino } from "../config/flujos.js";

/**
 * GET /api/siesa/refresh
 * Refresca el snapshot desde SIESA → Supabase. Lo dispara el cron de Vercel.
 * Protegido con REFRESH_TOKEN (header Authorization: Bearer <token> o ?token=).
 * Vercel Cron envía "Authorization: Bearer $CRON_SECRET" automáticamente.
 */
export async function refrescar(req, res, next) {
  try {
    const esperado = process.env.REFRESH_TOKEN;
    if (esperado) {
      const auth = req.get("authorization") || "";
      const bearer = auth.replace(/^Bearer\s+/i, "");
      const token = bearer || req.query.token;
      if (token !== esperado) {
        return res.status(401).json({ ok: false, error: "No autorizado" });
      }
    }

    const inicio = Date.now();
    const resultado = await refrescarSnapshot();
    const segundos = Math.round((Date.now() - inicio) / 1000);

    console.log(
      `[refresh] ✅ ${resultado.total} items (${resultado.origenFilas} filas SIESA) en ${segundos}s`,
    );
    res.json({ ok: true, ...resultado, duracion_s: segundos });
  } catch (error) {
    // Endpoint protegido: devolvemos el error real para poder diagnosticar
    // (el errorHandler global lo ocultaría como "Error interno del servidor").
    console.error("[refresh] ❌", error);
    res.status(500).json({
      ok: false,
      error: error.message,
      donde: error.stack?.split("\n")[1]?.trim(),
    });
  }
}

/**
 * GET /api/siesa/flujos
 * Configuración de flujos (origen + destinos habilitados por flujo).
 */
export function listarFlujosCtrl(_req, res) {
  res.json({ ok: true, data: listarFlujos() });
}

/**
 * GET /api/siesa/criterios?origen=PV001
 * Criterios de agrupación para los filtros facetados.
 */
export async function listarCriterios(req, res, next) {
  try {
    const origen = req.query.origen || undefined;
    const { data, error } = await SiesaService.getCriterios(origen);
    if (error) return res.status(502).json({ ok: false, error });
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/siesa/productos?destino=00201[&origen=PV001]
 * Productos del origen cruzados con el destino + sugerido.
 * El origen se deriva del flujo del destino salvo que se pase explícito.
 */
export async function listarProductos(req, res, next) {
  try {
    const destino = req.query.destino;
    if (!destino) {
      return res.status(400).json({ ok: false, error: "destino es requerido" });
    }

    const flujo = getFlujoPorDestino(destino);
    if (!flujo) {
      return res
        .status(400)
        .json({ ok: false, error: `El destino ${destino} no pertenece a ningún flujo` });
    }

    const origen = req.query.origen || flujo.origen;

    const { data, error } = await SiesaService.getProductosTraslado({
      origen,
      destino,
    });
    if (error) return res.status(502).json({ ok: false, error });

    res.json({ ok: true, data, flujo: flujo.id, origen, destino });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/siesa/productos-llano
 * Flujo Llano: recibe las filas del Excel (item, unidad, capacidad) y devuelve
 * los productos cruzados con SIESA + sugerido A/B/C.
 * Body: { destino, items: [{ item, unidad, capacidad }], cadencias? }
 */
export async function listarProductosLlano(req, res, next) {
  try {
    const { destino, items, cadencias } = req.body;

    const flujo = getFlujoPorDestino(destino);
    if (!flujo) {
      return res
        .status(400)
        .json({ ok: false, error: `El destino ${destino} no pertenece a ningún flujo` });
    }

    const origen = req.body.origen || flujo.origen;

    const { data, error } = await SiesaService.getProductosLlano({
      origen,
      destino,
      items,
      cadencias,
    });
    if (error) return res.status(502).json({ ok: false, error });

    res.json({ ok: true, data, flujo: flujo.id, origen, destino });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/siesa/sedes
 * Lista de sedes destino disponibles.
 */
export async function listarSedes(_req, res, next) {
  try {
    const { data, error } = await SiesaService.getSedes();
    if (error) return res.status(502).json({ ok: false, error });
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}
