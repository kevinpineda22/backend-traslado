import { Router } from "express";
import * as DespachoController from "../controllers/despacho.controller.js";
import { validators } from "../middleware/validators.js";

const router = Router();

router.get("/", DespachoController.listar);
router.get("/estadisticas/motivos", DespachoController.estadisticasMotivos);
router.get("/activos/items", DespachoController.itemsActivos);

// Listado semanal (borrador) del flujo General.
// OJO: van ANTES de "/:id" — Express matchea por orden y "/listado" entraría por
// "/:id" (tomando "listado" como un uuid) si se declararan después.
router.get("/listado", DespachoController.obtenerListado);
router.post("/listado", validators.crearDespacho, DespachoController.agregarAlListado);
router.post("/listado/:id/finalizar", DespachoController.finalizarListado);
router.delete("/listado/:id", DespachoController.descartarListado);
// Editar cantidades / quitar ítems del listado usa el mismo PUT /:id/items que un
// despacho en Creado: `editarItems` ya acepta ambos estados.

router.get("/:id", DespachoController.obtener);
router.post("/", validators.crearDespacho, DespachoController.crear);
router.delete("/:id", DespachoController.eliminar);
router.patch("/:id/despachador", DespachoController.reasignarDespachador);
router.put("/:id/items", DespachoController.editarItems);
router.patch("/:id/estado", validators.cambiarEstado, DespachoController.cambiarEstado);
router.post("/:id/iniciar", DespachoController.iniciarRecoleccion);
router.post("/:id/abandonar", DespachoController.abandonar);
router.post("/:id/recolectar", validators.recolectar, DespachoController.recolectar);
// Camión cargado: cierra la recolección CON el manifiesto y dispara SIESA.
router.post("/:id/cargar", validators.cargarCamion, DespachoController.cargarCamion);
router.get("/:id/manifiesto", DespachoController.obtenerManifiesto);
router.get("/:id/planilla", DespachoController.planilla);

export default router;
