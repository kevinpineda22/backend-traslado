import { Router } from "express";
import * as CapacidadController from "../controllers/capacidad.controller.js";
import { validators } from "../middleware/validators.js";

const router = Router();

router.get("/", CapacidadController.listar);
router.put("/", validators.capacidadBulk, CapacidadController.subir);
router.patch("/:codigo", validators.capacidadUno, CapacidadController.actualizarUno);
router.delete("/", CapacidadController.eliminarTodos);
router.delete("/:codigo", CapacidadController.eliminarUno);

export default router;
