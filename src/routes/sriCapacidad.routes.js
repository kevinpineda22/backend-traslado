import { Router } from "express";
import * as SriCapacidadController from "../controllers/sriCapacidad.controller.js";

const router = Router();

// POR QUÉ GET Y NO POST
// Esta ruta no muta nada: lee SRI, lee nuestra tabla y devuelve un reporte. Con
// GET es trivialmente seguro de llamar desde el navegador o con curl, sin miedo a
// que un reintento o un click de más dispare un efecto. `/comparar` sigue siendo
// el camino seguro, y la operación que SÍ aplica los cambios es una ruta distinta.
router.get("/comparar", SriCapacidadController.comparar);

// POR QUÉ POST, Y POR QUÉ ES LA ÚNICA QUE ESCRIBE
// `/aplicar` muta `traslados_capacidad`, así que no puede ser un GET que se abra o
// reintente sin querer. Es la única ruta de toda la integración con SRI que
// escribe, y exige `esperados` en el body para que solo se aplique lo revisado.
router.post("/aplicar", SriCapacidadController.aplicar);

export default router;
