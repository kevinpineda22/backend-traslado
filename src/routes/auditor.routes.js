import { Router } from "express";
import * as AuditorController from "../controllers/auditor.controller.js";
import { validators } from "../middleware/validators.js";

const router = Router();

router.get("/despachos", AuditorController.listarPendientes);
router.get("/despachos/:id", AuditorController.obtenerDetalle);
// Conteo escaneo por escaneo (migración 036).
router.get("/despachos/:id/conteos", AuditorController.listarConteos);
router.post("/despachos/:id/conteos", validators.conteosRecepcion, AuditorController.guardarConteos);
router.post("/despachos/:id/recontar", validators.recontarRecepcion, AuditorController.recontar);
// Recepción por canastilla (migración 038). "no-listada" antes de "/:cid/...".
router.get("/despachos/:id/canastillas", AuditorController.listarCanastillas);
router.post(
  "/despachos/:id/canastillas/no-listada",
  validators.canastillaNoListada,
  AuditorController.canastillaNoListada,
);
router.post("/despachos/:id/canastillas/:cid/entrar", validators.accionCanastilla, AuditorController.entrarCanastilla);
router.post("/despachos/:id/canastillas/:cid/cerrar", validators.accionCanastilla, AuditorController.cerrarCanastilla);
router.post("/despachos/:id/canastillas/:cid/reabrir", validators.accionCanastilla, AuditorController.reabrirCanastilla);
router.post(
  "/despachos/:id/canastillas/:cid/no-recibida",
  validators.accionCanastilla,
  AuditorController.canastillaNoRecibida,
);
router.post("/despachos/:id/comparar", validators.comparar, AuditorController.comparar);
router.post("/despachos/:id/confirmar", validators.confirmar, AuditorController.confirmar);

export default router;
