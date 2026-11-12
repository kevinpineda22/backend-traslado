import * as CatalogoModel from "../models/Catalogo.model.js";
import {
  refrescarCatalogoUnico,
  catalogoRefreshEnProgreso,
  dispararRefreshCatalogoRemoto,
  CatalogoRefreshEnCursoError,
  CatalogoIncompletoError,
} from "../services/catalogo.service.js";
import { createError } from "../middleware/errorHandler.js";

// Cooldown del refresh manual: si el catálogo es muy reciente, no dispares otra corrida.
const COOLDOWN_MANUAL_MS = 60 * 1000;

/**
 * GET /api/catalogo?q=texto&limit=50
 * Busca ítems activos del catálogo por código exacto o texto en descripción o
 * referencia. Mínimo 2 caracteres: con menos responde 400 (una lista vacía se leería
 * como "no hay resultados", y no es eso: es que la búsqueda no se hizo).
 * Respuesta: { ok, data: [{ codigo_item, descripcion, referencia, um, um_orden,
 * estado, grupo, subgrupo, id_grupo, id_subgrupo, rowid_item_ext, sincronizado_at }] }
 */
export async function buscar(req, res, next) {
  try {
    const q = String(req.query?.q ?? "").trim();
    if (q.length < CatalogoModel.MINIMO_BUSQUEDA) {
      throw createError(400, `Escribí al menos ${CatalogoModel.MINIMO_BUSQUEDA} caracteres para buscar.`);
    }
    const data = await CatalogoModel.buscar(q, req.query?.limit);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/catalogo/estado
 * Cuántos ítems tiene el catálogo, cuándo se sincronizó por última vez y si hay un
 * refresco corriendo. Con `total: 0` el catálogo nunca se pobló (falta el primer
 * refresco) y no se puede agregar ningún ítem.
 */
export async function estado(_req, res, next) {
  try {
    const [{ total, sincronizado_at }, en_progreso] = await Promise.all([
      CatalogoModel.estado(),
      catalogoRefreshEnProgreso(),
    ]);
    res.json({ ok: true, total, sincronizado_at, en_progreso });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/catalogo/refresh
 * Dispara el refresco del catálogo. Mismo contrato que POST /api/siesa/refresh:
 * con GitHub Actions configurado dispara el workflow y responde 202 al instante; sin
 * él corre el pull inline (~1-2 min, puede chocar con el límite de Vercel).
 */
export async function refrescar(_req, res, next) {
  try {
    const { sincronizado_at } = await CatalogoModel.estado();
    if (sincronizado_at && Date.now() - new Date(sincronizado_at).getTime() < COOLDOWN_MANUAL_MS) {
      return res.status(429).json({
        ok: false,
        error: "Se actualizó hace muy poco, esperá un momento",
        sincronizado_at,
      });
    }

    const { disponible } = await dispararRefreshCatalogoRemoto();
    if (disponible) {
      return res.status(202).json({
        ok: true,
        disparado: true,
        mensaje: "Actualización del catálogo disparada. Tarda unos minutos.",
      });
    }

    const inicio = Date.now();
    const resultado = await refrescarCatalogoUnico("manual");
    res.json({ ok: true, ...resultado, duracion_s: Math.round((Date.now() - inicio) / 1000) });
  } catch (error) {
    if (error instanceof CatalogoRefreshEnCursoError) {
      return res
        .status(202)
        .json({ ok: true, en_progreso: true, mensaje: "Ya hay una actualización del catálogo en curso" });
    }
    // Una guarda abortó el pull: es la protección funcionando, el catálogo queda intacto.
    if (error instanceof CatalogoIncompletoError) {
      console.warn(`[catalogo] pull incompleto, catálogo intacto: ${error.message}`);
      return res.status(200).json({ ok: true, saltado: true, motivo: error.message });
    }
    next(error);
  }
}
