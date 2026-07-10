import { Router } from "express";
import * as ConfigController from "../controllers/config.controller.js";
import { validators } from "../middleware/validators.js";

const router = Router();

router.get("/", ConfigController.obtener);
router.put("/", validators.config, ConfigController.guardar);

export default router;
