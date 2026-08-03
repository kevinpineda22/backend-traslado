import { createError } from "../middleware/errorHandler.js";
import * as NovedadModel from "../models/Novedad.model.js";

/**
 * Controladores de la superficie de INTEGRACIONES (consumo por otras áreas).
 *
 * Todo lo de acá es SOLO LECTURA, a propósito. Un consumidor externo que puede
 * escribir es un consumidor que puede cambiarte el estado de un despacho sin
 * pasar por las reglas del flujo — y cuando el inventario salga mal, el rastro no
 * va a estar en tu backend.
 */

/**
 * Convierte `?tipo=AGOTADO,INVENTARIO_FANTASMA` (o repetido) a lista de strings.
 * Acepta ambas formas porque los clientes HTTP no se ponen de acuerdo: Postman y
 * axios repiten el parámetro, los scripts a mano usan coma.
 */
function listaDeQuery(valor) {
  if (valor == null) return [];
  const partes = Array.isArray(valor) ? valor : String(valor).split(",");
  return partes.map((p) => String(p).trim()).filter(Boolean);
}

/**
 * Valida una fecha ISO y la normaliza.
 *
 * Sin esto, un `fecha_desde=ayer` viaja crudo a Postgres, que responde con un
 * error de sintaxis de tipo — un 500 que le dice al consumidor "se rompió tu
 * backend" cuando el problema es su parámetro. Un 400 explícito le dice qué
 * arreglar.
 *
 * `fecha_hasta` sin hora se lleva al final del día: quien pide
 * `fecha_hasta=2026-08-03` quiere incluir ese día completo, no cortarlo a las 00:00.
 */
function fechaISO(valor, campo, finDeDia = false) {
  if (!valor) return undefined;
  const crudo = String(valor).trim();
  const soloFecha = /^\d{4}-\d{2}-\d{2}$/.test(crudo);
  const d = new Date(soloFecha && finDeDia ? `${crudo}T23:59:59.999Z` : crudo);
  if (Number.isNaN(d.getTime())) {
    throw createError(400, `${campo} no es una fecha válida (usá ISO 8601, ej. 2026-08-01).`);
  }
  return d.toISOString();
}

/**
 * GET /api/integraciones/v1/novedades
 *
 * Detalle renglón por renglón de las novedades de inventario. Ver
 * `docs/API_INTEGRACIONES_NOVEDADES.md` para el contrato completo.
 */
export async function listarNovedades(req, res, next) {
  try {
    const tipos = listaDeQuery(req.query.tipo);
    const motivos = NovedadModel.tiposAMotivos(tipos);

    // Si pidió tipos y NINGUNO es válido, es un 400 y no una lista vacía: un
    // `tipo=INVENTARIO_FANTAZMA` mal escrito devolvería "0 novedades" y el
    // consumidor concluiría que no hay problemas de inventario. Silencio que
    // miente.
    if (tipos.length > 0 && motivos.length === 0) {
      const validos = NovedadModel.tiposNovedad()
        .map((t) => t.tipo)
        .join(", ");
      throw createError(400, `tipo inválido. Valores permitidos: ${validos}.`);
    }

    const data = await NovedadModel.listarNovedades({
      motivos,
      destino: req.query.destino,
      origen: req.query.origen,
      codigo_item: req.query.codigo_item,
      estado: req.query.estado,
      fecha_desde: fechaISO(req.query.fecha_desde, "fecha_desde"),
      fecha_hasta: fechaISO(req.query.fecha_hasta, "fecha_hasta", true),
      limit: req.query.limit,
      offset: req.query.offset,
    });

    res.json({
      ok: true,
      paginacion: {
        total: data.total,
        limit: data.limit,
        offset: data.offset,
        // Se manda calculado y no que lo deduzca el consumidor: la comparación
        // `offset + limit < total` es fácil de escribir mal, y escrita mal deja
        // registros sin leer sin ningún síntoma.
        hay_mas: data.offset + data.novedades.length < data.total,
      },
      data: data.novedades,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/integraciones/v1/novedades/tipos
 * Catálogo de tipos. Existe para que el consumidor no hardcodee los strings:
 * si mañana se agrega un cuarto motivo, lo descubre pidiendo, no leyendo un correo.
 */
export async function listarTipos(_req, res, next) {
  try {
    res.json({ ok: true, data: NovedadModel.tiposNovedad() });
  } catch (error) {
    next(error);
  }
}
