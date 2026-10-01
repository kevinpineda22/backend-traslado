import * as DespachoModel from "../models/Despacho.model.js";
import * as ConteoModel from "../models/RecepcionConteo.model.js";
import * as ContenedorModel from "../models/Contenedor.model.js";
import { createError } from "../middleware/errorHandler.js";
import { ocultoParaAuditor } from "./despacho.service.js";

/* =============================================
   RECEPCIÓN — el conteo del auditor, escaneo por escaneo (migración 036)

   El panel del auditor manda cada conteo apenas se registra (con una cola
   offline como la del despachador). Acá se guarda, se valida que el producto sea
   de este traslado y se mantiene la señal de "alguien está recibiendo esto".

   La AUDITORÍA CIEGA no cambia: lo que se guarda y se devuelve son los conteos
   de los propios auditores, nunca lo que envió el despachador.
   ============================================= */

/** Estados en los que todavía se puede contar. */
const ESTADOS_EN_RECEPCION = ["Recolectado", "En_recepcion"];

/**
 * Error de "esta recepción ya cerró". Lleva código propio para que la cola del
 * celular lo distinga de una caída de red: un conteo que llega tarde a un
 * traslado ya firmado no se va a poder guardar nunca, y reintentarlo cada 3
 * segundos dejaría el aviso de "guardando" prendido para siempre.
 */
function recepcionCerrada(estado) {
  const e = createError(
    409,
    `Este traslado ya está en ${estado}: la recepción se confirmó. No se guardó el conteo.`,
  );
  e.codigo = "RECEPCION_CERRADA";
  return e;
}

/** Lee el despacho y verifica que se pueda contar. Devuelve el despacho. */
export async function despachoContable(despachoId) {
  const despacho = await DespachoModel.findById(despachoId);
  if (!despacho) throw createError(404, "Despacho no encontrado");
  if (despacho.inactivo) {
    throw createError(
      409,
      "Este traslado está inactivo. Reactivalo desde el panel de alertas para continuar.",
    );
  }
  if (!ESTADOS_EN_RECEPCION.includes(despacho.estado)) throw recepcionCerrada(despacho.estado);
  return despacho;
}

/**
 * Marca que la recepción arrancó DE VERDAD: hay un conteo guardado.
 *
 *   · `Recolectado → En_recepcion`: el estado existía en las transiciones pero
 *     nadie lo usaba, porque el backend no se enteraba de que alguien contaba
 *     hasta la firma. Ahora sí se entera.
 *   · `auditoria_iniciada_at`: el hito de "cuándo empezó a contarse". Antes se
 *     sellaba en el primer Comparar, que podía ser una hora después del primer
 *     escaneo — la métrica de tiempo de auditoría salía corta.
 *   · `auditoria_abierta_at`: la señal de actividad del barrido de alertas. Cada
 *     conteo la refresca, así que un auditor contando nunca queda dentro de la
 *     ventana de inactivación (el problema de la migración 015, resuelto por la
 *     raíz: ya no hace falta adivinar la actividad por las aperturas).
 *
 * Best-effort: un fallo acá no puede tirar el guardado del conteo, que es lo que
 * la persona necesita a salvo. La transición en carrera (dos celulares a la vez)
 * da 409 en uno de los dos y es esperable.
 */
export async function senalarRecepcionActiva(despacho) {
  if (despacho.estado === "Recolectado") {
    await DespachoModel.updateStatus(despacho.id, "En_recepcion").catch(() => {});
  }
  await DespachoModel.marcarAuditoriaIniciada(despacho.id).catch(() => {});
  await DespachoModel.marcarAuditoriaAbierta(despacho.id).catch(() => {});
}

/** Las filas de conteo de un despacho (para hidratar el panel). */
export async function obtenerConteos(despachoId) {
  return ConteoModel.listarPorDespacho(despachoId);
}

/**
 * Guarda un lote de conteos de UN auditor (`POST /auditor/despachos/:id/conteos`).
 *
 * Cada conteo es el TOTAL que esa persona lleva del producto, no un incremento:
 * la cola del celular puede reenviar el mismo lote las veces que quiera.
 *
 * Un producto que NO es de este traslado (o que el auditor no debería ver) no
 * tumba el lote: vuelve en `fuera` y no se escribe. Mismo criterio que
 * `registrarLoteRecoleccion` — si un renglón raro trabara el POST entero, la cola
 * quedaría atascada y la persona seguiría contando sin que se guarde nada.
 *
 * @param {string} despachoId
 * @param {string} auditorId - correo de quien cuenta
 * @param {Array<{item_id?:string, codigo_item?:string, descripcion?:string,
 *                unidad_medida?:string, cantidad:number, no_recibido?:boolean,
 *                quitar_no_recibido?:boolean}>} conteos
 * @param {string} [dispositivo] - id del navegador (ver migración 036)
 * @returns {Promise<{guardados:number, fuera:Array<{item_id:string,error:string}>}>}
 */
export async function registrarConteos(despachoId, auditorId, conteos = [], dispositivo = "") {
  if (!String(auditorId || "").trim()) {
    throw createError(400, "Falta identificar al auditor que cuenta.");
  }
  const despacho = await despachoContable(despachoId);

  // Los mismos renglones que ve el auditor (ver auditor.controller.obtenerDetalle).
  const visibles = new Map(
    (despacho.traslados_items || []).filter((it) => !ocultoParaAuditor(it)).map((it) => [it.id, it]),
  );

  // Canastillas en las que se puede contar (038): las del despacho, mientras no
  // se cerraron ni se declararon no recibidas.
  const canastillas = new Map(
    (await ContenedorModel.listarPorDespacho(despachoId)).map((c) => [c.id, c]),
  );

  const filas = [];
  const fuera = [];
  // Dentro de un lote gana la última aparición de cada producto: la cola manda el
  // valor más nuevo, pero un lote armado a mano podría repetir.
  const unicos = new Map();
  for (const c of conteos) {
    const producto = c.item_id ? `i:${c.item_id}` : `x:${ConteoModel.codigoSinCeros(c.codigo_item)}`;
    unicos.set(`${c.contenedor_id || "-"}|${producto}`, c);
  }

  const tocadas = new Set();
  for (const c of unicos.values()) {
    const contenedorId = c.contenedor_id || null;
    if (contenedorId) {
      const can = canastillas.get(contenedorId);
      if (!can || !["pendiente", "contando"].includes(can.recepcion_estado)) {
        // Se cerró (o se declaró no recibida) desde otro celular mientras este
        // seguía contando: el conteo no tiene dónde ir. Vuelve aparte para que
        // la cola lo suelte y el panel lo diga — reintentarlo no lo arregla.
        fuera.push({
          item_id: c.item_id || null,
          codigo_item: c.codigo_item || null,
          contenedor_id: contenedorId,
          codigo: "CANASTILLA_CERRADA",
          error: can
            ? `La canastilla ${can.numero} ya se ${can.recepcion_estado === "no_recibido" ? "declaró no recibida" : "cerró"}${can.recepcion_por ? ` (${can.recepcion_por})` : ""}. Reabrila para seguir contando en ella.`
            : "Esa canastilla no es de este traslado.",
        });
        continue;
      }
      tocadas.add(contenedorId);
    }
    if (c.item_id) {
      const renglon = visibles.get(c.item_id);
      if (!renglon) {
        fuera.push({
          item_id: c.item_id,
          contenedor_id: contenedorId,
          error: "Este producto no es parte de este traslado.",
        });
        continue;
      }
      filas.push({
        contenedor_id: contenedorId,
        item_id: renglon.id,
        codigo_item: renglon.codigo_item,
        descripcion: renglon.descripcion,
        unidad_medida: renglon.unidad_medida,
        cantidad: c.cantidad,
        // Si se contó algo, llegó: el conteo apaga la marca.
        no_recibido: Boolean(c.no_recibido) && !(Number(c.cantidad) > 0),
        quitar_no_recibido: Boolean(c.quitar_no_recibido),
        contado_por: auditorId,
        dispositivo,
      });
    } else {
      filas.push({
        contenedor_id: contenedorId,
        item_id: null,
        codigo_item: c.codigo_item,
        descripcion: c.descripcion,
        unidad_medida: c.unidad_medida,
        cantidad: c.cantidad,
        no_recibido: false,
        contado_por: auditorId,
        dispositivo,
      });
    }
  }

  await ConteoModel.upsertLote(despachoId, filas);
  // "Deshacer no recibido" apaga la marca aunque la haya puesto un compañero.
  // Va DESPUÉS del upsert: si fuera antes, la propia fila del lote la volvería a
  // escribir con lo que traía.
  await ConteoModel.quitarNoRecibido(
    despachoId,
    filas
      .filter((f) => f.quitar_no_recibido && f.item_id && !f.contenedor_id)
      .map((f) => f.item_id),
  );
  if (filas.length > 0) await senalarRecepcionActiva(despacho);

  // Canastillas en las que se contó: quedan "contando" por quien contó. Si era
  // "pendiente" (nadie apretó Entrar desde este celular — una recarga, por
  // ejemplo), el primer conteo la reclama.
  for (const id of tocadas) {
    await ContenedorModel.actualizarRecepcion(
      id,
      { recepcion_estado: "contando", recepcion_por: auditorId, recepcion_at: new Date().toISOString() },
      { soloSi: ["pendiente", "contando"] },
    ).catch((e) => console.error("[recepción] no se pudo marcar la canastilla:", e.message));
  }

  return { guardados: filas.length, fuera };
}

/**
 * RECONTAR (`POST /auditor/despachos/:id/recontar`). Ver ConteoModel.recontar.
 * Devuelve TODAS las filas del despacho para que el panel se rehidrate con lo
 * que quedó — incluidas las de los otros auditores, que acaban de cambiar.
 */
export async function recontar(
  despachoId,
  auditorId,
  itemIds = [],
  dispositivo = "",
  { contenedorId = null, todas = false } = {},
) {
  if (!String(auditorId || "").trim()) {
    throw createError(400, "Falta identificar al auditor que recuenta.");
  }
  const despacho = await despachoContable(despachoId);
  // Recontar DENTRO de una canastilla (038): tiene que seguir abierta. Recontar
  // en una cerrada pondría en 0 un conteo que ya se comparó y se dio por bueno.
  if (contenedorId) {
    const can = await ContenedorModel.buscar(despachoId, contenedorId);
    if (!can || !["pendiente", "contando"].includes(can.recepcion_estado)) {
      throw createError(409, "Esa canastilla ya se cerró. Reabrila para recontar en ella.");
    }
  }
  const visibles = new Map(
    (despacho.traslados_items || []).filter((it) => !ocultoParaAuditor(it)).map((it) => [it.id, it]),
  );
  const renglones = itemIds.map((id) => visibles.get(id)).filter(Boolean);
  const filas = await ConteoModel.recontar(
    despachoId,
    auditorId,
    dispositivo,
    renglones,
    contenedorId,
    { todas },
  );
  await DespachoModel.marcarAuditoriaAbierta(despachoId).catch(() => {});
  return filas;
}
