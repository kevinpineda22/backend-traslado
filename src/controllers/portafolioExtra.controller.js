import * as PortafolioExtraModel from "../models/PortafolioExtra.model.js";
import * as CatalogoModel from "../models/Catalogo.model.js";
import { SEDES } from "../config/flujos.js";
import { createError } from "../middleware/errorHandler.js";

/**
 * Portafolio extra: productos que un administrador agrega a mano al portafolio de
 * una sede. Solo Supabase; nada de esto escribe en SIESA.
 */

/** El destino tiene que ser una sede conocida (cualquiera de SEDES en flujos.js). */
function validarDestino(crudo) {
  const destino = String(crudo ?? "").trim();
  if (!destino) throw createError(400, "destino es requerido");
  if (!Object.hasOwn(SEDES, destino)) {
    throw createError(
      400,
      `El destino ${destino} no es una sede válida: ${Object.keys(SEDES).join(", ")}.`,
    );
  }
  return destino;
}

/** Forma de un extra en las respuestas: la fila del extra + datos del catálogo. */
function conCatalogo(fila, c) {
  return {
    destino: fila.destino,
    codigo_item: fila.codigo_item,
    agregado_por: fila.agregado_por,
    created_at: fila.created_at,
    descripcion: c?.descripcion ?? null,
    referencia: c?.referencia ?? null,
    um: c?.um ?? null,
    grupo: c?.grupo ?? null,
    subgrupo: c?.subgrupo ?? null,
  };
}

/**
 * GET /api/portafolio-extra?destino=00401
 * Extras de una sede (los más recientes primero), cruzados con el catálogo.
 * Respuesta: { ok, data: [{ destino, codigo_item, agregado_por, created_at,
 * descripcion, referencia, um, grupo, subgrupo }] }. Los campos del catálogo van en
 * null si el ítem ya no está activo en SIESA (el extra sigue agregado).
 */
export async function listar(req, res, next) {
  try {
    const destino = validarDestino(req.query?.destino);
    const data = await PortafolioExtraModel.listar(destino);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/portafolio-extra
 * Body: { destino, codigo_item, agregado_por }.
 * Valida que el destino sea una sede y que el ítem exista y esté ACTIVO en el
 * catálogo. Es idempotente: si ya estaba agregado responde 200 con `creado: false`
 * y la fila existente (sin pisar quién lo agregó); si es nuevo, 201 con `creado: true`.
 * Respuesta: { ok, creado, data: { …misma forma que GET } }.
 */
export async function agregar(req, res, next) {
  try {
    const destino = validarDestino(req.body?.destino);
    const codigo = CatalogoModel.normCodigoCatalogo(req.body?.codigo_item);
    const agregadoPor = String(req.body?.agregado_por ?? "").trim();
    if (!codigo) throw createError(400, "codigo_item es requerido");
    if (!agregadoPor) throw createError(400, "agregado_por es requerido");

    const item = await CatalogoModel.obtener(codigo);
    if (!item) {
      throw createError(
        404,
        `El ítem ${codigo} no existe en el catálogo de SIESA. Si es un ítem nuevo, actualizá el catálogo.`,
      );
    }
    // `estado` nulo = la consulta no lo trajo: no se puede afirmar que esté inactivo.
    if (item.estado != null && Number(item.estado) !== 1) {
      throw createError(400, `El ítem ${codigo} no está activo en SIESA.`);
    }

    const { creado, fila } = await PortafolioExtraModel.agregar({
      destino,
      codigo_item: codigo,
      agregado_por: agregadoPor,
    });
    res.status(creado ? 201 : 200).json({ ok: true, creado, data: conCatalogo(fila, item) });
  } catch (error) {
    next(error);
  }
}

/**
 * DELETE /api/portafolio-extra/:destino/:codigo
 * Quita el ítem del portafolio extra de esa sede. 404 si no estaba agregado.
 * Respuesta: { ok, eliminado: true }. NO borra nada del catálogo ni de SIESA.
 */
export async function eliminar(req, res, next) {
  try {
    const destino = validarDestino(req.params?.destino);
    const codigo = CatalogoModel.normCodigoCatalogo(req.params?.codigo);
    if (!codigo) throw createError(400, "codigo es requerido");
    const existia = await PortafolioExtraModel.quitar(destino, codigo);
    if (!existia) throw createError(404, `El ítem ${codigo} no está en el portafolio extra de ${destino}.`);
    res.json({ ok: true, eliminado: true });
  } catch (error) {
    next(error);
  }
}
