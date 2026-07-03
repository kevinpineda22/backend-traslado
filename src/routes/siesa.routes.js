import { Router } from "express";
import * as SiesaController from "../controllers/siesa.controller.js";
import { validators } from "../middleware/validators.js";

const router = Router();

router.get("/flujos", SiesaController.listarFlujosCtrl);
router.get("/criterios", SiesaController.listarCriterios);
router.get("/productos", SiesaController.listarProductos);
router.post("/productos-llano", validators.productosLlano, SiesaController.listarProductosLlano);
router.get("/sedes", SiesaController.listarSedes);
router.get("/refresh", SiesaController.refrescar);

export default router;
