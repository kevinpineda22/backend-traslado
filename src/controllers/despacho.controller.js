import * as DespachoService from "../services/despacho.service.js";

/**
 * GET /api/despachos
 * Listar despachos. Query params opcionales:
 *   estado, despachador_id, sin_asignar, resumen=true (incluye agregación de items)
 */
/**
 * GET /api/despachos/estadisticas/motivos
 * Agregación de motivos de faltante para el dashboard.
 */
export async function estadisticasMotivos(_req, res, next) {
  try {
    const data = await DespachoService.estadisticasMotivos();
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/despachos/analitica?dias=30
 * Agregación completa para el Dashboard. Todo se calcula en el servidor: lo que
 * vale para decidir vive a nivel de renglón, y traer esas filas al navegador para
 * sumarlas ahí deja de funcionar apenas el módulo entre en régimen.
 */
export async function analiticaCtrl(req, res, next) {
  try {
    const dias = Number(req.query.dias);
    const data = await DespachoService.analitica({
      dias: Number.isFinite(dias) && dias > 0 ? dias : undefined,
    });
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/despachos/activos/items
 * Ítems que están en despachos activos (no finalizados), para avisar de
 * traslados en curso del mismo ítem+origen.
 */
export async function itemsActivos(_req, res, next) {
  try {
    const data = await DespachoService.itemsEnDespachosActivos();
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

export async function listar(req, res, next) {
  try {
    const { estado, despachador_id, sin_asignar, resumen, incluir_inactivos } = req.query;
    const filters = {
      estado,
      despachador_id,
      sin_asignar,
      // Los inactivos se ocultan por defecto (ver Despacho.model). El monitor del
      // admin puede pedirlos explícitamente para ver el panorama completo.
      incluir_inactivos: incluir_inactivos === "true",
    };

    if (resumen === "true") {
      const data = await DespachoService.listarConResumen(filters);
      return res.json({ ok: true, data });
    }

    const data = await DespachoService.listar(filters);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/despachos/:id
 * Obtener detalle completo de un despacho.
 */
export async function obtener(req, res, next) {
  try {
    const data = await DespachoService.obtener(req.params.id);
    if (!data) return res.status(404).json({ error: "Despacho no encontrado" });

    // Auditoría ciega: si viene ?auditor=true, ocultar cantidad_despachador
    if (req.query.auditor === "true" && data.traslados_items) {
      data.traslados_items = data.traslados_items.map((item) => {
        const { cantidad_despachador, ...rest } = item;
        return rest;
      });
    }

    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * DELETE /api/despachos/:id
 * Eliminar un despacho (borra items y firmas por cascade).
 */
export async function eliminar(req, res, next) {
  try {
    const data = await DespachoService.eliminar(req.params.id);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * PATCH /api/despachos/:id/despachador
 * Reasignar (o quitar) el despachador. Body: { despachador_id }
 */
export async function reasignarDespachador(req, res, next) {
  try {
    const data = await DespachoService.reasignarDespachador(
      req.params.id,
      req.body?.despachador_id ?? null,
    );
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * PUT /api/despachos/:id/items
 * Editar los ítems de un despacho (solo Creado). Body: { items: [{ id, cantidad }] }
 */
export async function editarItems(req, res, next) {
  try {
    const items = req.body?.items;
    if (!Array.isArray(items)) {
      return res.status(400).json({ error: "Se esperaba un arreglo de items" });
    }
    const data = await DespachoService.editarItems(req.params.id, items);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/despachos
 * Crear un nuevo despacho.
 * Body: { destino, despachador_id, admin_id, criterios, items[] }
 */
export async function crear(req, res, next) {
  try {
    const data = await DespachoService.crear(req.body);
    res.status(201).json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/* =============================================
   BORRADOR — listado semanal del flujo General
   ============================================= */

/**
 * POST /api/despachos/listado
 * Abre el listado de la ruta o le agrega ítems si ya existe.
 * Body: igual que crear un despacho — { origen, destino, flujo, items[] }
 * Resp: { ok, data: { despacho, agregados, actualizados, creado } }
 */
export async function agregarAlListado(req, res, next) {
  try {
    const data = await DespachoService.agregarAlListado(req.body);
    res.status(data.creado ? 201 : 200).json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/despachos/listado?origen=PV001&destino=00201
 * El listado abierto de esa ruta (con ítems), o null si no hay ninguno.
 * Sin `destino` devuelve TODOS los listados abiertos.
 */
export async function obtenerListado(req, res, next) {
  try {
    const { origen, destino } = req.query;
    if (!destino) {
      return res.json({ ok: true, data: await DespachoService.listarListados() });
    }
    if (!origen) {
      return res.status(400).json({ ok: false, error: "origen es requerido junto con destino" });
    }
    res.json({ ok: true, data: await DespachoService.obtenerListado(origen, destino) });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/despachos/listado/:id/finalizar
 * Cierra el listado: pasa a "Creado" y aparece en el panel del despachador.
 * Body: { despachador_id? }
 */
export async function finalizarListado(req, res, next) {
  try {
    const data = await DespachoService.finalizarListado(
      req.params.id,
      req.body?.despachador_id ?? null,
    );
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/despachos/listado/:id/reabrir
 * Devuelve un despacho "Creado" a "Borrador" para seguir agregándole productos.
 * Inverso de `finalizarListado`. Responde 409 si alguien ya empezó a recolectar o
 * si esa ruta ya tiene otro listado sin enviar.
 */
export async function reabrirListado(req, res, next) {
  try {
    const data = await DespachoService.reabrirListado(req.params.id);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * DELETE /api/despachos/listado/:id
 * Descarta el listado entero sin despacharlo.
 */
export async function descartarListado(req, res, next) {
  try {
    const data = await DespachoService.descartarListado(req.params.id);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * PATCH /api/despachos/:id/estado
 * Avanzar el estado de un despacho.
 * Body: { estado, firma_data? }
 */
export async function cambiarEstado(req, res, next) {
  try {
    const { estado, firma_data, despachador_id } = req.body;
    const data = await DespachoService.cambiarEstado(
      req.params.id,
      estado,
      firma_data,
      despachador_id ?? null,
    );
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/despachos/:id/cargar — CAMIÓN CARGADO
 *
 * Cierra la recolección con el manifiesto. Reemplaza al `PATCH /:id/estado` con
 * "Recolectado" para el despachador: ahora el cierre exige saber quién se lleva la
 * carga. Al pasar a `Recolectado` se disparan los correos, la auto-clasificación
 * del flujo llano y la subida a SIESA — o sea, cuando el camión sale de verdad.
 */
export async function cargarCamion(req, res, next) {
  try {
    // `manifiesto_pdf_base64` se saca del resto: NO es un campo del manifiesto (no
    // va a la tabla), es el PDF que el front generó para adjuntar al correo de
    // inventarios. Si quedara en `...manifiesto` se intentaría guardar como columna.
    const { firma_data, despachador_id, manifiesto_pdf_base64, ...manifiesto } = req.body;
    const data = await DespachoService.cargarCamion(req.params.id, manifiesto, {
      despachadorId: despachador_id ?? null,
      firmaData: firma_data,
      pdfBase64: manifiesto_pdf_base64,
    });
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/** GET /api/despachos/:id/manifiesto — para el panel del admin y el del auditor. */
export async function obtenerManifiesto(req, res, next) {
  try {
    const data = await DespachoService.obtenerManifiesto(req.params.id);
    if (!data) return res.status(404).json({ ok: false, error: "Sin manifiesto" });
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/despachos/:id/iniciar
 * Iniciar recolección reclamando el despacho (modelo pool).
 * Si el despacho se creó sin despachador asignado, se asigna acá atómicamente.
 * Body: { despachador_id } (opcional si ya estaba pre-asignado)
 * 409 si otro despachador ya lo tomó.
 */
export async function iniciarRecoleccion(req, res, next) {
  try {
    const { despachador_id } = req.body;
    const data = await DespachoService.iniciarRecoleccion(
      req.params.id,
      despachador_id,
    );
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/despachos/:id/abandonar
 * El despachador dueño suelta la recolección: el despacho vuelve al pool (Creado,
 * sin dueño) y se resetean las cantidades. Body: { despachador_id }
 * 403 si no es el dueño, 409 si no está En_recoleccion.
 */
export async function abandonar(req, res, next) {
  try {
    const { despachador_id } = req.body;
    const data = await DespachoService.abandonarRecoleccion(
      req.params.id,
      despachador_id ?? null,
    );
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/despachos/:id/recolectar
 * Registrar la recolección de un item por el despachador.
 * Body: { items: [{ id, cantidad, agotado? }], despachador_id? }
 */
export async function recolectar(req, res, next) {
  try {
    const { items, despachador_id } = req.body;

    // Guarda del despacho: que exista, no esté inactivo y esté En_recoleccion.
    // Ya NO valida propiedad — el despacho es compartido (migración 023) y el
    // candado bajó al renglón. Va antes de escribir nada: si el despacho no admite
    // recolección, no tiene sentido intentar ítem por ítem.
    await DespachoService.assertPuedeRecolectar(req.params.id, despachador_id ?? null);

    const resultados = [];
    const conflictos = [];

    // UN RENGLÓN AJENO NO PUEDE TUMBAR EL LOTE.
    //
    // El front sincroniza de a tandas (ver useRecoleccionOffline). Si un solo ítem
    // choca con el candado de otra persona y se propaga la excepción, se pierden
    // las escrituras de TODOS los demás — y como el syncer reintenta el mismo lote,
    // vuelve a chocar en el mismo ítem para siempre: la tanda queda trabada y la
    // persona sigue contando sin que se guarde nada.
    //
    // Así que cada ítem va por su cuenta: los que entran, entran; los que chocan
    // se devuelven aparte para que el front los marque como ajenos y deje de
    // reintentarlos. Cualquier otro error (red, 422 de tope) sí se propaga: ese no
    // es un choque esperable y esconderlo sería el mismo error de siempre.
    for (const item of items) {
      try {
        const actualizado = await DespachoService.registrarRecoleccion(
          item.id,
          item.cantidad,
          item.agotado,
          item.motivo,
          item.nueva_unidad_medida,
          item.nueva_cantidad_admin,
          item.nuevo_factor,
          despachador_id ?? null,
        );
        resultados.push(actualizado);
      } catch (err) {
        if (err?.codigo !== "RENGLON_TOMADO") throw err;
        conflictos.push({ item_id: item.id, dueno: err.dueno, error: err.message });
      }
    }

    res.json({ ok: true, data: resultados, conflictos });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/despachos/:id/planilla
 * Generar planilla Excel del despacho.
 * Query param: tipo = "recoleccion" | "final"
 */
export async function planilla(req, res, next) {
  try {
    const tipo = req.query.tipo || "recoleccion";
    const buffer = await DespachoService.generarPlanilla(req.params.id, tipo);

    const filename = `despacho-${req.params.id.slice(0, 8)}-${tipo}.xlsx`;

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (error) {
    next(error);
  }
}
