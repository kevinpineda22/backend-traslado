import { Router } from "express";
import siesaRoutes from "./siesa.routes.js";
import despachoRoutes from "./despacho.routes.js";
import auditorRoutes from "./auditor.routes.js";
import capacidadRoutes from "./capacidad.routes.js";
import configRoutes from "./config.routes.js";
import alertasRoutes from "./alertas.routes.js";
import flotaRoutes from "./flota.routes.js";
import integracionesRoutes from "./integraciones.routes.js";
import { verificarEmail } from "../services/email.service.js";
import { sandboxOn } from "../config/sandbox.js";

const router = Router();

router.use("/siesa", siesaRoutes);
router.use("/despachos", despachoRoutes);
router.use("/auditor", auditorRoutes);
router.use("/capacidad", capacidadRoutes);
router.use("/config", configRoutes);
router.use("/alertas", alertasRoutes);
router.use("/flota", flotaRoutes);

// Consumo por OTRAS ÁREAS (Inventarios, Compras). Exige API key y es solo lectura.
// Va separado del resto porque su contrato es público y estable: los endpoints de
// arriba los consume nuestro front y cambian con el front; estos no pueden.
router.use("/integraciones", integracionesRoutes);

// Health check.
//
// `sandbox` va acá y no en un endpoint aparte porque es la primera pregunta de
// quien va a probar —"¿esto sale de mi máquina?"— y tiene que contestarse con el
// mismo GET que ya se usa para ver si el backend está vivo.
router.get("/health", (_req, res) => {
  res.json({
    ok: true,
    nombre: "Backend Traslados — Merkahorro",
    version: "1.0.0",
    entorno: process.env.NODE_ENV || "development",
    sandbox: sandboxOn(),
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
