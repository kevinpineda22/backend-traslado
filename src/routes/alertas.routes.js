import { Router } from "express";
import * as AlertasController from "../controllers/alertas.controller.js";
import { validators } from "../middleware/validators.js";

const router = Router();

// Barrido por inactividad — lo llama el cron de Vercel (ver vercel.json).
// GET y POST: el cron usa GET; el POST queda para dispararlo a mano desde el panel.
router.get("/barrer", AlertasController.barrer);
router.post("/barrer", AlertasController.barrer);

// Configuración de las tres alertas (horas, activa, correos).
router.get("/config", AlertasController.obtenerConfig);
router.put("/config", validators.alertasConfig, AlertasController.guardarConfig);

// Traslados inactivos + reactivación.
router.get("/inactivos", AlertasController.listarInactivos);
router.patch("/:id/activo", AlertasController.cambiarActividad);

export default router;
