import { Router } from "express";
import * as PortafolioExtraController from "../controllers/portafolioExtra.controller.js";
import { validators } from "../middleware/validators.js";

const router = Router();

router.get("/", PortafolioExtraController.listar);
router.post("/", validators.portafolioExtra, PortafolioExtraController.agregar);
router.delete("/:destino/:codigo", PortafolioExtraController.eliminar);

export default router;
