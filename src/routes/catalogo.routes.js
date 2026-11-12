import { Router } from "express";
import * as CatalogoController from "../controllers/catalogo.controller.js";

const router = Router();

router.get("/", CatalogoController.buscar);
router.get("/estado", CatalogoController.estado);
router.post("/refresh", CatalogoController.refrescar);

export default router;
