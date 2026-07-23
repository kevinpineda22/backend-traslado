import * as SiesaService from "../services/siesa.service.js";
import { getStockLote } from "../services/siesaStock.service.js";
import {
  reintentarPendientes,
  estadoRequisiciones,
  enviarRequisicion,
} from "../services/requisicion.service.js";
import {
  refrescarSnapshotUnico,
  refreshEnProgreso,
  ultimaActualizacion,
  RefreshEnCursoError,
  PullIncompletoError,
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
      // No preguntamos "¿hay uno en curso?" antes de arrancar: entre el check y
      // el arranque hay una ventana de carrera. El lock de refrescarSnapshotUnico
      // es el árbitro; acá solo traducimos su respuesta a HTTP.
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
    const resultado = await refrescarSnapshotUnico(conToken ? "cron" : "manual");
    const segundos = Math.round((Date.now() - inicio) / 1000);

    console.log(
      `[refresh] ✅ ${resultado.total} items (${resultado.crudas}/${resultado.totalDeclarado} filas SIESA) en ${segundos}s`,
    );
    res.json({ ok: true, ...resultado, duracion_s: segundos });
  } catch (error) {
    // Otro refresh ya está corriendo (en esta instancia o en otra) — no es un
    // fallo: es el lock haciendo su trabajo.
    if (error instanceof RefreshEnCursoError) {
      return res
        .status(202)
        .json({ ok: true, en_progreso: true, mensaje: "Ya hay una actualización en curso" });
    }
    // Pull incompleto: la red de seguridad abortó para NO pisar el snapshot bueno.
    // No es un crash: es la protección funcionando. El dato anterior queda intacto.
    if (error instanceof PullIncompletoError) {
      console.warn(`[refresh] ⚠️ pull incompleto, snapshot intacto: ${error.message}`);
      return res.status(200).json({ ok: true, saltado: true, motivo: error.message });
    }
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
    const [actualizado_at, en_progreso] = await Promise.all([
      ultimaActualizacion(),
      refreshEnProgreso(),
    ]);
    res.json({ ok: true, actualizado_at, en_progreso });
  } catch (error) {
    next(error);
  }
}

/**
 * GET/POST /api/siesa/requisiciones/reintentar
 * Reintenta las requisiciones que no llegaron a SIESA. Lo llama el cron.
 */
export async function reintentarRequisiciones(req, res, next) {
  try {
    const limite = Math.min(Number(req.query.limite) || 20, 50);
    const resultado = await reintentarPendientes(limite);
    res.json({ ok: true, ...resultado });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/siesa/requisiciones/estado
 * Cuántas requisiciones hay pendientes / enviadas / fallidas, y si falta config.
 * Sirve para que los pendientes sean VISIBLES: una cola que nadie mira es una
 * cola que se llena en silencio.
 */
export async function estadoRequisicionesCtrl(_req, res, next) {
  try {
    res.json({ ok: true, data: await estadoRequisiciones() });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/siesa/requisiciones/:despachoId/enviar
 * Fuerza el envío de UNA requisición (botón de rescate para operación).
 * Sigue respetando el estado 'enviado': no puede duplicar.
 */
export async function enviarRequisicionCtrl(req, res, next) {
  try {
    const resultado = await enviarRequisicion(req.params.despachoId);
    res.json({ ok: resultado.estado !== "fallido", data: resultado });
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
 * GET /api/siesa/disponibilidad?codigo=123&destino=00401
 * Disponibilidad de un ítem en todas las sedes (para elegir origen alternativo
 * cuando el origen principal no cubre). Devuelve por sede: disponible + sugerido.
 */
export async function listarDisponibilidad(req, res, next) {
  try {
    const { codigo, destino } = req.query;
    if (!codigo || !destino) {
      return res
        .status(400)
        .json({ ok: false, error: "codigo y destino son requeridos" });
    }
    const { data, error } = await SiesaService.getDisponibilidadItem({ codigo, destino });
    if (error) return res.status(502).json({ ok: false, error });
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/siesa/inventario-sedes
 * Inventario de todos los ítems en todas las sedes (vista matriz).
 */
export async function listarInventarioSedes(_req, res, next) {
  try {
    const { data, error } = await SiesaService.getInventarioSedes();
    if (error) return res.status(502).json({ ok: false, error });
    res.json({ ok: true, data });
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

/**
 * GET /api/siesa/codigos-barras/:codigo
 * Resuelve un código de barras a su f120_id y unidad de medida.
 */
export async function resolverCodigoBarrasCtrl(req, res, next) {
  try {
    const { codigo } = req.params;
    if (!codigo) {
      return res.status(400).json({ ok: false, error: "El código es requerido" });
    }
    const data = await SiesaService.resolverCodigoBarras(codigo);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/siesa/stock?sede=00301&items=CODE1,CODE2,...
 * Stock EN VIVO (consulta SIESA en tiempo real) de una lista de ítems en una sede.
 * Pensado para el despachador: pide solo los ítems visibles, no el catálogo entero.
 * Devuelve { [codigo]: { disponible, existencia } }.
 */
export async function stockEnVivo(req, res, next) {
  try {
    const sede = String(req.query.sede || "").trim();
    const items = String(req.query.items || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (!sede) return res.status(400).json({ ok: false, error: "sede es requerida" });
    if (items.length === 0) return res.json({ ok: true, data: {} });
    if (items.length > 200) {
      return res.status(400).json({ ok: false, error: "Máximo 200 ítems por consulta" });
    }

    const data = await getStockLote({ sede, items });
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}
