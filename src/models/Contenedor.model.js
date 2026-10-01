import { supabase } from "../config/supabase.js";

/* =============================================
   CONTENEDORES (migración 037)

   Canastillas en que el despachador agrupa un despacho. Opcionales. El total por
   producto sigue en `traslados_items.cantidad_despachador`; los contenedores son
   su desglose:

       cantidad_despachador = cantidad_suelta + Σ traslados_contenedor_items.cantidad

   Este modelo es el único que escribe esa suma (`recalcularTotal`).
   ============================================= */

const TABLE = "traslados_contenedores";
const TABLE_ITEMS = "traslados_contenedor_items";

/**
 * Número de canastilla normalizado: " c-15 " → "C-15", "007" → "7".
 *
 * Las canastillas vienen numeradas y la persona lo digita a mano: con la misma
 * canastilla escrita de dos formas, el sistema creería que son dos y la dejaría
 * entrar dos veces al mismo camión.
 */
export function normalizarNumero(numero) {
  const t = String(numero ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ");
  return /^\d+$/.test(t) ? t.replace(/^0+(?=\d)/, "") : t;
}

/** Todos los contenedores de un despacho con su contenido, en orden de creación. */
export async function listarPorDespacho(despachoId) {
  const { data: contenedores, error } = await supabase
    .from(TABLE)
    .select("*")
    .eq("despacho_id", despachoId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (error) throw new Error(`Error al leer los contenedores: ${error.message}`);
  if (!contenedores?.length) return [];

  const { data: filas, error: errItems } = await supabase
    .from(TABLE_ITEMS)
    .select("contenedor_id, item_id, cantidad, actualizado_por, updated_at")
    .in(
      "contenedor_id",
      contenedores.map((c) => c.id),
    )
    .order("id", { ascending: true });
  if (errItems) throw new Error(`Error al leer el contenido de los contenedores: ${errItems.message}`);

  const porContenedor = new Map(contenedores.map((c) => [c.id, []]));
  for (const f of filas || []) porContenedor.get(f.contenedor_id)?.push(f);
  return contenedores.map((c) => ({ ...c, items: porContenedor.get(c.id) || [] }));
}

/** Un contenedor, acotado a su despacho. `null` si no existe o es de otro. */
export async function buscar(despachoId, contenedorId) {
  const { data, error } = await supabase
    .from(TABLE)
    .select("*")
    .eq("id", contenedorId)
    .eq("despacho_id", despachoId)
    .maybeSingle();
  if (error) throw new Error(`Error al leer el contenedor: ${error.message}`);
  return data;
}

/** El contenedor con ese número en el despacho, o null. */
export async function buscarPorNumero(despachoId, numero) {
  const { data, error } = await supabase
    .from(TABLE)
    .select("*")
    .eq("despacho_id", despachoId)
    .eq("numero", normalizarNumero(numero))
    .maybeSingle();
  if (error) throw new Error(`Error al leer el contenedor: ${error.message}`);
  return data;
}

/**
 * Despachos ACTIVOS (fuera de este) que tienen una canastilla con ese número.
 * Solo se usa para AVISAR: una canastilla física no puede ir en dos camiones a la
 * vez, así que casi seguro es un error de tipeo — pero puede ser una canastilla
 * que volvió y se reusa, y eso no se puede saber desde acá.
 */
export async function usosEnOtrosDespachos(numero, despachoId) {
  const { data, error } = await supabase
    .from(TABLE)
    .select("despacho_id, traslados_despachos(estado, inactivo)")
    .eq("numero", normalizarNumero(numero))
    .neq("despacho_id", despachoId);
  if (error) return [];
  const ACTIVOS = ["En_recoleccion", "Pendiente_carga", "Recolectado", "En_recepcion"];
  return (data || [])
    .filter((r) => {
      const d = r.traslados_despachos;
      return d && !d.inactivo && ACTIVOS.includes(d.estado);
    })
    .map((r) => r.despacho_id);
}

export async function crear(despachoId, numero, creadoPor) {
  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      despacho_id: despachoId,
      numero: normalizarNumero(numero),
      estado: "abierto",
      creado_por: creadoPor || null,
    })
    .select()
    .single();
  if (error) {
    // Dos celulares creando la misma canastilla al mismo tiempo: la base es la
    // que decide, y el segundo se entera con el mismo mensaje que si la hubiera
    // visto antes.
    if (error.code === "23505") return null;
    throw new Error(`Error al crear el contenedor: ${error.message}`);
  }
  return data;
}

export async function actualizarEstado(contenedorId, estado, por) {
  const ahora = new Date().toISOString();
  const patch =
    estado === "cerrado"
      ? { estado, cerrado_por: por || null, cerrado_at: ahora, updated_at: ahora }
      : { estado, cerrado_por: null, cerrado_at: null, updated_at: ahora };
  const { data, error } = await supabase
    .from(TABLE)
    .update(patch)
    .eq("id", contenedorId)
    .select()
    .single();
  if (error) throw new Error(`Error al actualizar el contenedor: ${error.message}`);
  return data;
}

export async function borrar(contenedorId) {
  const { error } = await supabase.from(TABLE).delete().eq("id", contenedorId);
  if (error) throw new Error(`Error al borrar el contenedor: ${error.message}`);
}

/**
 * Cambia el estado de RECEPCIÓN (038). `soloSi` ata la escritura al estado leído
 * — dos auditores cerrando la misma canastilla a la vez: el segundo no pisa el
 * resultado del primero.
 * @returns {Promise<object|null>} la fila, o null si el estado ya no era `soloSi`
 */
export async function actualizarRecepcion(contenedorId, patch, { soloSi } = {}) {
  let q = supabase
    .from(TABLE)
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", contenedorId);
  if (soloSi) q = q.in("recepcion_estado", [].concat(soloSi));
  const { data, error } = await q.select().maybeSingle();
  if (error) throw new Error(`Error al actualizar la recepción de la canastilla: ${error.message}`);
  return data;
}

/** Canastilla que llegó sin estar en la lista (038): la registra el auditor. */
export async function crearNoListado(despachoId, numero, auditor) {
  const ahora = new Date().toISOString();
  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      despacho_id: despachoId,
      numero: normalizarNumero(numero),
      // Del lado del despacho "cerrada": nadie la llenó en este sistema.
      estado: "cerrado",
      no_listado: true,
      creado_por: auditor || null,
      recepcion_estado: "contando",
      recepcion_por: auditor || null,
      recepcion_at: ahora,
    })
    .select()
    .single();
  if (error) {
    if (error.code === "23505") return null;
    throw new Error(`Error al registrar la canastilla: ${error.message}`);
  }
  return data;
}

/** Borra TODOS los contenedores de un despacho (abandonar la recolección). */
export async function borrarDeDespacho(despachoId) {
  const { data: ids, error: errLeer } = await supabase
    .from(TABLE)
    .select("id")
    .eq("despacho_id", despachoId);
  if (errLeer) throw new Error(`Error al leer los contenedores: ${errLeer.message}`);
  if (!ids?.length) return;
  // El contenido se borra explícito además del CASCADE: la base en memoria de los
  // tests no lo emula, y escribirlo deja claro qué se pierde.
  await supabase
    .from(TABLE_ITEMS)
    .delete()
    .in(
      "contenedor_id",
      ids.map((r) => r.id),
    );
  const { error } = await supabase.from(TABLE).delete().eq("despacho_id", despachoId);
  if (error) throw new Error(`Error al borrar los contenedores: ${error.message}`);
}

/** Cantidad de filas con contenido de un contenedor. */
export async function contarContenido(contenedorId) {
  const { data, error } = await supabase
    .from(TABLE_ITEMS)
    .select("id")
    .eq("contenedor_id", contenedorId);
  if (error) throw new Error(`Error al leer el contenedor: ${error.message}`);
  return (data || []).length;
}

/** Filas de contenedor de unos renglones: [{ contenedor_id, item_id, cantidad }]. */
export async function asignacionesDeItems(itemIds) {
  if (!itemIds?.length) return [];
  const { data, error } = await supabase
    .from(TABLE_ITEMS)
    .select("contenedor_id, item_id, cantidad")
    .in("item_id", itemIds);
  if (error) throw new Error(`Error al leer los contenedores del producto: ${error.message}`);
  return data || [];
}

/** Σ en contenedores por renglón. */
export async function sumaPorItem(itemIds) {
  const suma = new Map();
  for (const f of await asignacionesDeItems(itemIds)) {
    suma.set(f.item_id, (suma.get(f.item_id) || 0) + (Number(f.cantidad) || 0));
  }
  return suma;
}

/**
 * Escribe lo que hay de un renglón en un contenedor. 0 = sacarlo (borra la fila:
 * "está en el contenedor" y "tiene fila" tienen que ser lo mismo).
 */
export async function escribirAsignacion(contenedorId, itemId, cantidad, por) {
  const n = Number(cantidad) || 0;
  if (n <= 0) {
    const { error } = await supabase
      .from(TABLE_ITEMS)
      .delete()
      .eq("contenedor_id", contenedorId)
      .eq("item_id", itemId);
    if (error) throw new Error(`Error al sacar el producto del contenedor: ${error.message}`);
    return;
  }
  const { error } = await supabase.from(TABLE_ITEMS).upsert(
    {
      contenedor_id: contenedorId,
      item_id: itemId,
      cantidad: n,
      actualizado_por: por || null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "contenedor_id,item_id" },
  );
  if (error) throw new Error(`Error al guardar el producto en el contenedor: ${error.message}`);
}

/**
 * Total del renglón a partir de su desglose. NULL si no hay nada contado (ni
 * suelto ni en contenedores): "sin contar" no es "contado en cero".
 */
export function totalDesdeDesglose(suelta, enContenedores) {
  const c = Number(enContenedores) || 0;
  if (suelta == null && c === 0) return null;
  return (Number(suelta) || 0) + c;
}

/**
 * Reescribe `cantidad_despachador = cantidad_suelta + Σ contenedores`.
 *
 * Compare-and-swap sobre el total leído: si otra escritura lo cambió en el medio,
 * se relee y se vuelve a calcular. Dos personas llenando el mismo producto en dos
 * canastillas distintas terminan con la suma de las dos, no con la del último.
 *
 * Igual queda una ventana de milisegundos en la que dos recálculos se cruzan; por
 * eso finalizar la recolección vuelve a pasar por acá con TODOS los renglones que
 * tienen contenedores (ver ContenedoresService.validarParaFinalizar). Lo que llega
 * a SIESA siempre sale de un recálculo hecho con la lista cerrada.
 *
 * @returns {Promise<number|null>} el total escrito
 */
export async function recalcularTotal(itemId) {
  for (let intento = 0; intento < 4; intento += 1) {
    const { data: it, error } = await supabase
      .from("traslados_items")
      .select("cantidad_suelta, cantidad_despachador")
      .eq("id", itemId)
      .maybeSingle();
    if (error) throw new Error(`Error al leer el producto: ${error.message}`);
    if (!it) return null;

    const suma = (await sumaPorItem([itemId])).get(itemId) || 0;
    const total = totalDesdeDesglose(it.cantidad_suelta, suma);
    const actual = it.cantidad_despachador == null ? null : Number(it.cantidad_despachador);
    if (actual === total) return total;

    let q = supabase.from("traslados_items").update({ cantidad_despachador: total }).eq("id", itemId);
    q = actual == null ? q.is("cantidad_despachador", null) : q.eq("cantidad_despachador", actual);
    const { data: escrito, error: errUpd } = await q.select("id").maybeSingle();
    if (errUpd) throw new Error(`Error al actualizar el total del producto: ${errUpd.message}`);
    if (escrito) return total;
  }
  throw new Error("El total del producto cambió varias veces seguidas mientras se recalculaba.");
}
