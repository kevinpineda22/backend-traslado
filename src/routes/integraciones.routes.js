import { Router } from "express";
import * as IntegracionesController from "../controllers/integraciones.controller.js";
import { requireApiKey } from "../middleware/apiKey.js";

/**
 * Superficie de INTEGRACIONES — el único lugar por donde consume otra área.
 *
 * Está versionada (`/v1`) desde el primer día y no cuando haga falta, porque
 * cuando haga falta ya es tarde: si el consumidor está pegado a
 * `/api/integraciones/novedades`, el primer cambio incompatible te obliga a
 * elegir entre romperle la integración o quedarte con el contrato viejo para
 * siempre. Con `/v1` publicás `/v2` al lado y le das tiempo a migrar.
 *
 * La llave se aplica a TODO el router con `router.use`, no ruta por ruta. Ese
 * detalle importa: el día que alguien agregue un endpoint acá abajo, nace
 * protegido. Con la llave declarada en cada ruta, nace abierto y nadie lo revisa.
 */
const router = Router();

router.use(requireApiKey);

// Ping autenticado. Le sirve al consumidor para confirmar que su llave quedó bien
// ANTES de escribir la integración — sin esto, su primer error de auth aparece
// mezclado con sus propios bugs de parseo y no sabe de quién es la culpa.
router.get("/ping", (req, res) => {
  res.json({ ok: true, consumidor: req.consumidor, ts: new Date().toISOString() });
});

router.get("/v1/novedades", IntegracionesController.listarNovedades);
router.get("/v1/novedades/tipos", IntegracionesController.listarTipos);

export default router;
