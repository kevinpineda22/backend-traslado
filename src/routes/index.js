import { Router } from "express";
import siesaRoutes from "./siesa.routes.js";
import despachoRoutes from "./despacho.routes.js";
import auditorRoutes from "./auditor.routes.js";
import capacidadRoutes from "./capacidad.routes.js";
import configRoutes from "./config.routes.js";

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

export default router;
