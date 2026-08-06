import { Router } from "express";
import * as CapacidadController from "../controllers/capacidad.controller.js";
import { validators } from "../middleware/validators.js";

const router = Router();

router.get("/", CapacidadController.listar);
router.put("/", validators.capacidadBulk, CapacidadController.subir);
// Va ANTES de "/:codigo": Express matchea por orden, pero acá no compiten (una
// tiene un segmento más). Se declara junta por lectura, no por precedencia.
router.patch("/:codigo/multi-um", CapacidadController.marcarMultiUm);
router.patch("/:codigo", validators.capacidadUno, CapacidadController.actualizarUno);
router.delete("/", CapacidadController.eliminarTodos);
router.delete("/:codigo", CapacidadController.eliminarUno);

export default router;
