import * as ContenedorModel from "../models/Contenedor.model.js";
import * as ConteoModel from "../models/RecepcionConteo.model.js";
import * as DespachoModel from "../models/Despacho.model.js";
import { createError } from "../middleware/errorHandler.js";
import { ocultoParaAuditor } from "./despacho.service.js";
import { despachoContable, senalarRecepcionActiva } from "./recepcion.service.js";

/* =============================================
   RECEPCIÓN POR CANASTILLA (migración 038)

   El auditor baja una canastilla, entra a ella, escanea lo que trae y la
   cierra. Al cerrarla se compara SOLO esa canastilla contra lo que el
   despachador declaró en ella.

   CIEGA: el auditor nunca recibe cantidades esperadas ni el contenido. Al
   cerrar se le devuelve qué productos recontar (los que contó y no cuadran) y
   CUÁNTOS productos declarados no encontró, sin nombrarlos.

   El inventario se decide en la comparación FINAL del traslado (la de siempre),
   que suma todas las canastillas por producto: un producto en la canastilla
   equivocada es "mal ubicado", no faltante + sobrante.
   ============================================= */

const ABIERTA = ["pendiente", "contando"];
const RESUELTA = ["cerrado", "no_recibido"];

function error(status, mensaje, codigo, extra = {}) {
  const e = createError(status, mensaje);
  e.codigo = codigo;
  Object.assign(e, extra);
  return e;
}

/** Lo que el auditor puede saber de una canastilla: número y estado. Nunca el contenido. */
export function vistaCiega(c) {
  return {
    id: c.id,
    numero: c.numero,
    no_listado: Boolean(c.no_listado),
    recepcion_estado: c.recepcion_estado || "pendiente",
    recepcion_por: c.recepcion_por || null,
    recepcion_at: c.recepcion_at || null,
    // Del resultado solo lo que el auditor ya sabe por haberla cerrado: si cuadró.
    cuadro: c.recepcion_resultado ? Boolean(c.recepcion_resultado.match) : null,
  };
}

export async function listarParaAuditor(despachoId) {
  return (await ContenedorModel.listarPorDespacho(despachoId)).map(vistaCiega);
}

async function canastillaDe(despachoId, contenedorId) {
  const c = await ContenedorModel.buscar(despachoId, contenedorId);
  if (!c) throw error(404, "Esa canastilla no es de este traslado.", "CANASTILLA_NO_EXISTE");
  return c;
}

const codigoSinCeros = ConteoModel.codigoSinCeros;

/**
 * Comparación de UNA canastilla. Pura: recibe todo y no consulta nada.
 *
 * Todo en UND: lo esperado es `cantidad (UM del renglón) × factor`, igual que en
 * la comparación del traslado (ARQUITECTURA §6.5).
 *
 *   · cuadra        → contado == esperado
 *   · faltante      → esperado > 0 y no se contó nada. Se devuelve SOLO la
 *                     cantidad: nombrarlo le diría al auditor qué buscar.
 *   · confirmada    → contado == lo que se contó antes del recuento: dos conteos
 *                     iguales son una diferencia real, no un error de conteo.
 *   · recontar      → el resto. Por nombre, sin cantidades (como el comparar
 *                     de siempre): el auditor ya sabe que contó ese producto.
 *   · sobrante      → escaneado "fuera de lista" y que no es ningún producto
 *                     del traslado. Fue una decisión explícita del auditor
 *                     ("agregar"), así que no se pide recontar.
 *
 * Un "fuera de lista" cuyo código SÍ es un producto del traslado se suma a ese
 * producto (mismo criterio que confirmarAuditoria).
 *
 * @returns {{match:boolean, recontar:Array, faltantes:number, confirmadas:number,
 *            sobrantes:Array, contado:Record<string,number>, esperado:Record<string,number>}}
 */
export function compararCanastilla({ items = [], contenedor, filas = [] }) {
  const visibles = items.filter((it) => !ocultoParaAuditor(it));
  const porId = new Map(visibles.map((it) => [it.id, it]));
  const porCodigo = new Map(visibles.map((it) => [codigoSinCeros(it.codigo_item), it]));

  const esperado = new Map();
  for (const f of contenedor?.items || []) {
    const it = porId.get(f.item_id);
    if (!it) continue;
    esperado.set(it.id, (esperado.get(it.id) || 0) + (Number(f.cantidad) || 0) * (Number(it.factor) || 1));
  }

  const contado = new Map();
  const previo = new Map();
  const sobrantes = [];
  for (const f of filas) {
    if ((f.contenedor_id || null) !== contenedor.id) continue;
    const it = f.item_id ? porId.get(f.item_id) : porCodigo.get(codigoSinCeros(f.codigo_item));
    const n = Number(f.cantidad) || 0;
    if (!it) {
      if (n > 0) sobrantes.push({ codigo_item: f.codigo_item, descripcion: f.descripcion, cantidad: n });
      continue;
    }
    contado.set(it.id, (contado.get(it.id) || 0) + n);
    if (f.conteo_previo != null) previo.set(it.id, (previo.get(it.id) || 0) + (Number(f.conteo_previo) || 0));
  }

  const recontar = [];
  let faltantes = 0;
  let confirmadas = 0;
  for (const id of new Set([...esperado.keys(), ...contado.keys()])) {
    const esp = esperado.get(id) || 0;
    const cnt = contado.get(id) || 0;
    if (Math.abs(esp - cnt) < 1e-9) continue;
    if (cnt === 0) {
      faltantes += 1;
      continue;
    }
    if (previo.has(id) && Math.abs(previo.get(id) - cnt) < 1e-9) {
      confirmadas += 1;
      continue;
    }
    const it = porId.get(id);
    recontar.push({
      id,
      codigo_item: it.codigo_item,
      descripcion: it.descripcion,
      tipo: esp === 0 ? "no_esperado" : "diferencia",
    });
  }

  return {
    match: recontar.length === 0 && faltantes === 0,
    recontar,
    faltantes,
    confirmadas,
    sobrantes,
    contado: Object.fromEntries(contado),
    esperado: Object.fromEntries(esperado),
  };
}

/**
 * ENTRAR a una canastilla: "la estoy contando yo". Aviso, no candado: si la
 * tiene otra persona se avisa (409 CANASTILLA_EN_USO) y con `tomar` se sigue —
 * al compañero se le pudo morir el celular. Lo que él contó NO se pierde: sus
 * filas siguen sumando.
 */
export async function entrar(despachoId, contenedorId, auditorId, { tomar = false } = {}) {
  const despacho = await despachoContable(despachoId);
  const c = await canastillaDe(despachoId, contenedorId);
  if (RESUELTA.includes(c.recepcion_estado)) {
    throw error(
      409,
      `La canastilla ${c.numero} ya se ${c.recepcion_estado === "no_recibido" ? "declaró no recibida" : "cerró"}. Reabrila si hay que corregir algo.`,
      "CANASTILLA_RESUELTA",
    );
  }
  const otro =
    c.recepcion_estado === "contando" &&
    c.recepcion_por &&
    ConteoModel.normalizarAuditor(c.recepcion_por) !== ConteoModel.normalizarAuditor(auditorId);
  if (otro && !tomar) {
    throw error(
      409,
      `La canastilla ${c.numero} la está contando ${c.recepcion_por}.`,
      "CANASTILLA_EN_USO",
      { quien: c.recepcion_por },
    );
  }
  const actualizado = await ContenedorModel.actualizarRecepcion(
    c.id,
    { recepcion_estado: "contando", recepcion_por: auditorId, recepcion_at: new Date().toISOString() },
    { soloSi: ABIERTA },
  );
  if (!actualizado) throw error(409, "La canastilla cambió de estado. Recargá la lista.", "CANASTILLA_CAMBIO");
  await senalarRecepcionActiva(despacho);
  return vistaCiega(actualizado);
}

/**
 * CERRAR una canastilla: compararla y, si cuadra (o el auditor decide cerrarla
 * igual con `forzar`), darla por recibida.
 *
 * Si no cuadra y no se fuerza, NO se cierra: vuelve qué recontar, y la
 * canastilla sigue abierta para hacerlo con ella enfrente.
 */
export async function cerrar(despachoId, contenedorId, auditorId, { forzar = false } = {}) {
  const despacho = await despachoContable(despachoId);
  const c = await canastillaDe(despachoId, contenedorId);
  if (c.recepcion_estado === "cerrado") {
    return { cerrado: true, match: Boolean(c.recepcion_resultado?.match), recontar: [], faltantes: 0, confirmadas: 0, sobrantes: 0 };
  }
  if (c.recepcion_estado === "no_recibido") {
    throw error(409, `La canastilla ${c.numero} está declarada como no recibida. Reabrila primero.`, "CANASTILLA_RESUELTA");
  }

  const [lista, filas] = await Promise.all([
    ContenedorModel.listarPorDespacho(despachoId),
    ConteoModel.listarPorDespacho(despachoId),
  ]);
  const conContenido = lista.find((x) => x.id === c.id) || { ...c, items: [] };
  const r = compararCanastilla({ items: despacho.traslados_items || [], contenedor: conContenido, filas });

  const respuesta = {
    match: r.match,
    recontar: r.recontar,
    faltantes: r.faltantes,
    confirmadas: r.confirmadas,
    sobrantes: r.sobrantes.length,
  };
  if (!r.match && !forzar) return { cerrado: false, ...respuesta };

  const resultado = {
    match: r.match,
    forzado: !r.match,
    contado: r.contado,
    esperado: r.esperado,
    diferencias: r.recontar.length + r.confirmadas,
    faltantes: r.faltantes,
    sobrantes: r.sobrantes,
  };
  const actualizado = await ContenedorModel.actualizarRecepcion(
    c.id,
    {
      recepcion_estado: "cerrado",
      recepcion_por: auditorId,
      recepcion_at: new Date().toISOString(),
      recepcion_resultado: resultado,
    },
    { soloSi: ABIERTA },
  );
  // Otro celular la cerró en el medio: su resultado vale, este no la pisa.
  if (!actualizado) return { cerrado: true, ...respuesta };
  await DespachoModel.marcarAuditoriaAbierta(despachoId).catch(() => {});
  return { cerrado: true, ...respuesta };
}

/** Reabrir para corregir. Mientras el traslado no se haya confirmado. */
export async function reabrir(despachoId, contenedorId, auditorId) {
  await despachoContable(despachoId);
  const c = await canastillaDe(despachoId, contenedorId);
  if (ABIERTA.includes(c.recepcion_estado)) return vistaCiega(c);
  const actualizado = await ContenedorModel.actualizarRecepcion(
    c.id,
    {
      recepcion_estado: "contando",
      recepcion_por: auditorId,
      recepcion_at: new Date().toISOString(),
      recepcion_resultado: null,
    },
    { soloSi: RESUELTA },
  );
  return vistaCiega(actualizado || c);
}

/**
 * La canastilla NO LLEGÓ. Todo lo que el despachador declaró en ella queda como
 * faltante en la comparación final, y lo que alguien haya alcanzado a contar
 * "adentro" se descarta — si no llegó, eso se contó en otra parte por error.
 */
export async function noRecibida(despachoId, contenedorId, auditorId) {
  await despachoContable(despachoId);
  const c = await canastillaDe(despachoId, contenedorId);
  if (c.no_listado) {
    throw error(
      409,
      "Esa canastilla la registraste vos al recibir: si no llegó, no hay nada que declarar. Dejala vacía y cerrala.",
      "CANASTILLA_NO_LISTADA",
    );
  }
  await ConteoModel.borrarDeContenedor(despachoId, c.id);
  const actualizado = await ContenedorModel.actualizarRecepcion(c.id, {
    recepcion_estado: "no_recibido",
    recepcion_por: auditorId,
    recepcion_at: new Date().toISOString(),
    recepcion_resultado: null,
  });
  return vistaCiega(actualizado || c);
}

/**
 * Llegó una canastilla que NO está en la lista. Se registra para poder contar lo
 * que trae; queda marcada `no_listado` y sale en el monitor y en el correo.
 * Si el número SÍ está en la lista, no se duplica: se avisa para que entre a esa.
 */
export async function registrarNoListada(despachoId, numero, auditorId) {
  const despacho = await despachoContable(despachoId);
  const n = ContenedorModel.normalizarNumero(numero);
  if (!n) throw error(400, "Escribí el número de la canastilla.", "NUMERO_VACIO");
  if (n.length > 20) throw error(400, "El número no puede tener más de 20 caracteres.", "NUMERO_LARGO");

  const existente = await ContenedorModel.buscarPorNumero(despachoId, n);
  if (existente) {
    throw error(
      409,
      `La canastilla ${n} sí está en la lista de este traslado. Entrá a esa.`,
      "CANASTILLA_EN_LISTA",
      { contenedor_id: existente.id },
    );
  }
  const c = await ContenedorModel.crearNoListado(despachoId, n, auditorId);
  if (!c) {
    throw error(409, `La canastilla ${n} ya se registró (otro celular).`, "CANASTILLA_EN_LISTA");
  }
  await senalarRecepcionActiva(despacho);
  return vistaCiega(c);
}

/**
 * Portón de la comparación FINAL: con canastillas, todas tienen que estar
 * cerradas o declaradas no recibidas. Comparar el traslado con una canastilla a
 * medio contar daría diferencias que en realidad son "todavía no terminé".
 */
export async function validarParaComparar(despachoId) {
  const lista = await ContenedorModel.listarPorDespacho(despachoId);
  const sinCerrar = lista.filter((c) => !RESUELTA.includes(c.recepcion_estado || "pendiente"));
  if (sinCerrar.length) {
    throw error(
      409,
      `Faltan cerrar ${sinCerrar.length === 1 ? "la canastilla" : "las canastillas"} ${sinCerrar
        .map((c) => c.numero)
        .join(", ")}. Cerralas (o marcá las que no llegaron) antes de comparar el traslado.`,
      "CANASTILLAS_SIN_CERRAR",
    );
  }
}

/**
 * Una línea para el correo comparativo: lo que pasó con las canastillas. null si
 * el despacho no usó canastillas (el correo sale como siempre).
 */
export function textoResumenCorreo(detalle) {
  const lista = detalle?.canastillas || [];
  if (!lista.length) return null;
  const nums = (arr) => arr.map((c) => c.numero).join(", ");
  const conDif = lista.filter(
    (c) => c.recepcion_estado === "cerrado" && (c.forzado || c.productos.some((p) => p.esperado_und !== p.contado_und)),
  );
  const noLlego = lista.filter((c) => c.recepcion_estado === "no_recibido");
  const noListada = lista.filter((c) => c.no_listado);
  const partes = [`Canastillas: ${lista.length}`];
  if (conDif.length) partes.push(`con diferencias: ${nums(conDif)}`);
  if (noLlego.length) partes.push(`NO llegaron: ${nums(noLlego)}`);
  if (noListada.length) partes.push(`llegaron sin estar en la lista: ${nums(noListada)}`);
  const mal = detalle.mal_ubicados || [];
  if (mal.length) {
    partes.push(
      `mal ubicados (el total cuadra, el reparto no): ${mal
        .map((m) => `${m.descripcion} [${m.detalle.join("; ")}]`)
        .join(" · ")}`,
    );
  }
  return `${partes.join(" — ")}.`;
}

/**
 * Detalle para el ADMIN (no ciego): por canastilla, lo esperado contra lo
 * contado, y los productos MAL UBICADOS — el total del producto cuadra pero
 * repartido distinto de como lo declaró el despachador.
 *
 * Para las canastillas cerradas usa la foto del cierre (`recepcion_resultado`):
 * un "Recontar" del traslado entero junta después el producto en una sola fila.
 */
export async function detalleAdmin(despachoId) {
  const [despacho, lista, filas] = await Promise.all([
    DespachoModel.findById(despachoId),
    ContenedorModel.listarPorDespacho(despachoId),
    ConteoModel.listarPorDespacho(despachoId),
  ]);
  if (!despacho) throw createError(404, "Despacho no encontrado");
  const items = despacho.traslados_items || [];
  const porId = new Map(items.map((it) => [it.id, it]));

  const canastillas = lista.map((c) => {
    const vivo = compararCanastilla({ items, contenedor: c, filas });
    const foto = c.recepcion_estado === "cerrado" && c.recepcion_resultado ? c.recepcion_resultado : null;
    const contado = c.recepcion_estado === "no_recibido" ? {} : foto?.contado || vivo.contado;
    const esperado = vivo.esperado;
    const ids = new Set([...Object.keys(esperado), ...Object.keys(contado)]);
    return {
      id: c.id,
      numero: c.numero,
      estado: c.estado,
      no_listado: Boolean(c.no_listado),
      recepcion_estado: c.recepcion_estado || "pendiente",
      recepcion_por: c.recepcion_por || null,
      recepcion_at: c.recepcion_at || null,
      forzado: Boolean(foto?.forzado),
      sobrantes: foto?.sobrantes || vivo.sobrantes,
      productos: [...ids].map((id) => ({
        item_id: id,
        descripcion: porId.get(id)?.descripcion || "Producto",
        codigo_item: porId.get(id)?.codigo_item || null,
        esperado_und: esperado[id] || 0,
        contado_und: contado[id] || 0,
      })),
    };
  });

  // Mal ubicados: suma igual, reparto distinto. Solo con todas las canastillas
  // resueltas tiene sentido (antes, "distinto" puede ser "falta contar").
  const todasResueltas = lista.length > 0 && lista.every((c) => RESUELTA.includes(c.recepcion_estado));
  const malUbicados = [];
  if (todasResueltas) {
    const espTot = new Map();
    const cntTot = new Map();
    const reparto = new Map();
    // Lo suelto es una zona más: declarado en la 15 y encontrado suelto también
    // es "mal ubicado".
    const enCanastillas = new Map();
    for (const c of lista) {
      for (const f of c.items) {
        enCanastillas.set(f.item_id, (enCanastillas.get(f.item_id) || 0) + (Number(f.cantidad) || 0));
      }
    }
    const suelto = { numero: "suelto", productos: [] };
    const contadoSuelto = new Map();
    for (const f of filas) {
      if (f.contenedor_id || !f.item_id) continue;
      contadoSuelto.set(f.item_id, (contadoSuelto.get(f.item_id) || 0) + (Number(f.cantidad) || 0));
    }
    for (const it of items.filter((x) => !ocultoParaAuditor(x))) {
      const s =
        it.cantidad_suelta != null
          ? Number(it.cantidad_suelta)
          : (Number(it.cantidad_despachador) || 0) - (enCanastillas.get(it.id) || 0);
      const esp = Math.max(0, s) * (Number(it.factor) || 1);
      const cnt = contadoSuelto.get(it.id) || 0;
      if (esp || cnt) suelto.productos.push({ item_id: it.id, esperado_und: esp, contado_und: cnt });
    }
    for (const can of [...canastillas, suelto]) {
      for (const p of can.productos) {
        espTot.set(p.item_id, (espTot.get(p.item_id) || 0) + p.esperado_und);
        cntTot.set(p.item_id, (cntTot.get(p.item_id) || 0) + p.contado_und);
        if (Math.abs(p.esperado_und - p.contado_und) > 1e-9) {
          (reparto.get(p.item_id) || reparto.set(p.item_id, []).get(p.item_id)).push(
            `${can.numero}: ${p.contado_und} de ${p.esperado_und}`,
          );
        }
      }
    }
    for (const [id, detalle] of reparto) {
      if (Math.abs((espTot.get(id) || 0) - (cntTot.get(id) || 0)) < 1e-9) {
        malUbicados.push({ item_id: id, descripcion: porId.get(id)?.descripcion || "Producto", detalle });
      }
    }
  }

  return { canastillas, mal_ubicados: malUbicados };
}
