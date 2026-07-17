import { Router } from "express";
import * as DespachoController from "../controllers/despacho.controller.js";
import { validators } from "../middleware/validators.js";

const router = Router();

router.get("/", DespachoController.listar);
router.get("/estadisticas/motivos", DespachoController.estadisticasMotivos);
router.get("/:id", DespachoController.obtener);
router.post("/", validators.crearDespacho, DespachoController.crear);
router.delete("/:id", DespachoController.eliminar);
router.patch("/:id/despachador", DespachoController.reasignarDespachador);
router.put("/:id/items", DespachoController.editarItems);
router.patch("/:id/estado", validators.cambiarEstado, DespachoController.cambiarEstado);
router.post("/:id/iniciar", DespachoController.iniciarRecoleccion);
router.post("/:id/recolectar", validators.recolectar, DespachoController.recolectar);
router.get("/:id/planilla", DespachoController.planilla);

export default router;
