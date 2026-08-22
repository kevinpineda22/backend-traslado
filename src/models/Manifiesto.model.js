import { supabase } from "../config/supabase.js";
import { createError } from "../middleware/errorHandler.js";
import * as VehiculoModel from "./Vehiculo.model.js";
import * as ConductorModel from "./Conductor.model.js";
import * as DespachadorModel from "./Despachador.model.js";
import { PLACA_MAX, ERROR_PLACA_LARGA, normalizarPlaca } from "../config/placa.js";

const TABLE = "traslados_manifiestos";

/* =============================================
   Manifiesto de carga (migración 016)

   El registro de quién se llevó la carga. Se crea cuando el despachador marca
   CAMIÓN CARGADO, que es el momento en que el despacho pasa a `Recolectado` y se
   dispara todo lo que cuelga de ese estado (correos, SIESA, reloj del auditor).

   NO es el manifiesto electrónico del RNDC: aquel lo emite la transportadora
   contra el Ministerio de Transporte y trae número de autorización. Este es el
   registro interno, con los mismos campos.
   ============================================= */

/**
 * Resuelve los datos del vehículo: si viene `vehiculo_id` se COPIAN del maestro;
 * si no, se toman los que escribió el despachador (camión de refuerzo, alquilado,
 * o cualquier cosa que no esté dada de alta).
 *
 * La copia es a propósito: si mañana ese camión cambia de poseedor o de empresa,
 * el manifiesto de hoy tiene que seguir diciendo lo que era cierto hoy. Es un
 * documento, no una vista del maestro.
 */
async function resolverVehiculo(payload) {
  if (payload.vehiculo_id) {
    const v = await VehiculoModel.obtener(payload.vehiculo_id);
    if (!v) throw createError(422, "El vehículo seleccionado no existe");
    return {
      vehiculo_id: v.id,
      placa: v.placa,
      marca: v.marca,
      clase: v.clase,
      tipo: v.tipo,
      color: v.color,
      carroceria: v.carroceria,
    };
  }

  const placa = normalizarPlaca(payload.placa);
  if (!placa) throw createError(422, "Elegí un vehículo o escribí la placa");
  // El validador ya cortó esto en la puerta HTTP, pero el modelo no puede confiar
  // en que siempre lo llamen desde ahí: sin este chequeo, un exceso vuelve a ser un
  // 500 crudo de Postgres ("value too long for type character varying") en vez de
  // un mensaje que el despachador pueda corregir.
  if (placa.length > PLACA_MAX) throw createError(422, ERROR_PLACA_LARGA);
  return {
    vehiculo_id: null,
    placa,
    marca: payload.marca?.trim() || null,
    clase: payload.clase?.trim() || null,
    tipo: payload.tipo?.trim()?.toUpperCase() || null,
    color: payload.color?.trim()?.toUpperCase() || null,
    carroceria: payload.carroceria?.trim() || null,
  };
}

/**
 * Despachador (el "titular" del manifiesto). Se elige del maestro; queda opcional
 * para no bloquear un cierre si todavía no lo cargaron.
 */
async function resolverDespachador(payload) {
  if (!payload.despachador_ref_id) {
    return {
      despachador_ref_id: null,
      despachador_nombre: payload.despachador_nombre?.trim()?.toUpperCase() || null,
      despachador_documento: payload.despachador_documento?.trim() || null,
      despachador_telefono: payload.despachador_telefono?.trim() || null,
    };
  }

  const d = await DespachadorModel.obtener(payload.despachador_ref_id);
  if (!d) throw createError(422, "El despachador seleccionado no existe");
  return {
    despachador_ref_id: d.id,
    despachador_nombre: d.nombre,
    despachador_documento: d.documento,
    despachador_telefono: d.telefono,
  };
}

/** Igual que el vehículo: del maestro si lo eligió, a mano si es alguien de paso. */
async function resolverConductor(payload) {
  if (payload.conductor_id) {
    const c = await ConductorModel.obtener(payload.conductor_id);
    if (!c) throw createError(422, "El conductor seleccionado no existe");
    return {
      conductor_id: c.id,
      conductor_nombre: c.nombre,
      conductor_documento: c.documento,
      conductor_direccion: c.direccion,
      conductor_telefono: c.telefono,
      conductor_licencia: c.licencia,
      conductor_ciudad: c.ciudad,
    };
  }

  const nombre = String(payload.conductor_nombre || "").trim().toUpperCase();
  const documento = String(payload.conductor_documento || "").trim();
  if (!nombre) throw createError(422, "Elegí un conductor o escribí su nombre");
  if (!documento) throw createError(422, "El documento del conductor es obligatorio");

  return {
    conductor_id: null,
    conductor_nombre: nombre,
    conductor_documento: documento,
    conductor_direccion: payload.conductor_direccion?.trim() || null,
    conductor_telefono: payload.conductor_telefono?.trim() || null,
    conductor_licencia: payload.conductor_licencia?.trim() || null,
    conductor_ciudad: payload.conductor_ciudad?.trim()?.toUpperCase() || null,
  };
}

/**
 * Crea el manifiesto de un despacho.
 *
 * @param {string} despachoId
 * @param {object} payload - vehículo (id o campos), conductor (id o campos),
 *                           ruta, peso_kg, observaciones, despachador_id
 * @returns {Promise<object>} el manifiesto creado
 * @throws {409} si el despacho YA tiene manifiesto
 */
export async function crear(despachoId, payload = {}) {
  const peso = Number(payload.peso_kg);
  if (!Number.isFinite(peso) || peso <= 0) {
    throw createError(422, "El peso total en kg es obligatorio y debe ser mayor a 0");
  }

  const vehiculo = await resolverVehiculo(payload);
  const conductor = await resolverConductor(payload);
  const despachador = await resolverDespachador(payload);

  const fila = {
    despacho_id: despachoId,
    ...vehiculo,
    ...conductor,
    ...despachador,
    origen_viaje: payload.origen_viaje?.trim() || null,
    destino_viaje: payload.destino_viaje?.trim() || null,
    ciudad: payload.ciudad?.trim()?.toUpperCase() || null,
    municipio: payload.municipio?.trim()?.toUpperCase() || null,
    peso_kg: peso,
    observaciones: payload.observaciones?.trim() || null,
    despachador_id: payload.despachador_id || null,
  };

  const { data, error } = await supabase.from(TABLE).insert(fila).select().single();

  // El índice único sobre `despacho_id` es el candado contra el doble clic en
  // "Camión cargado": sin él, dos envíos simultáneos crearían dos manifiestos y
  // dispararían SIESA dos veces. Que lo resuelva la base y no el front.
  if (error?.code === "23505") {
    throw createError(409, "Este despacho ya tiene un manifiesto cargado");
  }
  if (error) throw new Error(`Error al crear el manifiesto: ${error.message}`);
  return data;
}

/**
 * Manifiestos de TODAS las sedes, del más nuevo al más viejo, con filtro de fecha.
 *
 * POR QUÉ TODOS Y NO SOLO LOS PROPIOS
 * El manifiesto es el papel que se le entrega al conductor, y quien vuelve a
 * necesitarlo no siempre es quien lo cargó: el conductor pide otra copia días
 * después, o el que está de turno tiene que reimprimir el de un compañero que ya
 * salió. Acotarlo a "los míos" dejaba justo esos casos sin salida.
 *
 * EL FILTRO DE FECHA ES LA HERRAMIENTA REAL DE BÚSQUEDA
 * Con todas las sedes adentro la lista crece rápido, y nadie recuerda un
 * manifiesto por su número: lo recuerda por el DÍA ("el del martes a Barbosa").
 * Por eso las fechas filtran en el servidor y no en el navegador — traer un año
 * entero para descartarlo en el cliente es pagar el costo dos veces.
 *
 * `hasta` se estira al final del día: con un timestamp, "hasta el 22" excluiría
 * todo lo del 22 salvo la medianoche exacta. Es el bug clásico de los filtros de
 * fecha, y ya está resuelto igual en analitica.service.
 *
 * @param {object} [opts]
 * @param {string} [opts.desde]  - YYYY-MM-DD
 * @param {string} [opts.hasta]  - YYYY-MM-DD (incluye el día entero)
 * @param {number} [opts.limite=300]
 */
export async function listarTodos({ desde, hasta, limite = 300 } = {}) {
  const finDelDia = (f) =>
    /^\d{4}-\d{2}-\d{2}$/.test(String(f || "")) ? `${f}T23:59:59.999Z` : f;

  let q = supabase
    .from(TABLE)
    .select(
      "id, despacho_id, placa, marca, conductor_nombre, conductor_documento, " +
        "peso_kg, despachador_id, despachador_nombre, origen_viaje, destino_viaje, " +
        "observaciones, created_at, " +
        "traslados_despachos!inner(id, origen, destino, estado, despachador_id, flujo)",
    )
    .order("created_at", { ascending: false })
    .limit(limite);

  if (desde) q = q.gte("created_at", desde);
  if (hasta) q = q.lte("created_at", finDelDia(hasta));

  const { data, error } = await q;
  if (error) throw new Error(`Error al listar manifiestos: ${error.message}`);
  return data || [];
}

/** El manifiesto de un despacho, o null. */
export async function porDespacho(despachoId) {
  const { data, error } = await supabase
    .from(TABLE)
    .select("*")
    .eq("despacho_id", despachoId)
    .maybeSingle();

  if (error) throw new Error(`Error al leer el manifiesto: ${error.message}`);
  return data;
}
