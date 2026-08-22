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
 * Manifiestos en los que participó una persona, del más nuevo al más viejo.
 *
 * QUÉ CUENTA COMO "PARTICIPÓ"
 * Dos cosas, y hacen falta las dos:
 *   1. Cargó el camión — `manifiesto.despachador_id` es su correo. Es quien firma
 *      y quien se para frente al conductor.
 *   2. Era el despachador del traslado — `despacho.despachador_id`. Alguien puede
 *      haber recolectado todo y que el camión lo cierre otro que estaba de turno
 *      cuando llegó (eso es a propósito, ver `cargarCamion`). Ese traslado también
 *      es suyo.
 *
 * POR QUÉ DOS CONSULTAS Y NO UN `or` CON JOIN
 * Las dos condiciones viven en TABLAS distintas (una en el manifiesto, otra en el
 * despacho). Un `.or()` de Supabase no cruza la relación, así que se piden por
 * separado y se unen por id acá. Con volúmenes de manifiestos —uno por traslado—
 * el costo es irrelevante frente a una consulta que no se puede leer.
 *
 * Trae la ruta y la fecha del despacho pegadas: la lista tiene que poder
 * identificarse de un vistazo ("Copacabana → Barbosa, 22/08, placa ABC123") y sin
 * eso el panel tendría que pedir cada despacho por separado.
 *
 * @param {string} correo
 * @param {number} [limite=60] - tope de filas; la lista es para encontrar un papel
 *   reciente, no para auditar el año.
 */
export async function listarPorDespachador(correo, limite = 60) {
  const clave = String(correo || "").trim().toLowerCase();
  if (!clave) return [];

  const CAMPOS =
    "id, despacho_id, placa, conductor_nombre, conductor_documento, peso_kg, " +
    "despachador_id, despachador_nombre, origen_viaje, destino_viaje, created_at, " +
    "traslados_despachos!inner(id, origen, destino, estado, despachador_id, updated_at)";

  // 1. Los que cargó esta persona.
  const { data: propios, error: e1 } = await supabase
    .from(TABLE)
    .select(CAMPOS)
    .ilike("despachador_id", clave)
    .order("created_at", { ascending: false })
    .limit(limite);
  if (e1) throw new Error(`Error al listar manifiestos: ${e1.message}`);

  // 2. Los de traslados que eran suyos, aunque el camión lo cerrara otro.
  const { data: deSusDespachos, error: e2 } = await supabase
    .from(TABLE)
    .select(CAMPOS)
    .ilike("traslados_despachos.despachador_id", clave)
    .order("created_at", { ascending: false })
    .limit(limite);
  if (e2) throw new Error(`Error al listar manifiestos: ${e2.message}`);

  const porId = new Map();
  for (const m of [...(propios || []), ...(deSusDespachos || [])]) porId.set(m.id, m);

  return [...porId.values()]
    .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")))
    .slice(0, limite);
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
