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

const PLANES = [
  { id: "001", label: "Grupo" },
  { id: "002", label: "Subgrupo" },
  { id: "003", label: "Proveedor" },
  { id: "004", label: "Marca" },
  { id: "005", label: "Rotación" },
  { id: "007", label: "Negociaciones Puntuales" }, // antes: Temporada
  { id: "MUA", label: "U. Medida" },
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
    const [rows, config] = await Promise.all([
      leerBodegas([origen, destino]),
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

      productos.push({
        codigo_item: codigo,
        descripcion: trim(fuente.descripcion),
        rotacion: trim(fuente.rotacion) || "N/A",
        unidad_medida: trim(fuente.um),
        unidades: buildUnidades(fuente),
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
          descripcion: trim(fuente.descripcion),
          clase,
          capacidad: v.capacidadUM,
          dias_capacidad: diasCapacidad,
          rotacion: trim(fuente.rotacion) || "N/A",
          unidad_medida: v.unidad || trim(fuente.um),
          unidades: unidadesDetalle.map((u) => u.unidad),
          unidadesDetalle,
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

export { getFlujoPorDestino };


