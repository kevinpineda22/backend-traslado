import { Router } from "express";
import * as FlotaController from "../controllers/flota.controller.js";
import { validators } from "../middleware/validators.js";

const router = Router();

/* Vehículos y conductores del manifiesto. Dos maestros independientes: el
   despachador elige uno de cada uno al cargar el camión.
   `?todos=true` incluye los dados de baja (panel de administración). */

router.get("/vehiculos", FlotaController.listarVehiculos);
router.post("/vehiculos", validators.vehiculo, FlotaController.crearVehiculo);
router.put("/vehiculos/:id", validators.vehiculo, FlotaController.actualizarVehiculo);
// Sin DELETE: baja lógica, los manifiestos viejos siguen referenciando la fila.
router.patch("/vehiculos/:id/activo", FlotaController.cambiarActividadVehiculo);

router.get("/conductores", FlotaController.listarConductores);
router.post("/conductores", validators.conductor, FlotaController.crearConductor);
router.put("/conductores/:id", validators.conductor, FlotaController.actualizarConductor);
router.patch("/conductores/:id/activo", FlotaController.cambiarActividadConductor);

router.get("/despachadores", FlotaController.listarDespachadores);
router.post("/despachadores", validators.despachador, FlotaController.crearDespachador);
router.put("/despachadores/:id", validators.despachador, FlotaController.actualizarDespachador);
router.patch("/despachadores/:id/activo", FlotaController.cambiarActividadDespachador);

export default router;
