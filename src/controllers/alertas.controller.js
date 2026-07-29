import * as AlertasService from "../services/alertas.service.js";
import { obtenerAlertas, guardarAlertas } from "../models/Config.model.js";

/* =============================================
   Alertas por inactividad — configuración, barrido y traslados inactivos.
   ============================================= */

/**
 * ¿La llamada al barrido está autorizada?
 *
 * Si NO hay secreto configurado, se permite: así el cron funciona recién
 * desplegado, igual que `/siesa/requisiciones/reintentar`. Si HAY secreto, se
 * exige — y es lo recomendado, porque este endpoint manda correos a personas de
 * verdad y congela traslados. Vercel manda el cron con
 * `Authorization: Bearer $CRON_SECRET`.
 *
 * Un endpoint sin secreto no es un agujero grave acá (el barrido es idempotente:
 * las marcas `alerta_*_at` impiden repetir el correo), pero sí permitiría a
 * cualquiera adelantar el reloj de las alertas. Por eso la puerta existe.
 */
function barridoAutorizado(req) {
  const secreto = process.env.CRON_SECRET || process.env.REFRESH_TOKEN;
  if (!secreto) return true;

  const auth = String(req.headers.authorization || "");
  if (auth === `Bearer ${secreto}`) return true;
  return String(req.query.token || "") === secreto;
}

/**
 * GET/POST /api/alertas/barrer
 * Una pasada del barrido. Lo llama el cron de Vercel cada 10 minutos.
 */
export async function barrer(req, res, next) {
  try {
    if (!barridoAutorizado(req)) {
      return res.status(401).json({ ok: false, error: "No autorizado" });
    }
    const resultado = await AlertasService.barrerAlertas();
    res.json(resultado);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/alertas/config
 * Config vigente de las tres alertas.
 */
export async function obtenerConfig(_req, res, next) {
  try {
    res.json({ ok: true, data: await obtenerAlertas() });
  } catch (error) {
    next(error);
  }
}

/**
 * PUT /api/alertas/config
 * Body: { recoleccion:{activa,horas,correos[]}, auditoria:{...}, inactivar:{activa,horas} }
 */
export async function guardarConfig(req, res, next) {
  try {
    res.json({ ok: true, data: await guardarAlertas(req.body) });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/alertas/inactivos
 * Traslados inactivos, con resumen de ítems, para poder reactivarlos.
 */
export async function listarInactivos(_req, res, next) {
  try {
    res.json({ ok: true, data: await AlertasService.listarInactivos() });
  } catch (error) {
    next(error);
  }
}

/**
 * PATCH /api/alertas/:id/activo
 * Body: { activo: boolean, motivo?: string }
 * Reactiva (vuelve a los paneles con el reloj en cero) o inactiva a mano.
 */
export async function cambiarActividad(req, res, next) {
  try {
    const { activo, motivo } = req.body || {};
    if (typeof activo !== "boolean") {
      return res.status(400).json({ ok: false, error: "Se esperaba { activo: boolean }" });
    }
    const data = activo
      ? await AlertasService.reactivar(req.params.id)
      : await AlertasService.inactivar(req.params.id, motivo);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}
