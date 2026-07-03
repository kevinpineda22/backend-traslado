import { supabase } from "../config/supabase.js";

const TABLE = "traslados_despachos";

/**
 * Obtener todos los despachos, opcionalmente filtrados por estado.
 * @param {object} filters - { estado, despachador_id, admin_id }
 */
export async function findAll(filters = {}) {
  let query = supabase.from(TABLE).select("*");

  if (filters.estado) query = query.eq("estado", filters.estado);
  if (filters.despachador_id) query = query.eq("despachador_id", filters.despachador_id);
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

  return findById(despacho.id);
}

/**
 * Actualizar el estado de un despacho validando la transición.
 */
export async function updateStatus(id, nuevoEstado) {
  const TRANSICIONES = {
    Creado: ["En_recoleccion"],
    En_recoleccion: ["Recolectado"],
    Recolectado: ["En_recepcion", "Auditado"],
    En_recepcion: ["Auditado", "Rechazado"],
    Auditado: [],
    Rechazado: [],
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
 * Obtener despachos para el panel del auditor (sin cantidades del despachador).
 * La auditoría ciega se logra omitiendo cantidad_despachador en la query.
 */
export async function findForAuditor() {
  const { data, error } = await supabase
    .from(TABLE)
    .select(`
      id, origen, destino, estado, created_at, updated_at,
      traslados_items(id, codigo_item, descripcion, unidad_medida, cantidad_admin),
      traslados_firmas(*)
    `)
    .in("estado", ["Recolectado", "En_recepcion"]);

  if (error) throw new Error(`Error al listar despachos para auditoría: ${error.message}`);
  return data;
}
