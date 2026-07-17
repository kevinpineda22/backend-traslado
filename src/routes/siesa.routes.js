import { Router } from "express";
import * as SiesaController from "../controllers/siesa.controller.js";

const router = Router();

router.get("/flujos", SiesaController.listarFlujosCtrl);
router.get("/criterios", SiesaController.listarCriterios);
router.get("/productos", SiesaController.listarProductos);
router.get("/disponibilidad", SiesaController.listarDisponibilidad);
router.get("/inventario-sedes", SiesaController.listarInventarioSedes);
router.get("/stock", SiesaController.stockEnVivo);
router.get("/sedes", SiesaController.listarSedes);
router.get("/estado", SiesaController.estado);
router.get("/refresh", SiesaController.refrescar);
router.post("/refresh", SiesaController.refrescar);

// Requisiciones importadas a SIESA al cerrar un despacho.
router.get("/requisiciones/estado", SiesaController.estadoRequisicionesCtrl);
router.get("/requisiciones/reintentar", SiesaController.reintentarRequisiciones);
router.post("/requisiciones/reintentar", SiesaController.reintentarRequisiciones);
router.post("/requisiciones/:despachoId/enviar", SiesaController.enviarRequisicionCtrl);

export default router;
