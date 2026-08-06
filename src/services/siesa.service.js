import { calcularSugeridoGeneral, calcularSugeridoABC } from "./sugerido.service.js";
import { leerBodegas, leerBodegasItems } from "./snapshot.service.js";
import { mapaCapacidades, factoresDeItem } from "../models/Capacidad.model.js";
import { obtener as obtenerConfig } from "../models/Config.model.js";
import { supabase } from "../config/supabase.js";
import { SEDES, nombreSede, getFlujoPorDestino } from "../config/flujos.js";
import {
  unidadForzadaDe,
  unidadesSeleccionablesDe,
  FACTOR_UNIDAD,
} from "../config/unidadesForzadas.js";

/* =============================================
   Servicio SIESA (lectura)

   Lee del snapshot en Supabase (poblado por el cron → snapshot.service.js) y
   pivotea por par origen/destino. Nunca toca Connekta en un request de usuario.
   ============================================= */

const num = (v) => Number(v) || 0;
const trim = (v) => String(v ?? "").trim();

/**
 * Volumen de UNA UNIDAD BASE del ítem.
 *
 * POR QUÉ HAY QUE NORMALIZAR ACÁ
 * `snapshot.volumen` viene de `t122_mc_items_unidades.f122_volumen`, de la fila de
 * la UNIDAD DE ORDEN — la misma de la que sale `f122_factor`. O sea: es el volumen
 * de un PAQUETE de `factor` unidades base, no el de una unidad suelta.
 *
 * Pero el panel deja elegir la unidad del renglón, y la que queda por defecto es la
 * BASE (`buildUnidades` la pone primera, con factor 1). Entonces la cantidad del
 * carrito casi siempre está en unidades base, no en paquetes. Multiplicar el volumen
 * del paquete por una cantidad en unidades base infla el total por el `factor`: un
 * ítem en P48 pediría 48 veces el espacio real.
 *
 * Normalizando acá —donde SÍ conocemos el factor de orden del snapshot— el frontend
 * puede usar una sola fórmula que vale para cualquier unidad elegida:
 *
 *     volumen_total = volumen_base × cantidad × factor_de_la_unidad_elegida
 *
 * LO IMPORTANTE NO ES CUÁL SEA LA UNIDAD POR DEFECTO, SINO QUE NO IMPORTE.
 * Al normalizar a base, la cuenta queda AGNÓSTICA a qué unidad se elija: si el ítem
 * se despacha en la unidad de orden (factor N), N × volumen_base reconstruye el
 * paquete; si va en unidades sueltas (factor 1), da el volumen de una. Eso vale
 * también para las ramas de `buildUnidades` donde la primera unidad NO es la base
 * (`umExtra` de Capacidad·Llano, `unidadForzadaDe`). Si mañana cambia cuál queda
 * seleccionada por defecto, esta función sigue dando bien — no la "simplifiques"
 * apoyándote en la unidad por defecto.
 *
 * VERIFICADO contra datos del snapshot: `f122_volumen` es el volumen del PAQUETE de
 * la unidad de orden. AZUCAR X 500 GR con factor 100 trae 50.000 = 100 × 500, el
 * contenido exacto del paquete; ÷100 da 500 por bolsa. Si viniera por unidad base,
 * una bolsa de azúcar de medio kilo ocuparía 50 litros.
 */
function volumenBase(row) {
  if (row?.volumen == null || row.volumen === "") return null;
  const v = num(row.volumen);

  // Un 0 de SIESA NO es "ocupa cero": es "no se lo cargaron al maestro". Ningún
  // producto físico ocupa cero, y de hecho los ceros son toda la categoría de
  // frescos — pollo, huevos, fruta, justo lo que llena un camión.
  //
  // Y hay un dato que lo vuelve obligatorio: en 65.000 filas del snapshot NO hay un
  // solo NULL. SIESA nunca manda vacío; cuando no tiene el dato manda 0. Si el 0
  // pasara como número bueno, el contador de "sin dato" del panel jamás se
  // encendería y un despacho de frescos mostraría total 0 con el cartel de datos
  // completos. Un total que miente y se ve completo es peor que no tener el total.
  if (!(v > 0)) return null;

  const factorOrden = num(row.factor) || 1;
  return factorOrden > 0 ? v / factorOrden : v;
}

const PLANES = [
  { id: "001", label: "Grupo" },
  { id: "002", label: "Subgrupo" },
  { id: "003", label: "Proveedor" },
  { id: "004", label: "Marca" },
  { id: "005", label: "Rotación" },
  { id: "007", label: "Negociaciones Puntuales" }, // antes: Temporada
  // "MUA" (U. Medida) se quitó de los filtros: no se usa en la operación y solo
  // ocupaba lugar en la barra de criterios. El dato SIGUE guardándose en el
  // snapshot (criterios.MUA), así que volver a mostrarlo es agregar la línea.
  { id: "TLD", label: "Traslados" }, // antes: Tipo Producto
  { id: "SP", label: "Separata" }, // antes: Segmento
  { id: "TIP", label: "Tipo" }, // DescMayorTIP (ej: "ABARROTES")
];

/* ─── Criterios (para los filtros facetados) ───────────────────────── */

/**
 * Extrae los criterios disponibles desde el catálogo del origen.
 * @param {string} origen - Bodega origen (default: origen del flujo general)
 */
export async function getCriterios(origen = "PV001") {
  try {
    const rows = await leerBodegas([origen]);

    const criterios = PLANES.map((p) => {
      const valores = new Set();
      for (const r of rows) {
        const v = trim(r.criterios?.[p.id]);
        if (v) valores.add(v);
      }
      return {
        id: p.id,
        descripcion: p.label,
        opciones: Array.from(valores).sort((a, b) => a.localeCompare(b, "es")),
        cantidad: valores.size,
      };
    });

    return { data: criterios };
  } catch (error) {
    return { error: error.message };
  }
}

/* ─── Productos pivoteados origen/destino ──────────────────────────── */

/**
 * Productos del ORIGEN cruzados con el DESTINO + sugerido (stock de seguridad).
 * @param {object} opts
 * @param {string} opts.origen  - Bodega origen
 * @param {string} opts.destino - Bodega destino
 */
export async function getProductosTraslado({ origen, destino }) {
  try {
    const [rows, capacidades, config] = await Promise.all([
      leerBodegas([origen, destino]),
      // Las UM cargadas en Capacidad·Llano se usan TAMBIÉN acá para partir el ítem
      // en una fila por unidad. Lo que NO cruza es la `capacidad` en sí: ese número
      // alimenta el sugerido A/B/C y es exclusivo de Llano — General calcula por
      // stock de seguridad. De esa tabla solo se toman `unidad` y `factor`.
      mapaCapacidades(),
      obtenerConfig(),
    ]);
    // Override global del período de cubrimiento (si se configuró en el admin);
    // si es null, se usa el PeriodoCubrimiento que trae cada ítem de SIESA.
    const periodoOverride = config.general.periodoCubrimiento;

    const oMap = new Map();
    const dMap = new Map();
    for (const r of rows) {
      if (r.bodega === origen) oMap.set(String(r.codigo_item), r);
      else if (r.bodega === destino) dMap.set(String(r.codigo_item), r);
    }

    const productos = [];
    // Recorremos la UNIÓN origen ∪ destino: así también aparecen los ítems que
    // el destino necesita aunque el origen principal no tenga stock (para poder
    // mandarlos desde otra sede). Los ítems solo-destino se incluyen si necesidad > 0.
    const codigos = new Set([...oMap.keys(), ...dMap.keys()]);
    for (const codigo of codigos) {
      const o = oMap.get(codigo);
      const d = dMap.get(codigo);
      const fuente = o || d; // descripción/UM/criterios: preferimos el origen

      // "Inventario" = CantidadDisponible (existencia − comprometida): lo realmente
      // disponible para trasladar / para cubrir la demanda, NO la existencia total.
      // Ojo: CantidadDisponible puede venir NEGATIVA (cuando cant_pos_1 > existencia).
      // Un inventario negativo inflaría el sugerido (objetivo − (−x) = objetivo + x),
      // así que lo acotamos a 0: no puede haber "menos que nada" de stock.
      const inventarioOrigen = o ? Math.max(0, num(o.disponible)) : 0;
      const disponibleOrigen = o ? Math.max(0, num(o.disponible)) : 0;
      const inventarioDestino = d ? Math.max(0, num(d.disponible)) : 0;
      const consumoDestino = d ? num(d.consumo_promedio) : 0;
      const periodoCubrimiento =
        periodoOverride != null
          ? periodoOverride
          : d
            ? num(d.periodo_cubrimiento)
            : num(fuente.periodo_cubrimiento);

      const { stockSeguridad, necesidad } = calcularSugeridoGeneral({
        consumoDestino,
        periodoCubrimiento,
        inventarioDestino,
        disponibleOrigen,
      });
      // El sugerido es el MÁXIMO que se debería mandar (la necesidad), sin topear
      // por el origen. El faltante es lo que el origen no puede cubrir.
      const sugerido = necesidad;
      const faltante = Math.max(0, necesidad - Math.max(0, Math.floor(disponibleOrigen)));

      // Días de inventario del destino = inventario (disponible) / consumo.
      // Refleja el sobre-stock real. Consumo 0 → sin rotación (null).
      const diasInventario = consumoDestino > 0 ? inventarioDestino / consumoDestino : null;

      // Ítem que no está en el origen: solo tiene sentido si el destino lo necesita.
      if (!o && necesidad <= 0) continue;

      // Variantes a emitir — mismo criterio que Llano: si el ítem tiene UM
      // asignadas en Capacidad, va UNA FILA POR UM; si no, la fila base.
      //
      // OJO CON LA DIFERENCIA RESPECTO DE LLANO: allá cada UM trae su propia
      // capacidad, así que cada fila tiene un sugerido DISTINTO. Acá el sugerido
      // sale del stock de seguridad, que es el mismo para el ítem sin importar el
      // empaque: las filas muestran LA MISMA necesidad expresada en otra unidad
      // (60 UND = 10 P6). Son dos formas de mandar lo mismo, no dos pedidos.
      const capRows = capacidades.get(codigo) || [];
      const umRows = capRows.filter((r) => r.unidad && r.factor);
      const variantes =
        umRows.length > 0
          ? umRows.map((r) => ({ unidad: r.unidad, factor: r.factor }))
          : [{ unidad: null, factor: 1 }];

      for (const v of variantes) {
        // Con UM asignada la fila va fija en esa unidad (sin selector), igual que
        // en Llano. Si no, se ofrecen las de SIESA (base + unidad de orden).
        const unidadesDetalle = v.unidad
          ? [{ unidad: v.unidad, factor: v.factor }]
          : buildUnidades(fuente);

        productos.push({
          codigo_item: codigo,
          // Identidad de la fila cuando el ítem se parte por UM. Sin esto, dos
          // filas del mismo ítem compartirían clave en el carrito y se pisarían.
          rowKey: v.unidad ? `${codigo}|${v.unidad}` : codigo,
          // ¿Se puede pedir en varias UM a la vez sin que el panel avise? Es
          // propiedad del ÍTEM, así que se lee con OR sobre sus filas (026).
          multi_um: capRows.some((r) => r.multi_um),
          descripcion: trim(fuente.descripcion),
          rotacion: trim(fuente.rotacion) || "N/A",
          unidad_medida: v.unidad || trim(fuente.um),
          unidades: unidadesDetalle.map((u) => u.unidad),
          unidadesDetalle,
          // Volumen de UNA UNIDAD BASE (ya normalizado — ver volumenBase). `null`
          // cuando SIESA no lo tiene, para que el panel distinga "sin dato" de
          // "ocupa cero".
          volumen: volumenBase(fuente),
          criterios: fuente.criterios || {},
          inventario_origen: inventarioOrigen,
          disponible_origen: disponibleOrigen,
          inventario_destino: inventarioDestino,
          consumo_destino: consumoDestino,
          periodo_cubrimiento: periodoCubrimiento,
          stock_seguridad: stockSeguridad,
          dias_inventario: diasInventario,
          necesidad,
          faltante,
          sugerido,
        });
      }
    }

    return { data: productos };
  } catch (error) {
    return { error: error.message };
  }
}

/* ─── Flujo Llano — clasificación A/B/C con Excel ──────────────────── */

/**
 * Deriva la clase A/B/C del ítem desde el criterio CAT ("CLASIFICACIÓN ABC LLANO").
 * DescMayorCAT tiene la forma "CATEGORIA TIPO A" → clase "A". Sin match → "ninguno".
 */
function claseDeCategoria(cat) {
  const m = String(cat ?? "").toUpperCase().match(/TIPO\s+([ABC])/);
  return m ? m[1] : "ninguno";
}

/**
 * Productos del flujo Llano — facetado (todos los ítems del origen, como
 * General) con sugerido A/B/C. La clase sale del criterio CAT del DESTINO
 * (Girardota Llano, 00401) y la capacidad de la tabla `traslados_capacidad`.
 * Ítems sin capacidad cargada → capacidad 0 → sugerido 0.
 *
 * Las cadencias A/B/C salen de la config editable (tabla traslados_config);
 * el parámetro `cadencias` las pisa si se pasa explícito.
 *
 * @param {object} opts
 * @param {string} opts.origen   - Bodega origen (00301)
 * @param {string} opts.destino  - Bodega destino (00401)
 * @param {object} [opts.cadencias] - { A, B, C } días (override opcional)
 */
export async function getProductosLlano({ origen, destino, cadencias }) {
  try {
    const [rows, capacidades, config] = await Promise.all([
      leerBodegas([origen, destino]),
      mapaCapacidades(),
      obtenerConfig(),
    ]);
    const cadenciasEfectivas = cadencias || config.llano;

    const oMap = new Map();
    const dMap = new Map();
    for (const r of rows) {
      if (r.bodega === origen) oMap.set(String(r.codigo_item), r);
      else if (r.bodega === destino) dMap.set(String(r.codigo_item), r);
    }

    const productos = [];
    // Unión origen ∪ destino: también aparecen los ítems que Llano necesita
    // aunque el origen (Girardota Parque) no tenga stock, para mandarlos desde
    // otra sede. Los ítems solo-destino se incluyen si necesidad > 0.
    const codigos = new Set([...oMap.keys(), ...dMap.keys()]);
    for (const codigo of codigos) {
      const o = oMap.get(codigo);
      const d = dMap.get(codigo);
      const fuente = o || d;

      // La clase A/B/C debe ser la de Girardota Llano (destino, 00401), no la
      // del origen (Girardota Parque). Por eso se lee el CAT del registro `d`.
      const clase = claseDeCategoria(d?.criterios?.CAT);
      // Solo Llano: mostramos únicamente ítems clasificados en el CAT (A/B/C o
      // "SIN CLASIFICACION" = Ninguno). Los que no tienen NINGUNA clasificación
      // (CAT vacío) no son de Llano → quedan fuera. El CAT es a nivel de ítem,
      // así que da igual leerlo del destino o del origen.
      const catLlano = trim(d?.criterios?.CAT || o?.criterios?.CAT);
      if (!catLlano) continue;
      // "Inventario" = CantidadDisponible (existencia − comprometida): lo realmente
      // disponible para trasladar / para cubrir la demanda, NO la existencia total.
      // Ojo: CantidadDisponible puede venir NEGATIVA (cuando cant_pos_1 > existencia).
      // Un inventario negativo inflaría el sugerido (objetivo − (−x) = objetivo + x),
      // así que lo acotamos a 0: no puede haber "menos que nada" de stock.
      const inventarioOrigen = o ? Math.max(0, num(o.disponible)) : 0;
      const disponibleOrigen = o ? Math.max(0, num(o.disponible)) : 0;
      const inventarioDestino = d ? Math.max(0, num(d.disponible)) : 0;
      const consumoDestino = d ? num(d.consumo_promedio) : 0;

      // Variantes a emitir: si el ítem tiene UM asignadas → una fila POR UM
      // (capacidad en esa UM). Si no → la fila base (capacidad en unidades).
      const capRows = capacidades.get(codigo) || [];
      const umRows = capRows.filter((r) => r.unidad && r.factor);
      const baseRow = capRows.find((r) => !r.unidad);
      const variantes =
        umRows.length > 0
          ? umRows.map((r) => ({ unidad: r.unidad, factor: r.factor, capacidadUM: r.capacidad }))
          : [{ unidad: null, factor: 1, capacidadUM: baseRow?.capacidad || 0 }];

      for (const v of variantes) {
        const capacidadBase = v.capacidadUM * (v.factor || 1); // capacidad en base
        // Días que CUBRE LA CAPACIDAD al ritmo de consumo (se muestra junto a la
        // capacidad, para saber cuántos días de venta cubre la meta). Consumo 0 → null.
        const diasCapacidad = consumoDestino > 0 ? capacidadBase / consumoDestino : null;
        // Días de INVENTARIO del destino = stock actual del destino / consumo. Va en la
        // columna "Días inv." y es al que se le aplica el filtro de exclusión.
        const diasInventario = consumoDestino > 0 ? inventarioDestino / consumoDestino : null;
        // `necesidad` = sugerido = máximo a mandar (SIN topear por el origen).
        const necesidad = calcularSugeridoABC({
          clase,
          capacidad: capacidadBase,
          consumoDiario: consumoDestino,
          inventario: inventarioDestino,
          cadencias: cadenciasEfectivas,
        });
        const sugerido = necesidad;
        const faltante = Math.max(0, necesidad - Math.max(0, Math.floor(disponibleOrigen)));

        // Ítem que no está en el origen: solo tiene sentido si Llano lo necesita.
        if (!o && necesidad <= 0) continue;

        // Con UM asignada, la fila va fija en esa UM (sin selector). Si no, la base.
        // `unidadesDetalle` trae objetos {unidad, factor}; `unidades` es solo strings
        // para que el front viejo siga funcionando sin pantallazo blanco (error #31).
        const unidadesDetalle = v.unidad
          ? [{ unidad: v.unidad, factor: v.factor }]
          : buildUnidades(fuente);

        productos.push({
          codigo_item: codigo,
          rowKey: v.unidad ? `${codigo}|${v.unidad}` : codigo, // identidad única de la fila
          // ¿Se puede pedir en varias UM a la vez sin que el panel avise? Es
          // propiedad del ÍTEM, así que se lee con OR sobre sus filas (026).
          multi_um: capRows.some((r) => r.multi_um),
          descripcion: trim(fuente.descripcion),
          clase,
          capacidad: v.capacidadUM,
          dias_capacidad: diasCapacidad,
          rotacion: trim(fuente.rotacion) || "N/A",
          unidad_medida: v.unidad || trim(fuente.um),
          unidades: unidadesDetalle.map((u) => u.unidad),
          unidadesDetalle,
          // Volumen de UNA UNIDAD BASE (ver volumenBase).
          volumen: volumenBase(fuente),
          criterios: fuente.criterios || {},
          inventario_origen: inventarioOrigen,
          disponible_origen: disponibleOrigen,
          inventario_destino: inventarioDestino,
          consumo_destino: consumoDestino,
          dias_inventario: diasInventario,
          necesidad,
          faltante,
          sugerido,
        });
      }
    }

    return { data: productos };
  } catch (error) {
    return { error: error.message };
  }
}

/**
 * Disponibilidad de UN ítem en TODAS las sedes — para elegir un origen
 * alternativo cuando el origen principal no cubre. Devuelve, por cada sede con
 * stock (menos el destino), su disponible y el sugerido si el traslado saliera
 * de ahí (misma lógica del flujo: A/B/C en Llano, stock de seguridad en General).
 *
 * @param {object} opts
 * @param {string} opts.codigo  - Código del ítem
 * @param {string} opts.destino - Bodega destino
 */
export async function getDisponibilidadItem({ codigo, destino }) {
  try {
    const flujo = getFlujoPorDestino(destino);
    if (!flujo) return { error: `El destino ${destino} no pertenece a ningún flujo` };

    const bodegas = Object.keys(SEDES);
    const [rows, capacidades, config] = await Promise.all([
      leerBodegasItems(bodegas, [codigo]),
      mapaCapacidades(),
      obtenerConfig(),
    ]);

    const porBodega = new Map();
    for (const r of rows) porBodega.set(trim(r.bodega), r);

    const d = porBodega.get(trim(destino));
    // Disponible acotado a 0 (puede venir negativo) — igual que en las tablas.
    const inventarioDestino = d ? Math.max(0, num(d.disponible)) : 0;
    const consumoDestino = d ? num(d.consumo_promedio) : 0;

    // Necesidad (sin tope de origen) según el flujo del destino.
    let necesidad;
    if (flujo.logica === "abc") {
      const clase = claseDeCategoria(d?.criterios?.CAT);
      const capRows = capacidades.get(String(codigo)) || [];
      const umRows = capRows.filter((r) => r.unidad && r.factor);
      const cr = umRows[0] || capRows.find((r) => !r.unidad) || null;
      const capacidad = (cr?.capacidad || 0) * (cr?.factor || 1); // en base
      necesidad = calcularSugeridoABC({
        clase,
        capacidad,
        consumoDiario: consumoDestino,
        inventario: inventarioDestino,
        cadencias: config.llano,
      });
    } else {
      const periodo =
        config.general.periodoCubrimiento != null
          ? config.general.periodoCubrimiento
          : d
            ? num(d.periodo_cubrimiento)
            : 0;
      necesidad = calcularSugeridoGeneral({
        consumoDestino,
        periodoCubrimiento: periodo,
        inventarioDestino,
        disponibleOrigen: Infinity,
      }).necesidad;
    }

    // Sedes candidatas: todas menos el destino, con disponible > 0.
    const sedes = [];
    for (const [bodega, r] of porBodega) {
      if (bodega === trim(destino)) continue;
      const disponible = Math.max(0, Math.floor(num(r.disponible)));
      if (disponible <= 0) continue;
      sedes.push({
        codigo: bodega,
        nombre: nombreSede(bodega),
        disponible,
        inventario: num(r.inventario),
        sugerido: Math.min(necesidad, disponible),
      });
    }
    sedes.sort((a, b) => b.disponible - a.disponible);

    return {
      data: {
        codigo_item: String(codigo),
        destino,
        flujo: flujo.id,
        necesidad,
        inventario_destino: inventarioDestino,
        sedes,
      },
    };
  } catch (error) {
    return { error: error.message };
  }
}

/**
 * Inventario de TODOS los ítems en TODAS las sedes a la vez (vista matriz).
 * Por ítem devuelve inventario y disponible por bodega. Pensado para el panel
 * "Inventario · Sedes": ver todo de un vistazo y armar traslados desde ahí.
 */
export async function getInventarioSedes() {
  try {
    const bodegas = Object.keys(SEDES);
    const rows = await leerBodegas(bodegas);

    const porItem = new Map();
    for (const r of rows) {
      const codigo = String(r.codigo_item);
      let it = porItem.get(codigo);
      if (!it) {
        it = {
          codigo_item: codigo,
          descripcion: trim(r.descripcion),
          rotacion: trim(r.rotacion) || "N/A",
          um: trim(r.um),
          um_orden: trim(r.um_orden),
          factor: num(r.factor) || 1,
          // Volumen por unidad base — el Columnario lo manda al armar el despacho.
          volumen: volumenBase(r),
          criterios: r.criterios || {},
          inv: {},
          disp: {},
        };
        porItem.set(codigo, it);
      }
      it.inv[trim(r.bodega)] = num(r.inventario);
      it.disp[trim(r.bodega)] = num(r.disponible);
    }

    const items = Array.from(porItem.values()).map((it) => ({
      codigo_item: it.codigo_item,
      descripcion: it.descripcion,
      rotacion: it.rotacion,
      unidad_medida: it.um,
      unidades: buildUnidades({
        codigo_item: it.codigo_item,
        um: it.um,
        um_orden: it.um_orden,
        factor: it.factor,
      }),
      volumen: it.volumen,
      criterios: it.criterios,
      inv: it.inv,
      disp: it.disp,
    }));

    return {
      data: {
        sedes: bodegas.map((c) => ({ codigo: c, nombre: nombreSede(c) })),
        items,
      },
    };
  } catch (error) {
    return { error: error.message };
  }
}

/**
 * Unidades disponibles para el switch de UM.
 * Con los datos actuales de SIESA hay una unidad base + la de orden (si difiere).
 *
 * Override: algunos ítems se piden ESTRICTAMENTE en una unidad fija (P6/P25).
 * Para esos, se devuelve SOLO esa unidad → el front no muestra selector.
 */
function buildUnidades(row, umExtra) {
  const base = trim(row.um);
  const orden = trim(row.um_orden);
  const factor = num(row.factor) || 1;

  const unidades = [{ unidad: base, factor: 1 }];
  if (orden && orden !== base && factor !== 1) {
    unidades.push({ unidad: orden, factor });
  }

  // UM asignada por ítem en Capacidad·Llano (tiene prioridad): se ofrece esa
  // unidad como default + la base como opción, para trasladar en esa UM.
  if (umExtra && umExtra.unidad && Number(umExtra.factor) > 0) {
    return [
      { unidad: String(umExtra.unidad).trim(), factor: Number(umExtra.factor) },
      { unidad: base || "UND", factor: 1 },
    ];
  }

  const forzada = unidadForzadaDe(row.codigo_item);
  if (forzada) {
    // Usa el factor real si SIESA ya trae esa unidad; si no, el configurado.
    const existente = unidades.find((u) => u.unidad === forzada);
    const f = existente ? existente.factor : FACTOR_UNIDAD[forzada] || 1;
    return [{ unidad: forzada, factor: f }];
  }

  // Set fijo de unidades seleccionables (ej. huevos: UND / P15 / P30).
  const seleccionables = unidadesSeleccionablesDe(row.codigo_item);
  if (seleccionables) return seleccionables;

  return unidades;
}

/* ─── Sedes y flujos ───────────────────────────────────────────────── */

/** Sedes destino disponibles (todas las de los flujos), desde config. */
export async function getSedes() {
  const sedes = Object.keys(SEDES)
    .map((codigo) => ({ id: codigo, descripcion: nombreSede(codigo) }))
    .sort((a, b) => a.descripcion.localeCompare(b.descripcion, "es"));
  return { data: sedes };
}

/**
 * Arma la respuesta de unidades de un ítem en DOS campos, a propósito:
 *
 *   unidades:        ["P15","P30"]                      ← contrato histórico
 *   unidadesDetalle: [{unidad:"P15",factor:15}, …]      ← el dato que faltaba
 *
 * POR QUÉ DOS CAMPOS Y NO UNO
 * `unidades` se devolvía como strings y el front los pintaba directo en el
 * <select>. Cambiarlo a objetos rompió el front YA DESPLEGADO con un error de
 * React ("Objects are not valid as a React child"): el navegador quedó en
 * pantalla blanca hasta que se subiera el bundle nuevo. Un cambio de contrato
 * que obliga a desplegar los dos repos en un orden exacto es una bomba de
 * tiempo — el día que uno de los dos despliegues falle, la app se cae.
 *
 * Manteniendo `unidades` intacto, CUALQUIER combinación de versiones funciona:
 * el front viejo sigue leyendo strings y el nuevo prefiere `unidadesDetalle`.
 *
 * Sin factor el front no puede convertir: si el pedido es en P30 y se cuenta en
 * P15, la única forma de saber que 210 UND son 14 P15 es conocer que P15 = 15.
 *
 * Prioridad del factor:
 *   1. Fila de `traslados_capacidad` del ítem (lo que configuró el admin).
 *   2. FACTOR_UNIDAD (tabla canónica de paquetes: P6=6, P15=15, P30=30…).
 *   3. `null` ⇒ factor desconocido. Se devuelve igual, en null, para que el
 *      front oculte esa UM en vez de inventar una conversión.
 */
async function conFactores(f120_id, umsCrudas) {
  let porCapacidad = new Map();
  try {
    porCapacidad = await factoresDeItem(f120_id);
  } catch (err) {
    // Sin capacidad configurada seguimos con FACTOR_UNIDAD: mejor una UM con
    // factor canónico que ninguna.
    console.warn("No se pudieron leer factores de capacidad:", err.message);
  }

  const unidades = umsCrudas.map(trim).filter(Boolean);
  return {
    unidades,
    unidadesDetalle: unidades.map((unidad) => ({
      unidad,
      factor: porCapacidad.get(unidad) ?? FACTOR_UNIDAD[unidad] ?? null,
    })),
  };
}

/**
 * Resuelve un código (que puede ser un código de barras EAN o un PLU base).
 * Consulta la tabla `siesa_codigos_barras` en Supabase.
 * Si lo encuentra, devuelve el `f120_id` asociado y su `unidad_medida`.
 * Si no, asume que es un código base (PLU) y lo retorna tal cual.
 *
 * Devuelve `unidades` (strings, contrato histórico) y `unidadesDetalle`
 * ([{unidad,factor}], el dato nuevo). Ver `conFactores` para el porqué de los
 * dos campos.
 * @param {string} codigo - Código escaneado.
 */
export async function resolverCodigoBarras(codigo) {
  const limpio = String(codigo).trim();
  try {
    // 1. Buscar si es un código de barras específico (EAN/UPC)
    const { data: eanMatch } = await supabase
      .from("siesa_codigos_barras")
      .select("f120_id, unidad_medida")
      .eq("codigo_barras", limpio)
      .maybeSingle();

    if (eanMatch) {
      // Es un código de barras, retorna su item y su unidad de medida única
      return {
        isBase: false,
        f120_id: eanMatch.f120_id,
        ...(await conFactores(eanMatch.f120_id, [eanMatch.unidad_medida].filter(Boolean))),
      };
    }

    // 2. Si no es código de barras, asumimos que es el código base (PLU / f120_id)
    // Buscamos todas las unidades de medida que tiene configuradas
    const { data: baseMatch } = await supabase
      .from("siesa_codigos_barras")
      .select("unidad_medida")
      .eq("f120_id", limpio);

    const unidades = Array.from(
      new Set((baseMatch || []).map((b) => b.unidad_medida).filter(Boolean)),
    );

    return {
      isBase: true,
      f120_id: limpio,
      // Fallback a UND si no hay ninguna configurada
      ...(await conFactores(limpio, unidades.length > 0 ? unidades : ["UND"])),
    };
  } catch (error) {
    // Fallback absoluto ante cualquier falla
    return {
      isBase: true,
      f120_id: limpio,
      unidades: ["UND"],
      unidadesDetalle: [{ unidad: "UND", factor: 1 }],
    };
  }
}

/**
 * Ficha mínima de un ítem a partir de lo que se escaneó: código SIESA real,
 * descripción y unidad base.
 *
 * PARA QUÉ — el auditor puede recibir mercancía que no venía en la lista del
 * despachador y la agrega escaneándola. Si el lector devuelve un EAN
 * (`75011257166531`) y nadie lo traduce, el renglón se guardaba con ese número
 * como código y sin descripción: en la comparativa y en el correo salía una fila
 * anónima, y la imagen tampoco cargaba porque el catálogo de fotos se busca por
 * código SIESA, no por código de barras.
 *
 * Tres pasos, todos best-effort:
 *   1. EAN → `f120_id` (tabla `siesa_codigos_barras`).
 *   2. `f120_id` → descripción, UM y criterios del snapshot (cualquier bodega: la
 *      ficha del ítem es la misma en todas, lo que cambia son las cantidades).
 *   3. Si el snapshot no lo tiene → `items_siesa`, el maestro completo del
 *      catálogo. Cubre justo lo que al snapshot le falta (ver el comentario del
 *      paso 3 abajo).
 *
 * Nunca lanza: si SIESA no lo conoce, devuelve el código tal cual llegó y sin
 * descripción. Un ítem sin ficha es peor que uno con ficha, pero mucho mejor que
 * un 500 en medio de un cierre de auditoría.
 *
 * @param {string} codigo - lo que se escaneó (EAN o código SIESA)
 * @returns {Promise<{codigo_item:string, descripcion:string|null, unidad_medida:string|null, grupo:string|null, subgrupo:string|null}>}
 */
export async function fichaDeItem(codigo) {
  const crudo = String(codigo ?? "").trim();
  if (!crudo) return { codigo_item: "", descripcion: null, unidad_medida: null };

  let codigoItem = crudo;
  try {
    const resuelto = await resolverCodigoBarras(crudo);
    if (resuelto?.f120_id) codigoItem = String(resuelto.f120_id).trim();
  } catch {
    // Se sigue con el código crudo: el paso 2 igual puede reconocerlo.
  }

  let descripcion = null;
  let unidad = null;
  let grupo = null;
  let subgrupo = null;

  try {
    const { data } = await supabase
      .from("traslados_snapshot")
      .select("descripcion, um, criterios")
      .eq("codigo_item", codigoItem)
      .limit(1)
      .maybeSingle();

    descripcion = trim(data?.descripcion) || null;
    unidad = trim(data?.um) || null;
    grupo = trim(data?.criterios?.["001"]) || null;
    subgrupo = trim(data?.criterios?.["002"]) || null;
  } catch {
    // Se sigue al maestro: que falle el snapshot no significa que el ítem no exista.
  }

  // PASO 3 — EL MAESTRO, cuando el snapshot no lo tiene.
  //
  // El snapshot es POR BODEGA: solo trae los ítems que SIESA devolvió para las
  // bodegas que se consultan. Un producto que existe en el catálogo pero no está
  // stockeado en esas bodegas —que es justo el caso de la mercancía que llega de
  // sorpresa y el auditor tiene que agregar— no aparece, y el renglón quedaba sin
  // descripción aunque el código estuviera perfectamente resuelto.
  //
  // Medido sobre 200 códigos de barras reales: el snapshot resuelve el 76,5% y
  // `items_siesa` el 100%. Son 47 de cada 200 renglones que hoy salen anónimos en
  // la comparativa y en el correo.
  if (!descripcion) {
    try {
      const idNumerico = Number(codigoItem);
      if (Number.isFinite(idNumerico)) {
        const { data: maestro } = await supabase
          .from("items_siesa")
          .select("f120_descripcion, grupo, subgrupo")
          .eq("f120_id", idNumerico)
          .maybeSingle();

        descripcion = trim(maestro?.f120_descripcion) || null;
        grupo = grupo || trim(maestro?.grupo) || null;
        subgrupo = subgrupo || trim(maestro?.subgrupo) || null;
      }
    } catch {
      // Best-effort hasta el final: sin ficha se guarda el código y la cantidad,
      // que es lo que el auditor contó de verdad. Perder ese conteo por un timeout
      // de catálogo sería mucho peor que un renglón sin nombre.
    }
  }

  // `grupo` viaja para que el ítem agregado caiga en su pasillo y no al final de
  // la lista, en la bolsa de "Sin grupo", que es donde termina todo lo que llega
  // sin clasificar.
  return { codigo_item: codigoItem, descripcion, unidad_medida: unidad, grupo, subgrupo };
}

export { getFlujoPorDestino };


