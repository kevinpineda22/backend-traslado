import { supabase } from "../config/supabase.js";

const TABLE = "traslados_despachos";

// Estados finales: el traslado ya se cerró (el stock se movió / no aplica).
const ESTADOS_FINALES = ["Auditado", "Rechazado", "Recibido_con_inconsistencia"];

/**
 * Ítems que están en despachos ACTIVOS (no finalizados). Sirve para avisar al
 * admin que un ítem+origen ya tiene un traslado en curso: el stock todavía no se
 * descontó, así que crear otro puede sobre-asignar inventario.
 * Devuelve una lista plana: { origen, codigo_item, created_at, destino, estado }.
 */
export async function itemsEnDespachosActivos() {
  const { data, error } = await supabase
    .from(TABLE)
    .select("id, origen, destino, created_at, estado, traslados_items(codigo_item)")
    .not("estado", "in", `(${ESTADOS_FINALES.join(",")})`)
    .order("created_at", { ascending: false });

  if (error) throw new Error(`Error al leer despachos activos: ${error.message}`);

  const out = [];
  for (const d of data || []) {
    for (const it of d.traslados_items || []) {
      out.push({
        despacho_id: d.id,
        origen: d.origen,
        destino: d.destino,
        estado: d.estado,
        created_at: d.created_at,
        codigo_item: String(it.codigo_item),
      });
    }
  }
  return out;
}

/**
 * Obtener todos los despachos, opcionalmente filtrados por estado.
 * @param {object} filters - { estado, despachador_id, admin_id }
 */
export async function findAll(filters = {}) {
  let query = supabase.from(TABLE).select("*");

  // estado puede venir como string ('Creado') o array (['Creado','En_recoleccion'])
  // — los paneles filtran por varios estados a la vez.
  if (Array.isArray(filters.estado)) query = query.in("estado", filters.estado);
  else if (filters.estado) query = query.eq("estado", filters.estado);

  if (filters.sin_asignar) {
    query = query.is("despachador_id", null);
  } else if (filters.despachador_id) {
    query = query.eq("despachador_id", filters.despachador_id);
  }
  if (filters.admin_id) query = query.eq("admin_id", filters.admin_id);

  const { data, error } = await query.order("created_at", { ascending: false });

  if (error) throw new Error(`Error al listar despachos: ${error.message}`);
  return data;
}

/**
 * Obtener un despacho por ID con sus items y firmas.
 */
export async function findById(id) {
  const { data: despacho, error } = await supabase
    .from(TABLE)
    .select("*, traslados_items(*), traslados_firmas(*)")
    .eq("id", id)
    .single();

  if (error) throw new Error(`Error al obtener despacho: ${error.message}`);
  return despacho;
}

/**
 * Crear un despacho con sus items.
 * @param {object} payload - { origen, destino, despachador_id, admin_id, criterios, items[] }
 */
export async function create(payload) {
  const { items, ...cabecera } = payload;

  // 1. Insertar cabecera
  const { data: despacho, error: errCab } = await supabase
    .from(TABLE)
    .insert({
      flujo: cabecera.flujo || "general",
      origen: cabecera.origen || "PV001",
      destino: cabecera.destino,
      despachador_id: cabecera.despachador_id,
      admin_id: cabecera.admin_id,
      criterios: cabecera.criterios,
      estado: "Creado",
    })
    .select()
    .single();

  if (errCab) throw new Error(`Error al crear despacho: ${errCab.message}`);

  // 2. Insertar items (con snapshot de lo que vio el admin)
  if (items?.length > 0) {
    const itemsConDespacho = items.map((item) => ({
      despacho_id: despacho.id,
      codigo_item: item.codigo_item,
      descripcion: item.descripcion,
      unidad_medida: item.unidad_medida,
      factor: item.factor ?? 1,
      rotacion: item.rotacion,
      // Snapshot de la categoría: si SIESA reclasifica el producto mañana, el
      // despacho ya cerrado debe seguir contando la historia que vio el admin.
      categoria: item.categoria || null,
      stock_origen: item.stock_origen,
      stock_destino: item.stock_destino,
      consumo_destino: item.consumo_destino,
      stock_seguridad: item.stock_seguridad,
      sugerido: item.sugerido,
      cantidad_admin: item.cantidad,
    }));

    const { error: errItems } = await supabase
      .from("traslados_items")
      .insert(itemsConDespacho);

    if (errItems) throw new Error(`Error al insertar items: ${errItems.message}`);
  }

  // Respondemos con la cabecera (rápido). NO hacemos read-back con join de todos
  // los items: con despachos grandes eso demora la respuesta aunque el insert ya
  // terminó, y el front solo necesita confirmación.
  return { ...despacho, items_creados: items?.length || 0 };
}

/**
 * Actualizar el estado de un despacho validando la transición.
 */
export async function updateStatus(id, nuevoEstado) {
  const TRANSICIONES = {
    Creado: ["En_recoleccion"],
    En_recoleccion: ["Recolectado"],
    Recolectado: ["En_recepcion", "Auditado", "Rechazado", "Recibido_con_inconsistencia"],
    En_recepcion: ["Auditado", "Rechazado", "Recibido_con_inconsistencia"],
    Auditado: [],
    Rechazado: [],
    Recibido_con_inconsistencia: [],
  };

  // Validar transición
  const { data: actual } = await supabase
    .from(TABLE)
    .select("estado")
    .eq("id", id)
    .single();

  if (!actual) throw new Error("Despacho no encontrado");

  const permitidos = TRANSICIONES[actual.estado] ?? [];
  if (!permitidos.includes(nuevoEstado)) {
    throw new Error(
      `Transición inválida: ${actual.estado} → ${nuevoEstado}. Permitidas: ${permitidos.join(", ") || "ninguna"}`,
    );
  }

  const { data, error } = await supabase
    .from(TABLE)
    .update({ estado: nuevoEstado, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();

  if (error) throw new Error(`Error al actualizar estado: ${error.message}`);
  return data;
}

/**
 * Iniciar recolección reclamando el despacho (modelo pool).
 * Atómico: solo avanza a "En_recoleccion" si SIGUE en "Creado" (`.eq("estado","Creado")`),
 * así dos despachadores no lo toman a la vez. Setea el despachador que lo reclama.
 */
export async function iniciarRecoleccion(id, despachadorId) {
  const patch = {
    estado: "En_recoleccion",
    updated_at: new Date().toISOString(),
  };
  if (despachadorId) patch.despachador_id = despachadorId;

  const { data, error } = await supabase
    .from(TABLE)
    .update(patch)
    .eq("id", id)
    .eq("estado", "Creado")
    .select()
    .single();

  if (error || !data) {
    const err = new Error("El despacho ya fue tomado o cambió de estado");
    err.statusCode = 409;
    err.expose = true;
    return Promise.reject(err);
  }
  return data;
}

/**
 * Reasignar (o quitar) el despachador de un despacho.
 */
export async function updateDespachador(id, despachadorId) {
  const { data, error } = await supabase
    .from(TABLE)
    .update({ despachador_id: despachadorId || null, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();
  if (error) throw new Error(`Error al reasignar despachador: ${error.message}`);
  return data;
}

/**
 * Editar los ítems de un despacho — SOLO en estado "Creado" (no arrancó).
 * Actualiza cantidades y elimina los ítems que ya no vengan en la lista.
 * @param {string} id
 * @param {Array<{id, cantidad}>} items - ítems que quedan (con su cantidad_admin)
 */
export async function editarItems(id, items) {
  const { data: cab } = await supabase.from(TABLE).select("estado").eq("id", id).single();
  if (!cab) {
    const e = new Error("Despacho no encontrado");
    e.statusCode = 404;
    e.expose = true;
    throw e;
  }
  if (cab.estado !== "Creado") {
    const e = new Error("Solo se pueden editar los ítems de un despacho en estado Creado");
    e.statusCode = 409;
    e.expose = true;
    throw e;
  }

  const { data: actuales } = await supabase
    .from("traslados_items")
    .select("id")
    .eq("despacho_id", id);

  const keep = new Set(items.map((i) => i.id).filter(Boolean));
  const removidos = (actuales || []).map((r) => r.id).filter((x) => !keep.has(x));

  if (removidos.length) {
    const { error } = await supabase.from("traslados_items").delete().in("id", removidos);
    if (error) throw new Error(`Error al quitar ítems: ${error.message}`);
  }

  for (const it of items) {
    if (!it.id) continue;
    const { error } = await supabase
      .from("traslados_items")
      .update({ cantidad_admin: Number(it.cantidad) || 0 })
      .eq("id", it.id);
    if (error) throw new Error(`Error al actualizar ítem: ${error.message}`);
  }

  return { id, items: items.length };
}

/**
 * Eliminar un despacho (los items y firmas se borran por FK ON DELETE CASCADE).
 */
export async function eliminar(id) {
  const { error } = await supabase.from(TABLE).delete().eq("id", id);
  if (error) throw new Error(`Error al eliminar despacho: ${error.message}`);
  return { id, eliminado: true };
}

/**
 * Deja la requisición de SIESA marcada como 'pendiente' de envío.
 *
 * El `.is("siesa_estado", null)` es el punto: solo marca si NUNCA se tocó. Si ya
 * dice 'enviado', pisarlo con 'pendiente' haría que el cron la mande de nuevo y
 * duplique la requisición en el ERP. Un estado terminal no se revive.
 */
export async function marcarSiesaPendiente(id) {
  const { error } = await supabase
    .from(TABLE)
    .update({ siesa_estado: "pendiente" })
    .eq("id", id)
    .is("siesa_estado", null);

  if (error) console.error(`[despacho] no se pudo marcar siesa_estado: ${error.message}`);
}

/**
 * Registrar qué auditor cerró el despacho.
 */
export async function updateAuditor(id, auditorId) {
  const { error } = await supabase
    .from(TABLE)
    .update({ auditor_id: auditorId })
    .eq("id", id);

  if (error) throw new Error(`Error al asignar auditor: ${error.message}`);
}

/**
 * Obtener despachos con resumen de items para el monitor.
 * Devuelve los despachos con conteo de completos/incompletos/agotados/pendientes.
 * Acepta los mismos filtros que findAll.
 */
export async function findAllWithResumen(filters = {}) {
  // 1. Obtener cabeceras (reusa lógica de findAll)
  let query = supabase.from(TABLE).select("*");

  if (Array.isArray(filters.estado)) query = query.in("estado", filters.estado);
  else if (filters.estado) query = query.eq("estado", filters.estado);

  if (filters.sin_asignar) {
    query = query.is("despachador_id", null);
  } else if (filters.despachador_id) {
    query = query.eq("despachador_id", filters.despachador_id);
  }
  if (filters.admin_id) query = query.eq("admin_id", filters.admin_id);

  const { data: despachos, error } = await query.order("created_at", { ascending: false });
  if (error) throw new Error(`Error al listar despachos: ${error.message}`);
  if (!despachos?.length) return [];

  // 2. Obtener agregación de items
  const ids = despachos.map((d) => d.id);
  const { data: items, error: errItems } = await supabase
    .from("traslados_items")
    .select("despacho_id, cantidad_despachador, agotado, cantidad_admin")
    .in("despacho_id", ids);

  if (errItems) throw new Error(`Error al obtener resumen de items: ${errItems.message}`);

  // 3. Armar resumen por despacho
  const agg = {};
  for (const item of items || []) {
    if (!agg[item.despacho_id]) {
      agg[item.despacho_id] = { total: 0, completos: 0, incompletos: 0, agotados: 0, pendientes: 0 };
    }
    agg[item.despacho_id].total++;
    if (item.agotado) {
      agg[item.despacho_id].agotados++;
    } else if (item.cantidad_despachador == null) {
      agg[item.despacho_id].pendientes++;
    } else if (Number(item.cantidad_despachador) >= Number(item.cantidad_admin)) {
      agg[item.despacho_id].completos++;
    } else {
      agg[item.despacho_id].incompletos++;
    }
  }

  return despachos.map((d) => ({
    ...d,
    resumen: agg[d.id] || { total: 0, completos: 0, incompletos: 0, agotados: 0, pendientes: 0 },
  }));
}

/**
 * Obtener despachos para el panel del auditor: SOLO la cabecera.
 *
 * Deliberadamente NO trae ítems ni firmas. El sidebar solo pinta ruta, estado y
 * fecha; los ítems se piden aparte por `/auditor/despachos/:id`, que es donde
 * vive el filtro de la auditoría ciega (oculta los que no salieron de origen y
 * la firma del despachador).
 *
 * Si acá devolviéramos los ítems, ese filtro no serviría de nada: bastaría con
 * comparar ambas respuestas en la pestaña de red para deducir cuáles se
 * ocultaron — o sea, cuáles mandó el despachador en cero. Un dato que no viaja
 * es el único que no se puede espiar.
 */
export async function findForAuditor() {
  const { data, error } = await supabase
    .from(TABLE)
    .select("id, origen, destino, estado, created_at, updated_at")
    .in("estado", ["Recolectado", "En_recepcion"]);

  if (error) throw new Error(`Error al listar despachos para auditoría: ${error.message}`);
  return data;
}
