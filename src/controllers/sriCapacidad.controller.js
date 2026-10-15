import * as SriCapacidadService from "../services/sriCapacidad.service.js";

/**
 * GET /api/sri/capacidad/comparar?tienda=GIRARDOTA%20LLANO
 * Compara la capacidad medida por SRI contra `traslados_capacidad` y devuelve el
 * reporte de lo que cambiaría. No modifica nada. `tienda` es opcional.
 */
export async function comparar(req, res, next) {
  try {
    const tienda = typeof req.query.tienda === "string" ? req.query.tienda : undefined;
    const reporte = await SriCapacidadService.compararConSri({ tienda });
    res.json(reporte);
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/sri/capacidad/aplicar   body: { "esperados": <n>, "tienda"?: string }
 * Escribe los `cambios` del reporte de /comparar. `esperados` es la cantidad que la
 * persona revisó; si no coincide con la de este momento, no se escribe nada (409).
 * Si una tanda falla responde 500 con lo escrito hasta ahí y lo que falló.
 */
export async function aplicar(req, res, next) {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const tienda = typeof body.tienda === "string" ? body.tienda : undefined;
    const resultado = await SriCapacidadService.aplicarConSri({ tienda, esperados: body.esperados });
    res.status(resultado.ok ? 200 : 500).json(resultado);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/sri/capacidad/faltantes?tienda=GIRARDOTA%20LLANO
 * Lista los ítems que SRI mide y no tienen ninguna fila en `traslados_capacidad`,
 * con la fila base que se crearía para cada uno. No modifica nada.
 */
export async function faltantes(req, res, next) {
  try {
    const tienda = typeof req.query.tienda === "string" ? req.query.tienda : undefined;
    const reporte = await SriCapacidadService.faltantesConSri({ tienda });
    res.json({ ok: true, consultado_en: new Date().toISOString(), ...reporte });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/sri/capacidad/crear   body: { "esperados": <n>, "tienda"?: string }
 * Inserta las filas de `crear` del reporte de /faltantes. `esperados` es obligatorio
 * (400 si falta): si no coincide con el de este momento, no se escribe nada (409).
 * Si la escritura falla responde 500 con lo escrito hasta ahí y lo que falló.
 */
export async function crear(req, res, next) {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const tienda = typeof body.tienda === "string" ? body.tienda : undefined;
    const resultado = await SriCapacidadService.crearFaltantesConSri({ tienda, esperados: body.esperados });
    res.status(resultado.ok ? 200 : 500).json(resultado);
  } catch (error) {
    next(error);
  }
}
