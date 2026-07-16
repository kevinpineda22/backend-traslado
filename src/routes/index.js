import { Router } from "express";
import siesaRoutes from "./siesa.routes.js";
import despachoRoutes from "./despacho.routes.js";
import auditorRoutes from "./auditor.routes.js";
import capacidadRoutes from "./capacidad.routes.js";
import configRoutes from "./config.routes.js";
import { verificarEmail } from "../services/email.service.js";

const router = Router();

router.use("/siesa", siesaRoutes);
router.use("/despachos", despachoRoutes);
router.use("/auditor", auditorRoutes);
router.use("/capacidad", capacidadRoutes);
router.use("/config", configRoutes);

// Health check
router.get("/health", (_req, res) => {
  res.json({
    ok: true,
    nombre: "Backend Traslados — Merkahorro",
    version: "1.0.0",
    entorno: process.env.NODE_ENV || "development",
  });
});



/**
 * GET /api/health/email
 * Se conecta al SMTP y autentica, SIN enviar nada. Responde 503 si no puede.
 *
 * Existe porque "las variables están cargadas" no es lo mismo que "el correo
 * funciona": la contraseña puede estar vencida o el tenant puede tener SMTP AUTH
 * apagado. Sin este endpoint, la única forma de comprobarlo es cerrar un
 * despacho de verdad y esperar — o sea, enterarse tarde.
 */
router.get("/health/email", async (_req, res) => {
  const estado = await verificarEmail();
  res.status(estado.ok ? 200 : 503).json(estado);
});

export default router;
