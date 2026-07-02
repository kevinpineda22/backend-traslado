import { Router } from "express";
import * as AuditorController from "../controllers/auditor.controller.js";
import { validators } from "../middleware/validators.js";

const router = Router();

router.get("/despachos", AuditorController.listarPendientes);
router.get("/despachos/:id", AuditorController.obtenerDetalle);
router.post("/despachos/:id/auditar", validators.auditar, AuditorController.auditar);

export default router;
