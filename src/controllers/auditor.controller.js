import * as DespachoService from "../services/despacho.service.js";
import * as DespachoModel from "../models/Despacho.model.js";
import * as DespachadorModel from "../models/Despachador.model.js";
import * as RecepcionService from "../services/recepcion.service.js";
import * as RecepcionContenedores from "../services/recepcionContenedores.service.js";
import * as ContenedorModel from "../models/Contenedor.model.js";

/**
 * GET /api/auditor/despachos
 * Listar despachos pendientes de auditoría (estado Recolectado).
 * No expone cantidades del despachador (auditoría ciega).
 */
export async function listarPendientes(req, res, next) {
  try {
    // La sede se resuelve ACÁ desde el correo, no se acepta del cliente: el panel
    // dice quién es y el servidor decide qué puede ver. Sin sede cargada se ve
    // todo, igual que antes de la 025.
    const sede = await DespachadorModel.sedeDe(req.query.correo);
    const data = await DespachoModel.findForAuditor({ sede });
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/auditor/despachos/:id
 * Obtener detalle de un despacho para auditoría (sin cantidades del despachador).
 */
export async function obtenerDetalle(req, res, next) {
  try {
    const despacho = await DespachoService.obtener(req.params.id);

    if (!despacho) return res.status(404).json({ error: "Despacho no encontrado" });

    // Señal de actividad para el barrido de alertas: desde acá hay un auditor
    // trabajando en este traslado, aunque el conteo viva en el navegador y no
    // vuelva al backend hasta el primer Comparar. Sin esta marca, el barrido lo ve
    // igual que a uno abandonado y la regla de inactivación lo congela a mitad de
    // conteo — el auditor se come un 409 al firmar.
    //
    // Sí, es una escritura dentro de un GET. Se acepta a conciencia: es un
    // timestamp, no un cambio de estado, y es la ÚNICA vez que el auditor toca el
    // backend antes de firmar. La pureza REST no vale que quede una persona
    // trabada en el piso con el conteo hecho.
    //
    // Best-effort: si falla, se loguea y la lectura sigue. El auditor tiene que
    // poder ponerse a contar aunque la marca no se haya podido escribir.
    //
    // EL `await` NO ES OPCIONAL, aunque no usemos el resultado. Esto corre en
    // Vercel: cuando el handler responde, la instancia se puede congelar, y una
    // promesa que quedó volando no tiene ninguna garantía de completarse. La
    // escritura es un viaje de red (50-200 ms) y el resto del handler es
    // síncrono, así que sin `await` la respuesta sale primero y la marca se
    // pierde SEGUIDO — el barrido vuelve a ver el traslado como abandonado y
    // reaparece justo el bug que esto arregla.
    //
    // Y falla del peor modo: en local el proceso sigue vivo y la escritura
    // siempre termina, así que anda perfecto; en Vercel falla de a ratos y sin
    // patrón. Se valida OK y aparece en el piso a la semana.
    await DespachoModel.marcarAuditoriaAbierta(req.params.id).catch(() => {});

    // Auditoría ciega: ocultar cantidad_despachador y firma del despachador
    const { traslados_firmas, traslados_items, ...cabecera } = despacho;

    // Canastillas (038): al auditor le llegan los NÚMEROS, nunca el contenido.
    // Y por producto, solo si viaja (también) suelto: es lo que arma la lista de
    // "Sin canastilla". No revela cantidades ni en qué canastilla va cada cosa.
    const canastillas = await ContenedorModel.listarPorDespacho(req.params.id).catch(() => []);
    const enCanastillas = new Map();
    for (const c of canastillas) {
      for (const f of c.items) {
        enCanastillas.set(f.item_id, (enCanastillas.get(f.item_id) || 0) + (Number(f.cantidad) || 0));
      }
    }
    const viajaSuelto = (it) => {
      if (!canastillas.length) return true;
      const s =
        it.cantidad_suelta != null
          ? Number(it.cantidad_suelta)
          : (Number(it.cantidad_despachador) || 0) - (enCanastillas.get(it.id) || 0);
      return s > 0;
    };

    // Los no enviados y los EXCLUIDOS a mano (siesa_omitido) se omiten ENTEROS.
    // Esto no rompe la ceguera: el auditor nunca supo que existían, así que no
    // puede deducir nada de su ausencia (no tiene la lista original del admin).
    // MISMA regla que usa compararAuditoria — ver DespachoService.ocultoParaAuditor.
    const itemsCiegos = (traslados_items || [])
      .filter((it) => !DespachoService.ocultoParaAuditor(it))
      .map((item) => ({
        id: item.id,
        codigo_item: item.codigo_item,
        descripcion: item.descripcion,
        unidad_medida: item.unidad_medida,
        // factor: necesario para convertir a UND cuando el auditor cuenta en la
        // unidad (pack) del ítem, ej: 9 P3 × factor 3 = 27 UND. Es un atributo
        // del producto, NO revela cuánto despachó nadie: no rompe la ceguera.
        factor: item.factor,
        cantidad_admin: item.cantidad_admin,
        // grupo: la familia del producto (ACEITES, GRANOS…). Sin esto el auditor
        // recibía los ítems ORDENADOS por grupo pero sin el campo, así que su
        // lista no podía ni agrupar ni filtrar: el orden se leía como alfabético.
        // `categoria` es el campo legacy y hoy viene casi siempre en null — se
        // mantiene por los despachos viejos que solo tienen ese.
        //
        // No rompe la auditoría ciega, por el mismo motivo que `factor`: dice QUÉ
        // es el producto, nunca cuánto se pidió ni cuánto despachó nadie.
        grupo: item.grupo,
        categoria: item.categoria,
        no_recibido: item.no_recibido || false,
        en_suelto: viajaSuelto(item),
        // NOTA: cantidad_despachador y diferencia se ocultan intencionalmente
      }));

    // Lo que ya contaron los auditores (036), para retomar en cualquier celular.
    // No rompe la ceguera: son conteos de la recepción, no del despacho.
    // Best-effort: sin esto el panel arranca de su borrador local, como antes.
    const conteos = await RecepcionService.obtenerConteos(req.params.id).catch((e) => {
      console.error("[auditoría] no se pudo leer el conteo guardado:", e.message);
      return null;
    });

    res.json({
      ok: true,
      data: {
        ...cabecera,
        traslados_items: itemsCiegos,
        // null = no se pudo leer (el panel no debe tomarlo como "no hay nada").
        recepcion_conteos: conteos,
        canastillas: canastillas.map(RecepcionContenedores.vistaCiega),
        // Sin firmas del despachador
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/auditor/despachos/:id/comparar
 * Paso 1: dice SI cuadra y, si no, QUÉ hay que recontar. No firma, no cambia estado.
 *
 * Body: { items: [{ id, cantidad_auditor }] }
 * Resp: { ok, data: { match, recontar: [{ id, codigo_item, descripcion }] } }
 *
 * Devuelve la lista a recontar SIN cantidades ni diferencias, a propósito. Si
 * mandáramos los números y solo los escondiéramos en la UI, cualquiera los ve
 * abriendo la pestaña de red del navegador: ocultarlos en el front sería teatro.
 * La auditoría ciega se sostiene en el backend o no se sostiene.
 */
export async function comparar(req, res, next) {
  try {
    const { match, differences } = await DespachoService.compararAuditoria(
      req.params.id,
      req.body.items,
    );

    const recontar = differences
      .filter((d) => Number(d.diferencia) !== 0)
      .map((d) => ({
        id: d.id,
        codigo_item: d.codigo_item,
        descripcion: d.descripcion,
        no_recibido: d.no_recibido || false,
      }));

    res.json({ ok: true, data: { match, recontar } });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/auditor/despachos/:id/conteos
 * Las filas de conteo de todos los auditores (para ver lo del compañero).
 */
export async function listarConteos(req, res, next) {
  try {
    const data = await RecepcionService.obtenerConteos(req.params.id);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/auditor/despachos/:id/conteos
 * Guarda el conteo de un auditor, escaneo por escaneo (036).
 * Body: { auditor_id, dispositivo?, conteos: [{ item_id? | codigo_item, cantidad, no_recibido?,
 *         quitar_no_recibido?, descripcion?, unidad_medida? }] }
 * Resp: { ok, data: { guardados, fuera: [{ item_id, error }] } }
 */
export async function guardarConteos(req, res, next) {
  try {
    const { auditor_id, conteos, dispositivo } = req.body;
    const data = await RecepcionService.registrarConteos(
      req.params.id,
      auditor_id,
      conteos,
      dispositivo,
    );
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/auditor/despachos/:id/recontar
 * El número de quien recuenta pasa a ser el único que vale (ver ConteoModel.recontar).
 * Body: { auditor_id, dispositivo?, item_ids: [uuid] }
 * Resp: { ok, data: [filas de conteo del despacho] }
 */
export async function recontar(req, res, next) {
  try {
    const { auditor_id, item_ids, dispositivo, contenedor_id, todas } = req.body;
    const data = await RecepcionService.recontar(req.params.id, auditor_id, item_ids, dispositivo, {
      contenedorId: contenedor_id || null,
      todas: Boolean(todas),
    });
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/* ── Canastillas (038) — ver recepcionContenedores.service ── */

/** GET /api/auditor/despachos/:id/canastillas — números y estado, nunca contenido. */
export async function listarCanastillas(req, res, next) {
  try {
    res.json({ ok: true, data: await RecepcionContenedores.listarParaAuditor(req.params.id) });
  } catch (error) {
    next(error);
  }
}

/** POST /api/auditor/despachos/:id/canastillas/:cid/entrar  Body: { auditor_id, tomar? } */
export async function entrarCanastilla(req, res, next) {
  try {
    const data = await RecepcionContenedores.entrar(req.params.id, req.params.cid, req.body.auditor_id, {
      tomar: Boolean(req.body.tomar),
    });
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/auditor/despachos/:id/canastillas/:cid/cerrar  Body: { auditor_id, forzar? }
 * Resp: { ok, data: { cerrado, match, recontar:[{id,codigo_item,descripcion,tipo}], faltantes, confirmadas, sobrantes } }
 */
export async function cerrarCanastilla(req, res, next) {
  try {
    const data = await RecepcionContenedores.cerrar(req.params.id, req.params.cid, req.body.auditor_id, {
      forzar: Boolean(req.body.forzar),
    });
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/** POST /api/auditor/despachos/:id/canastillas/:cid/reabrir */
export async function reabrirCanastilla(req, res, next) {
  try {
    const data = await RecepcionContenedores.reabrir(req.params.id, req.params.cid, req.body.auditor_id);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/** POST /api/auditor/despachos/:id/canastillas/:cid/no-recibida */
export async function canastillaNoRecibida(req, res, next) {
  try {
    const data = await RecepcionContenedores.noRecibida(req.params.id, req.params.cid, req.body.auditor_id);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/** POST /api/auditor/despachos/:id/canastillas/no-listada  Body: { auditor_id, numero } */
export async function canastillaNoListada(req, res, next) {
  try {
    const data = await RecepcionContenedores.registrarNoListada(
      req.params.id,
      req.body.numero,
      req.body.auditor_id,
    );
    res.status(201).json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/auditor/despachos/:id/confirmar
 * Paso 2: decisión + firma, finaliza el despacho.
 * Body: { decision, auditor_id?, firma_data, items: [{ id, cantidad_auditor }] }
 * Resp: { ok, data: { estado } }
 */
export async function confirmar(req, res, next) {
  try {
    const { decision, auditor_id, firma_data, items } = req.body;
    const resultado = await DespachoService.confirmarAuditoria(req.params.id, {
      decision,
      auditorId: auditor_id,
      firmaData: firma_data,
      items,
    });
    res.json({ ok: true, data: resultado });
  } catch (error) {
    next(error);
  }
}
