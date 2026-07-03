import { Router } from "express";
import * as SiesaController from "../controllers/siesa.controller.js";

const router = Router();

router.get("/flujos", SiesaController.listarFlujosCtrl);
router.get("/criterios", SiesaController.listarCriterios);
router.get("/productos", SiesaController.listarProductos);
router.get("/sedes", SiesaController.listarSedes);
router.get("/refresh", SiesaController.refrescar);

export default router;
