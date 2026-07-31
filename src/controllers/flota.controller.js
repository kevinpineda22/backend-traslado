import * as VehiculoModel from "../models/Vehiculo.model.js";
import * as ConductorModel from "../models/Conductor.model.js";
import * as DespachadorModel from "../models/Despachador.model.js";

/* =============================================
   Flota — vehículos y conductores del manifiesto (migración 016)

   Son DOS maestros independientes, sin relación entre sí: los camiones siempre
   tienen los mismos datos, pero no se sabe de antemano qué conductor maneja cuál.
   Por eso el manifiesto elige uno de cada tabla por separado.

   `?todos=true` devuelve también los dados de baja — lo usa el panel de
   administración. El selector del despachador pide solo los activos.
   ============================================= */

const soloActivos = (req) => req.query.todos !== "true";

export async function listarVehiculos(req, res, next) {
  try {
    const data = soloActivos(req)
      ? await VehiculoModel.listarActivos()
      : await VehiculoModel.listarTodos();
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

export async function crearVehiculo(req, res, next) {
  try {
    res.status(201).json({ ok: true, data: await VehiculoModel.crear(req.body) });
  } catch (error) {
    next(error);
  }
}

export async function actualizarVehiculo(req, res, next) {
  try {
    res.json({ ok: true, data: await VehiculoModel.actualizar(req.params.id, req.body) });
  } catch (error) {
    next(error);
  }
}

/**
 * Baja/alta lógica. No hay DELETE a propósito: los manifiestos viejos referencian
 * este vehículo y borrarlo rompería el historial.
 */
export async function cambiarActividadVehiculo(req, res, next) {
  try {
    const data = await VehiculoModel.setActivo(req.params.id, req.body?.activo);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

export async function listarConductores(req, res, next) {
  try {
    const data = soloActivos(req)
      ? await ConductorModel.listarActivos()
      : await ConductorModel.listarTodos();
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

export async function crearConductor(req, res, next) {
  try {
    res.status(201).json({ ok: true, data: await ConductorModel.crear(req.body) });
  } catch (error) {
    next(error);
  }
}

export async function actualizarConductor(req, res, next) {
  try {
    res.json({ ok: true, data: await ConductorModel.actualizar(req.params.id, req.body) });
  } catch (error) {
    next(error);
  }
}

export async function cambiarActividadConductor(req, res, next) {
  try {
    const data = await ConductorModel.setActivo(req.params.id, req.body?.activo);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

export async function listarDespachadores(req, res, next) {
  try {
    const data = soloActivos(req)
      ? await DespachadorModel.listarActivos()
      : await DespachadorModel.listarTodos();
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

export async function crearDespachador(req, res, next) {
  try {
    res.status(201).json({ ok: true, data: await DespachadorModel.crear(req.body) });
  } catch (error) {
    next(error);
  }
}

export async function actualizarDespachador(req, res, next) {
  try {
    res.json({ ok: true, data: await DespachadorModel.actualizar(req.params.id, req.body) });
  } catch (error) {
    next(error);
  }
}

export async function cambiarActividadDespachador(req, res, next) {
  try {
    const data = await DespachadorModel.setActivo(req.params.id, req.body?.activo);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}
