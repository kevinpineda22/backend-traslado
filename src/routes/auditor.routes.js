import { Router } from "express";
import * as AuditorController from "../controllers/auditor.controller.js";
import { validators } from "../middleware/validators.js";

const router = Router();

router.get("/despachos", AuditorController.listarPendientes);
router.get("/despachos/:id", AuditorController.obtenerDetalle);
router.post("/despachos/:id/comparar", validators.comparar, AuditorController.comparar);
router.post("/despachos/:id/confirmar", validators.confirmar, AuditorController.confirmar);

export default router;
