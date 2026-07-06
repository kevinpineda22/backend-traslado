import * as SiesaService from "../services/siesa.service.js";
import {
  refrescarSnapshotUnico,
  refreshEnProgreso,
  ultimaActualizacion,
} from "../services/snapshot.service.js";
import { listarFlujos, getFlujoPorDestino } from "../config/flujos.js";

// Cooldown del refresh manual (sin token): no dispara el pull caro más seguido.
const COOLDOWN_MANUAL_MS = 60 * 1000;

/**
 * GET/POST /api/siesa/refresh
 * Refresca el snapshot desde SIESA → Supabase.
 *   - Cron / con token válido → siempre refresca.
 *   - Manual desde la UI (sin token) → protegido por lock + cooldown para que
 *     el pull caro (~2 min) no se pueda abusar. Devuelve 202 si ya hay uno en
 *     curso, 429 si se actualizó hace muy poco.
 */
export async function refrescar(req, res, next) {
  try {
    const esperado = process.env.REFRESH_TOKEN;
    const auth = req.get("authorization") || "";
    const token = auth.replace(/^Bearer\s+/i, "") || req.query.token;
    const conToken = esperado && token === esperado;

    if (!conToken) {
      // Modo manual (UI): sin token, pero acotado para no abusar del pull.
      if (refreshEnProgreso()) {
        return res
          .status(202)
          .json({ ok: true, en_progreso: true, mensaje: "Ya hay una actualización en curso" });
      }
      const ultima = await ultimaActualizacion();
      if (ultima && Date.now() - new Date(ultima).getTime() < COOLDOWN_MANUAL_MS) {
        return res.status(429).json({
          ok: false,
          error: "Se actualizó hace muy poco, esperá un momento",
          actualizado_at: ultima,
        });
      }
    }

    const inicio = Date.now();
    const resultado = await refrescarSnapshotUnico();
    const segundos = Math.round((Date.now() - inicio) / 1000);

    console.log(
      `[refresh] ✅ ${resultado.total} items (${resultado.origenFilas} filas SIESA) en ${segundos}s`,
    );
    res.json({ ok: true, ...resultado, duracion_s: segundos });
  } catch (error) {
    console.error("[refresh] ❌", error);
    res.status(500).json({
      ok: false,
      error: error.message,
      donde: error.stack?.split("\n")[1]?.trim(),
    });
  }
}

/**
 * GET /api/siesa/estado
 * Estado del snapshot: cuándo se actualizó por última vez y si hay uno en curso.
 */
export async function estado(_req, res, next) {
  try {
    const actualizado_at = await ultimaActualizacion();
    res.json({ ok: true, actualizado_at, en_progreso: refreshEnProgreso() });
  } catch (error) {
    next(error);
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
 * Productos del origen cruzados con el destino + sugerido. Según el flujo del
 * destino usa la lógica de stock de seguridad (General) o A/B/C (Llano).
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

    const obtener =
      flujo.logica === "abc"
        ? SiesaService.getProductosLlano
        : SiesaService.getProductosTraslado;

    const { data, error } = await obtener({ origen, destino });
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
