import { supabase } from "../config/supabase.js";

/* =============================================
   CONTEO EN CURSO DEL AUDITOR (migración 036)

   Una fila por (contenedor, producto, auditor). El total de un producto es la
   SUMA de las filas de todos los auditores: así dos personas que cuentan el
   mismo camión no se pisan, y la cola offline de cada celular puede llegar en
   cualquier orden sin que gane "el último".

   Cada fila guarda un TOTAL, no un incremento. Un reintento de la cola escribe
   exactamente lo mismo que el primer intento — idempotente por construcción.
   ============================================= */

const TABLE = "traslados_recepcion_conteos";

/** Código sin el relleno de ceros de SIESA ("0189202" → "189202"). */
export const codigoSinCeros = (c) => {
  const t = String(c ?? "").trim();
  return t.replace(/^0+/, "") || t;
};

/** El correo se compara normalizado: "Luis@" y "luis@" son la misma persona. */
export const normalizarAuditor = (a) => String(a || "").trim().toLowerCase();

/** Id del navegador, acotado: viaja en la clave y no debe poder inflarla. */
export const normalizarDispositivo = (d) => String(d || "").trim().slice(0, 64);

/**
 * Identidad de una fila: contenedor | producto | auditor | dispositivo.
 *
 * El producto es el renglón si viene en la lista, o el código (sin ceros) si es
 * mercancía que llegó fuera de lista. Sin normalizar el código, el mismo sobrante
 * escaneado una vez como "0189202" y otra como "189202" quedaba en dos filas y
 * se contaba dos veces.
 *
 * El dispositivo está porque las cuentas de sede se comparten: dos celulares con
 * el mismo correo son dos personas, y con una fila por correo se pisarían.
 */
export function claveConteo({ contenedor_id, item_id, codigo_item, contado_por, dispositivo }) {
  const producto = item_id ? `i:${item_id}` : `x:${codigoSinCeros(codigo_item)}`;
  return `${contenedor_id || "-"}|${producto}|${normalizarAuditor(contado_por)}|${normalizarDispositivo(dispositivo)}`;
}

/** ¿Esta fila es de esta persona EN este dispositivo? */
const esMia = (f, auditor, dispositivo) =>
  normalizarAuditor(f.contado_por) === normalizarAuditor(auditor) &&
  normalizarDispositivo(f.dispositivo) === normalizarDispositivo(dispositivo);

/** Borra todo lo contado dentro de una canastilla (se declaró que no llegó). */
export async function borrarDeContenedor(despachoId, contenedorId) {
  const { error } = await supabase
    .from(TABLE)
    .delete()
    .eq("despacho_id", despachoId)
    .eq("contenedor_id", contenedorId);
  if (error) throw new Error(`Error al limpiar el conteo de la canastilla: ${error.message}`);
}

/** Todas las filas de conteo de un despacho, en orden estable. */
export async function listarPorDespacho(despachoId) {
  const { data, error } = await supabase
    .from(TABLE)
    .select("*")
    .eq("despacho_id", despachoId)
    .order("id", { ascending: true });
  if (error) throw new Error(`Error al leer el conteo de recepción: ${error.message}`);
  return data || [];
}

/**
 * Filas de conteo de varios despachos, solo lo que el monitor necesita para el
 * avance. Pagina con orden estable (ver Despacho.findAllWithResumen).
 */
export async function listarResumenPorDespachos(ids) {
  if (!ids?.length) return [];
  const PAGINA = 1000;
  const filas = [];
  for (let desde = 0; ; desde += PAGINA) {
    const { data, error } = await supabase
      .from(TABLE)
      .select("despacho_id, item_id, cantidad, no_recibido, contado_por")
      .in("despacho_id", ids)
      .order("id", { ascending: true })
      .range(desde, desde + PAGINA - 1);
    if (error) throw new Error(`Error al leer el avance de recepción: ${error.message}`);
    if (!data?.length) break;
    filas.push(...data);
    if (data.length < PAGINA) break;
  }
  return filas;
}

/**
 * Escribe (o reemplaza) las filas de un auditor. Upsert por (despacho, clave).
 *
 * `conteo_previo` NO va en el upsert a propósito: lo escribe solo `recontar`. Si
 * viajara acá, cada escaneo posterior al recuento lo borraría y el producto
 * nunca podría confirmarse por repetición.
 *
 * Todas las filas llevan las MISMAS columnas: PostgREST arma el INSERT con la
 * unión de claves y a la fila que le falta una le pone NULL — un `descripcion`
 * ausente en un renglón le borraría la que tenía.
 */
export async function upsertLote(despachoId, filas) {
  if (!filas.length) return [];
  const ahora = new Date().toISOString();
  const payload = filas.map((f) => ({
    despacho_id: despachoId,
    clave: claveConteo(f),
    contenedor_id: f.contenedor_id || null,
    item_id: f.item_id || null,
    codigo_item: String(f.codigo_item || "").trim() || "S/COD",
    descripcion: f.descripcion || null,
    unidad_medida: f.unidad_medida || null,
    cantidad: Number(f.cantidad) || 0,
    no_recibido: Boolean(f.no_recibido),
    contado_por: normalizarAuditor(f.contado_por),
    dispositivo: normalizarDispositivo(f.dispositivo),
    updated_at: ahora,
  }));
  const { data, error } = await supabase
    .from(TABLE)
    .upsert(payload, { onConflict: "despacho_id,clave" })
    .select();
  if (error) throw new Error(`Error al guardar el conteo de recepción: ${error.message}`);
  return data || [];
}

/**
 * Apaga la marca "no recibido" de TODAS las filas de esos renglones, de
 * cualquier auditor. Es la acción "Deshacer no recibido": si la puso un
 * compañero, desmarcar solo la fila propia no cambiaría nada en pantalla y el
 * botón parecería roto.
 */
export async function quitarNoRecibido(despachoId, itemIds, contenedorId = null) {
  if (!itemIds.length) return;
  let q = supabase
    .from(TABLE)
    .update({ no_recibido: false, updated_at: new Date().toISOString() })
    .eq("despacho_id", despachoId)
    .in("item_id", itemIds);
  q = contenedorId ? q.eq("contenedor_id", contenedorId) : q.is("contenedor_id", null);
  const { error } = await q;
  if (error) throw new Error(`Error al quitar la marca de no recibido: ${error.message}`);
}

/**
 * RECONTAR — el número de quien recuenta pasa a ser el único que vale.
 *
 * Por cada producto: se guarda como `conteo_previo` lo que sumaban TODOS hasta
 * ahora, se borran las filas de los demás auditores y la de quien recuenta queda
 * en 0. Si no se borraran las ajenas, el recuento se sumaría encima del conteo
 * viejo de otra persona y el producto daría siempre de más.
 *
 * Se ejecuta en el servidor y no en cada celular porque solo acá se ven las filas
 * de todos.
 *
 * "Ajena" es toda fila que no sea de esta persona EN este celular — incluidas
 * las de otro celular suyo: el recuento es uno solo.
 *
 * @param {string} despachoId
 * @param {string} auditor - correo de quien recuenta
 * @param {string} dispositivo - id del navegador de quien recuenta
 * @param {Array<{id:string, codigo_item:string, descripcion?:string, unidad_medida?:string}>} renglones
 * @param {string|null} [contenedorId] - null = fuera de contenedor
 * @param {object} [opts]
 * @param {boolean} [opts.todas] - recuento del TRASLADO ENTERO (la comparación
 *   final): junta el producto de TODAS las canastillas en una sola fila suelta.
 *   Para ese momento las canastillas ya se cerraron y su foto quedó en
 *   `recepcion_resultado` (038); lo que importa ahora es el total del producto.
 */
export async function recontar(despachoId, auditor, dispositivo, renglones, contenedorId = null, { todas = false } = {}) {
  const actuales = await listarPorDespacho(despachoId);
  const yo = normalizarAuditor(auditor);
  const miDispositivo = normalizarDispositivo(dispositivo);
  const zona = todas ? null : contenedorId || null;

  for (const r of renglones) {
    const delProducto = actuales.filter(
      (f) => f.item_id === r.id && (todas || (f.contenedor_id || null) === zona),
    );
    const previo = delProducto.reduce((s, f) => s + (Number(f.cantidad) || 0), 0);
    const estabaNoRecibido = previo === 0 && delProducto.some((f) => f.no_recibido);

    // Se queda solo LA fila de esta persona, en este celular, en la zona del
    // recuento; todo lo demás del producto se borra.
    const ajenas = delProducto.filter(
      (f) => !(esMia(f, yo, miDispositivo) && (f.contenedor_id || null) === zona),
    );
    if (ajenas.length > 0) {
      const { error } = await supabase
        .from(TABLE)
        .delete()
        .in(
          "id",
          ajenas.map((f) => f.id),
        );
      if (error) throw new Error(`Error al preparar el recuento: ${error.message}`);
    }

    const fila = {
      contenedor_id: zona,
      item_id: r.id,
      codigo_item: r.codigo_item,
      descripcion: r.descripcion,
      unidad_medida: r.unidad_medida,
      contado_por: yo,
      dispositivo: miDispositivo,
    };
    const { error } = await supabase
      .from(TABLE)
      .upsert(
        {
          despacho_id: despachoId,
          clave: claveConteo(fila),
          contenedor_id: zona,
          item_id: r.id,
          codigo_item: String(r.codigo_item || "").trim() || "S/COD",
          descripcion: r.descripcion || null,
          unidad_medida: r.unidad_medida || null,
          cantidad: 0,
          // "No llegó" es una afirmación, no un número: sobrevive al recuento
          // igual que antes, cuando vivía en el celular.
          no_recibido: estabaNoRecibido,
          conteo_previo: previo,
          contado_por: yo,
          dispositivo: miDispositivo,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "despacho_id,clave" },
      );
    if (error) throw new Error(`Error al registrar el recuento: ${error.message}`);
  }

  return listarPorDespacho(despachoId);
}

/**
 * Consolida las filas de todos los auditores en lo que la recepción "dice" de
 * cada producto — la misma forma que antes armaba el celular para firmar.
 *
 *   · cantidad   = suma de todos los auditores (UND).
 *   · noRecibido = alguien lo declaró no recibido Y nadie contó nada. Si una
 *                  persona lo marcó y otra contó 5, llegó: el conteo gana.
 *   · previo     = lo contado antes de un recuento (respaldo al firmar).
 *
 * @param {Array<object>} filas - de `listarPorDespacho`
 * @returns {{ porItem: Map<string,{cantidad:number,noRecibido:boolean,previo:number|null}>,
 *             extras: Array<{codigo_item:string,descripcion:string|null,unidad_medida:string|null,cantidad:number}>,
 *             hayConteos: boolean }}
 */
export function consolidar(filas = []) {
  const porItem = new Map();
  const extras = new Map();

  for (const f of filas) {
    const cantidad = Number(f.cantidad) || 0;
    if (f.item_id) {
      const acc = porItem.get(f.item_id) || { cantidad: 0, marcaNoRecibido: false, previo: null };
      acc.cantidad += cantidad;
      if (f.no_recibido) acc.marcaNoRecibido = true;
      if (f.conteo_previo != null) acc.previo = (acc.previo || 0) + (Number(f.conteo_previo) || 0);
      porItem.set(f.item_id, acc);
    } else {
      const clave = codigoSinCeros(f.codigo_item);
      const acc = extras.get(clave) || {
        codigo_item: f.codigo_item,
        descripcion: f.descripcion || null,
        unidad_medida: f.unidad_medida || null,
        cantidad: 0,
      };
      acc.cantidad += cantidad;
      if (!acc.descripcion && f.descripcion) acc.descripcion = f.descripcion;
      extras.set(clave, acc);
    }
  }

  const salida = new Map();
  for (const [id, acc] of porItem) {
    salida.set(id, {
      cantidad: acc.cantidad,
      noRecibido: acc.marcaNoRecibido && acc.cantidad === 0,
      previo: acc.previo,
    });
  }

  return { porItem: salida, extras: [...extras.values()], hayConteos: filas.length > 0 };
}
