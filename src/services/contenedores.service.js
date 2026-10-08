import { supabase } from "../config/supabase.js";
import * as DespachoModel from "../models/Despacho.model.js";
import * as ContenedorModel from "../models/Contenedor.model.js";
import { createError } from "../middleware/errorHandler.js";

/* =============================================
   CONTENEDORES — el despachador agrupa lo que despacha (migración 037)

   Opcionales: un despacho sin contenedores funciona igual que siempre. Cualquier
   despachador del traslado puede crear, llenar, cerrar o reabrir cualquier
   contenedor mientras se recolecta — la recolección es compartida (023) y una
   canastilla no es de nadie: es de quien la tenga en la mano.

   El total por producto lo mantiene `ContenedorModel.recalcularTotal`; acá viven
   las reglas de cuándo se puede tocar qué.
   ============================================= */

const LARGO_MAX_NUMERO = 20;

/** Motivos que afirman que no se recogió nada (espejo de `motivoImplicaCero` del panel). */
const MOTIVOS_DE_CERO = ["sin_stock", "inventario_inflado"];

/** Error con código de negocio, para que el panel distinga el caso. */
function error(status, mensaje, codigo, extra = {}) {
  const e = createError(status, mensaje);
  e.codigo = codigo;
  Object.assign(e, extra);
  return e;
}

/** El contenedor del despacho o 404. */
async function contenedorDe(despachoId, contenedorId) {
  const c = await ContenedorModel.buscar(despachoId, contenedorId);
  if (!c) throw error(404, "Ese contenedor no es de este traslado (o se borró).", "CONTENEDOR_NO_EXISTE");
  return c;
}

export async function listar(despachoId) {
  return ContenedorModel.listarPorDespacho(despachoId);
}

/**
 * Crea un contenedor abierto. El número es el de la canastilla física.
 * @returns {Promise<{contenedor:object, aviso:string|null}>}
 */
export async function crear(despachoId, numero, despachadorId) {
  await DespachoModel.assertPuedeRecolectar(despachoId, despachadorId);

  const n = ContenedorModel.normalizarNumero(numero);
  if (!n) throw error(400, "Escribí el número de la canastilla.", "NUMERO_VACIO");
  if (n.length > LARGO_MAX_NUMERO) {
    throw error(400, `El número no puede tener más de ${LARGO_MAX_NUMERO} caracteres.`, "NUMERO_LARGO");
  }

  const existente = await ContenedorModel.buscarPorNumero(despachoId, n);
  const duplicado = () =>
    error(
      409,
      `La canastilla ${n} ya está en este traslado${existente?.creado_por ? ` (la abrió ${existente.creado_por})` : ""}. Entrá a esa en vez de crear otra.`,
      "NUMERO_DUPLICADO",
      { contenedor_id: existente?.id || null },
    );
  if (existente) throw duplicado();

  const contenedor = await ContenedorModel.crear(despachoId, n, despachadorId);
  if (!contenedor) throw duplicado();

  // Aviso, no bloqueo: puede ser una canastilla que volvió y se reusa.
  const otros = await ContenedorModel.usosEnOtrosDespachos(n, despachoId);
  const aviso = otros.length
    ? `Ojo: la canastilla ${n} también figura en otro traslado activo (${otros
        .map((id) => String(id).slice(0, 8))
        .join(", ")}). Verificá que el número esté bien.`
    : null;

  return { contenedor: { ...contenedor, items: [] }, aviso };
}

/**
 * Llena (o corrige) lo que hay de varios productos en varios contenedores.
 * Cada fila es el TOTAL de ese producto en ese contenedor, no un incremento: la
 * cola del celular puede reenviar el mismo lote sin duplicar nada.
 *
 * Igual que `/recolectar`, un renglón rechazado no tumba el lote: vuelve en
 * `rechazados` con su código y el resto se escribe. Si un contenedor que alguien
 * cerró trabara el POST entero, la cola quedaría atascada y nada se guardaría.
 *
 * @param {string} despachoId
 * @param {string} despachadorId
 * @param {Array<{contenedor_id:string, item_id:string, cantidad:number}>} asignaciones
 * @returns {Promise<{resultados:object[], rechazados:object[]}>}
 */
export async function asignar(despachoId, despachadorId, asignaciones = []) {
  await DespachoModel.assertPuedeRecolectar(despachoId, despachadorId);

  const contenedores = new Map(
    (await ContenedorModel.listarPorDespacho(despachoId)).map((c) => [c.id, c]),
  );

  // Gana la última aparición de cada (contenedor, producto).
  const unicas = [
    ...new Map(asignaciones.map((a) => [`${a.contenedor_id}|${a.item_id}`, a])).values(),
  ];

  const itemIds = [...new Set(unicas.map((a) => a.item_id))];
  const { data: renglones, error: errItems } = await supabase
    .from("traslados_items")
    .select("id, despacho_id, cantidad_admin, cantidad_suelta, cantidad_despachador, descripcion, motivo")
    .in("id", itemIds.length ? itemIds : ["00000000-0000-0000-0000-000000000000"])
    .eq("despacho_id", despachoId);
  if (errItems) throw new Error(`Error al leer los productos: ${errItems.message}`);
  const renglonPorId = new Map((renglones || []).map((r) => [r.id, r]));

  const resultados = [];
  const rechazados = [];
  const rechazar = (a, codigo, mensaje) =>
    rechazados.push({ contenedor_id: a.contenedor_id, item_id: a.item_id, codigo, error: mensaje });

  for (const a of unicas) {
    const c = contenedores.get(a.contenedor_id);
    if (!c) {
      rechazar(a, "CONTENEDOR_NO_EXISTE", "Ese contenedor ya no existe en este traslado.");
      continue;
    }
    if (c.estado !== "abierto") {
      rechazar(
        a,
        "CONTENEDOR_CERRADO",
        `La canastilla ${c.numero} está cerrada${c.cerrado_por ? ` (la cerró ${c.cerrado_por})` : ""}. Reabrila para cambiar lo que tiene.`,
      );
      continue;
    }
    const r = renglonPorId.get(a.item_id);
    if (!r) {
      rechazar(
        a,
        "RENGLON_FUERA_DEL_DESPACHO",
        "Este producto ya no es parte de este traslado (se movió a otra parte o se quitó).",
      );
      continue;
    }

    const cantidad = Math.max(0, Number(a.cantidad) || 0);

    // Tope contra lo que hay AHORA en la base: lo suelto + los OTROS contenedores.
    const filas = await ContenedorModel.asignacionesDeItems([r.id]);
    const enOtros = filas
      .filter((f) => f.contenedor_id !== c.id)
      .reduce((s, f) => s + (Number(f.cantidad) || 0), 0);
    // Renglón contado ANTES de la 037 sin backfill: tiene total, no tiene suelto
    // y nunca pasó por una canastilla ⇒ todo lo contado iba suelto. Si ya tiene
    // canastillas, un suelto NULL es "nada suelto" (lo escribió esta misma ruta).
    const esPrevio = r.cantidad_suelta == null && r.cantidad_despachador != null && filas.length === 0;
    const suelta = esPrevio ? Number(r.cantidad_despachador) || 0 : Number(r.cantidad_suelta) || 0;
    const pedido = Number(r.cantidad_admin) || 0;
    if (suelta + enOtros + cantidad > pedido + 1e-9) {
      const disponible = Math.max(0, pedido - suelta - enOtros);
      rechazar(
        a,
        "TOPE",
        `"${r.descripcion || "Este producto"}": se pidieron ${pedido} y ya hay ${suelta + enOtros} entre suelto y otros contenedores. En la canastilla ${c.numero} caben como máximo ${disponible}.`,
      );
      continue;
    }

    // Se fija lo suelto si todavía no estaba (renglón contado antes de la 037):
    // sin esto el recálculo lo tomaría como 0 y el total perdería esas unidades.
    const patch = {};
    if (esPrevio) patch.cantidad_suelta = suelta;
    // Encontrar el producto y meterlo en una canastilla desmiente "agotado" y los
    // motivos que dicen "no había nada" (Agotado, Inventario Fantasma). Los demás
    // (surtido parcial, corta fecha) explican un faltante que puede seguir siendo
    // cierto con unidades en la canastilla: se conservan. El panel aplica la
    // misma regla al mostrar (utils/contenedoresRecoleccion), así pantalla y base
    // dicen lo mismo sin releer.
    if (cantidad > 0) {
      patch.agotado = false;
      if (MOTIVOS_DE_CERO.includes(r.motivo)) patch.motivo = null;
    }
    if (Object.keys(patch).length) {
      const { error: errPatch } = await supabase
        .from("traslados_items")
        .update(patch)
        .eq("id", r.id)
        .eq("despacho_id", despachoId);
      if (errPatch) throw new Error(`Error al preparar el producto: ${errPatch.message}`);
    }

    await ContenedorModel.escribirAsignacion(c.id, r.id, cantidad, despachadorId);
    const total = await ContenedorModel.recalcularTotal(r.id);
    resultados.push({ contenedor_id: c.id, item_id: r.id, cantidad, total });
  }

  return { resultados, rechazados };
}

/** Cerrar: la canastilla está llena y se sube al camión. */
export async function cerrar(despachoId, contenedorId, despachadorId) {
  await DespachoModel.assertPuedeRecolectar(despachoId, despachadorId);
  const c = await contenedorDe(despachoId, contenedorId);
  if (c.estado === "cerrado") return c; // idempotente: un doble toque no es un error
  if ((await ContenedorModel.contarContenido(c.id)) === 0) {
    throw error(
      409,
      `La canastilla ${c.numero} está vacía. Metele algo antes de cerrarla, o borrala.`,
      "CONTENEDOR_VACIO",
    );
  }
  return ContenedorModel.actualizarEstado(c.id, "cerrado", despachadorId);
}

/**
 * Reabrir para corregir. Solo mientras se recolecta: una vez cargado el camión,
 * lo declarado es lo que viajó. (Desde "Pendiente de carga" se puede volver a
 * recolección y ahí sí reabrir — el camión todavía no salió.)
 */
export async function reabrir(despachoId, contenedorId, despachadorId) {
  await DespachoModel.assertPuedeRecolectar(despachoId, despachadorId);
  const c = await contenedorDe(despachoId, contenedorId);
  if (c.estado === "abierto") return c;
  return ContenedorModel.actualizarEstado(c.id, "abierto", despachadorId);
}

/**
 * Borrar. Solo VACÍO: borrar uno con producto adentro bajaría el total de esos
 * productos sin que nadie los haya sacado de verdad de la canastilla.
 */
export async function borrar(despachoId, contenedorId, despachadorId) {
  await DespachoModel.assertPuedeRecolectar(despachoId, despachadorId);
  const c = await contenedorDe(despachoId, contenedorId);
  if ((await ContenedorModel.contarContenido(c.id)) > 0) {
    throw error(
      409,
      `La canastilla ${c.numero} tiene productos. Sacalos primero (escaneándolos con la canastilla abierta) o dejala.`,
      "CONTENEDOR_CON_CONTENIDO",
    );
  }
  await ContenedorModel.borrar(c.id);
  return { borrado: c.id };
}

/**
 * Portón de FINALIZAR la recolección. Corre antes de pasar a Pendiente_carga.
 *
 *   1. Ningún contenedor abierto: una canastilla abierta es una que alguien
 *      todavía está llenando. Cerrar el conteo con ella abierta es firmar algo
 *      que puede cambiar.
 *   2. Ningún contenedor vacío (cerrar exige contenido, pero reabrir y vaciar no).
 *   3. Se RECALCULA el total de cada producto que está en contenedores, con la
 *      lista ya quieta, y se verifica el tope. Es la red de las carreras de
 *      milisegundos de `recalcularTotal`: lo que llega a SIESA sale de acá.
 */
export async function validarParaFinalizar(despachoId) {
  const contenedores = await ContenedorModel.listarPorDespacho(despachoId);
  if (!contenedores.length) return;

  const abiertos = contenedores.filter((c) => c.estado !== "cerrado");
  if (abiertos.length) {
    throw error(
      409,
      `Cerrá ${abiertos.length === 1 ? "la canastilla" : "las canastillas"} ${abiertos
        .map((c) => c.numero)
        .join(", ")} antes de finalizar.`,
      "CONTENEDORES_ABIERTOS",
    );
  }
  const vacios = contenedores.filter((c) => !c.items.length);
  if (vacios.length) {
    throw error(
      409,
      `${vacios.length === 1 ? "La canastilla" : "Las canastillas"} ${vacios
        .map((c) => c.numero)
        .join(", ")} ${vacios.length === 1 ? "está vacía" : "están vacías"}. Borralas antes de finalizar.`,
      "CONTENEDORES_VACIOS",
    );
  }

  const itemIds = [...new Set(contenedores.flatMap((c) => c.items.map((i) => i.item_id)))];
  for (const id of itemIds) await ContenedorModel.recalcularTotal(id);

  const { data: renglones, error: errItems } = await supabase
    .from("traslados_items")
    .select("id, descripcion, cantidad_admin, cantidad_despachador")
    .in("id", itemIds);
  if (errItems) throw new Error(`Error al verificar los productos: ${errItems.message}`);
  const pasados = (renglones || []).filter(
    (r) => Number(r.cantidad_despachador) > (Number(r.cantidad_admin) || 0) + 1e-9,
  );
  if (pasados.length) {
    throw error(
      409,
      `Entre canastillas y suelto se pasaron de lo pedido en: ${pasados
        .map((r) => `${r.descripcion} (${r.cantidad_despachador} de ${r.cantidad_admin})`)
        .join("; ")}. Corregí antes de finalizar.`,
      "TOPE_EXCEDIDO",
    );
  }
}

/** Abandonar la recolección: los contenedores se van con el conteo. */
export async function borrarTodos(despachoId) {
  return ContenedorModel.borrarDeDespacho(despachoId);
}

/**
 * Resumen para el MANIFIESTO: qué canastillas van en el camión, cuántos productos
 * y unidades lleva cada una y cuánto pesa. `null` si el despacho no usó
 * contenedores (el manifiesto sale como siempre, con una línea por peso).
 *
 * Unidades y peso en UNIDAD BASE (ARQUITECTURA §6.5): `cantidad × factor`. El
 * peso es null en la canastilla que tenga algún producto sin peso en SIESA — un
 * total parcial con cara de completo declara menos de lo que lleva el camión.
 */
export function resumenParaManifiesto(items = [], contenedores = []) {
  if (!contenedores.length) return null;
  const porId = new Map(items.map((it) => [it.id, it]));

  const acumular = (acc, it, cantidad) => {
    const factor = Number(it.factor) || 1;
    const base = cantidad * factor;
    acc.productos += 1;
    acc.unidades += base;
    const p = Number(it.peso_unitario);
    if (it.peso_unitario == null || !Number.isFinite(p) || p <= 0) acc.sinPeso += 1;
    else acc.gramos += p * base;
  };
  const cerrar = (acc) => ({
    productos: acc.productos,
    unidades: Math.round(acc.unidades * 1000) / 1000,
    peso_kg: acc.sinPeso ? null : Math.round((acc.gramos / 1000) * 100) / 100,
  });

  const enContenedores = new Map();
  const salida = contenedores.map((c) => {
    const acc = { productos: 0, unidades: 0, gramos: 0, sinPeso: 0 };
    for (const f of c.items) {
      const it = porId.get(f.item_id);
      if (!it) continue;
      acumular(acc, it, Number(f.cantidad) || 0);
      enContenedores.set(f.item_id, (enContenedores.get(f.item_id) || 0) + (Number(f.cantidad) || 0));
    }
    return { numero: c.numero, ...cerrar(acc) };
  });

  const suelto = { productos: 0, unidades: 0, gramos: 0, sinPeso: 0 };
  for (const it of items) {
    const resto = (Number(it.cantidad_despachador) || 0) - (enContenedores.get(it.id) || 0);
    if (resto > 0) acumular(suelto, it, resto);
  }

  return { contenedores: salida, suelto: cerrar(suelto) };
}
