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
// NO EXISTE UN `router.delete("/")`
// Vaciaba la tabla entera, sin confirmación y sin auth propia. El 2026-10-15 se usó
// junto con la carga de Excel y destruyó 157 filas protegidas. Después de sacar la
// carga masiva ya no tiene uso legítimo: lo protegido no vuelve de SRI. Para borrar
// una fila puntual está la ruta de abajo.
router.delete("/:codigo", CapacidadController.eliminarUno);

export default router;
