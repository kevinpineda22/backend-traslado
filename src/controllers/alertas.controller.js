import * as AlertasService from "../services/alertas.service.js";
import { obtenerAlertas, guardarAlertas } from "../models/Config.model.js";

/* =============================================
   Alertas por inactividad — configuración, barrido y traslados inactivos.
   ============================================= */

/**
 * ¿La llamada del CRON al barrido está autorizada?
 *
 * Si NO hay secreto configurado, se permite: así el cron funciona recién
 * desplegado, igual que `/siesa/requisiciones/reintentar`. Si HAY secreto, se
 * exige. Vercel manda el cron con `Authorization: Bearer $CRON_SECRET`.
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
 * Una pasada del barrido. GET lo llama el cron de Vercel cada 10 minutos; POST
 * es el botón "Probar ahora" del panel.
 *
 * POR QUÉ EL POST NO PIDE TOKEN
 * El panel no puede llevar el secreto: en este frontend cualquier variable
 * `VITE_*` termina dentro del bundle que se descarga el navegador, o sea que
 * "protegerlo" así es publicarlo. Y un botón de prueba que siempre responde 401
 * no sirve para nada, que es justo lo que hace falta para verificar que las
 * alertas funcionan.
 *
 * El riesgo es acotado y conocido: el barrido es idempotente (las marcas
 * `alerta_*_at` impiden repetir un correo) y el resto de esta API tampoco tiene
 * autenticación todavía. Cuando entre la auth real, este POST va detrás de ella.
 */
export async function barrer(req, res, next) {
  try {
    if (req.method === "GET" && !barridoAutorizado(req)) {
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
