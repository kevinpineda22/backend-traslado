import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import "dotenv/config";

import routes from "./routes/index.js";
import { errorHandler } from "./middleware/errorHandler.js";

const app = express();
const PORT = process.env.PORT || 3001;

// Vercel: máximo tiempo de ejecución de la función (segundos). El refresh de
// SIESA es largo → necesita el tope del plan Pro. Se declara acá (además de
// vercel.json) porque el export nombrado es la forma más confiable de aplicarlo.
export const maxDuration = 300;

// ─── Middleware global ────────────────────────────
app.use(helmet());
app.use(cors());
app.use(morgan("dev"));
app.use(express.json({ limit: "10mb" })); // Para firmas en base64

// ─── Ruta raíz ───────────────────────────────────
app.get("/", (_req, res) => {
  res.json({
    ok: true,
    nombre: "Backend Traslados — Merkahorro",
    version: "1.0.0",
    endpoints: {
      health: "/api/health",
      siesa: "/api/siesa",
      despachos: "/api/despachos",
      auditor: "/api/auditor",
    },
  });
});

// ─── Rutas ────────────────────────────────────────
app.use("/api", routes);

// ─── 404 ──────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ ok: false, error: "Ruta no encontrada" });
});

// ─── Error handler ────────────────────────────────
app.use(errorHandler);

// ─── Arranque ─────────────────────────────────────
// El snapshot de SIESA lo llena el cron (/api/siesa/refresh), no el arranque.
if (process.env.NODE_ENV !== "production") {
  app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════╗
║  Backend Traslados — Merkahorro         ║
║  Puerto: ${String(PORT).padEnd(33)}║
║  Modo:   ${(process.env.NODE_ENV || "development").padEnd(33)}║
╚══════════════════════════════════════════╝
    `);
  });
}

export default app;
