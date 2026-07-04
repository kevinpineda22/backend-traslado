import { Router } from "express";
import * as CapacidadController from "../controllers/capacidad.controller.js";
import { validators } from "../middleware/validators.js";

const router = Router();

router.get("/", CapacidadController.listar);
router.put("/", validators.capacidadBulk, CapacidadController.subir);
router.patch("/:codigo", validators.capacidadUno, CapacidadController.actualizarUno);

export default router;
