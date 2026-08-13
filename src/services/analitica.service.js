import { supabase } from "../config/supabase.js";
import { despachadoEnUnd, MOTIVOS_FALTANTE } from "../models/Item.model.js";
import { nombreSede } from "../config/flujos.js";

/* =============================================
   Analítica de traslados — agregación para el Dashboard

   POR QUÉ ACÁ Y NO EN EL NAVEGADOR
   El Dashboard viejo se armaba con `/despachos?resumen=true`, que trae CABECERAS.
   Todo lo que vale para decidir vive a nivel de RENGLÓN — qué se pidió, qué salió,
   por qué no salió — y son cientos de miles de filas apenas esto entre en régimen.
   Traerlas al browser para sumarlas ahí funciona con 500 y se cae con 50.000.

   TODO SE MIDE EN UND
   `cantidad_admin` y `cantidad_despachador` viven en la UM del renglón;
   `cantidad_auditor` ya viene en UND. Mezclarlas sin el factor compara peras con
   manzanas — es el error que ya mordió tres veces en este módulo (ver
   ARQUITECTURA.md §6.5). Acá TODO pasa por `despachadoEnUnd` o por `× factor`.

   CADA BLOQUE DECLARA SU `n`
   Con pocos despachos, un promedio es una anécdota con decimales. El frontend usa
   ese `n` para mostrar "muestra insuficiente" en vez de dibujar una tendencia que
   nadie debería creer.
   ============================================= */

const PAGE = 1000;
const num = (v) => Number(v) || 0;

/** Estados donde el despacho ya cerró del todo (pasó por el recibo). */
const ESTADOS_CERRADOS = ["Auditado", "Rechazado", "Recibido_con_inconsistencia"];

/**
 * Estados donde lo despachado YA ES UN RESULTADO y no trabajo en curso.
 *
 * El corte es el camión saliendo (`Recolectado`): a partir de ahí lo que se
 * recolectó es definitivo. Antes —`Creado`, `En_recoleccion`, `Pendiente_carga`—
 * el despacho se está armando y sus renglones todavía pueden cambiar.
 *
 * POR QUÉ IMPORTA TANTO ESTE FILTRO: sin él, un solo despacho a medio recolectar
 * arrastra todos los indicadores. Medido sobre el histórico completo daba un nivel
 * de servicio del 52% y 324 casos de "inventario fantasma" — y 320 de esos venían
 * de UN despacho Llano que seguía abierto, con sus pendientes auto-clasificados.
 * El número era real y la conclusión, falsa: no había un problema de inventario,
 * había un despacho sin terminar.
 */
const ESTADOS_CON_RESULTADO = [
  "Recolectado",
  "En_recepcion",
  "Auditado",
  "Rechazado",
  "Recibido_con_inconsistencia",
];

/** Lee una tabla entera paginando (Supabase corta en 1000). */
async function leerTodo(tabla, columnas, filtro = (q) => q) {
  const filas = [];
  let desde = 0;
  for (;;) {
    const { data, error } = await filtro(
      supabase.from(tabla).select(columnas).range(desde, desde + PAGE - 1),
    );
    if (error) throw new Error(`Error al leer ${tabla}: ${error.message}`);
    if (!data?.length) break;
    filas.push(...data);
    if (data.length < PAGE) break;
    desde += PAGE;
  }
  return filas;
}

/** Cantidad pedida por el admin, en UND (la del renglón × su factor). */
const pedidoEnUnd = (it) => num(it.cantidad_admin) * (num(it.factor) || 1);

/**
 * Mediana y p90. Se usa mediana y NO promedio a propósito: con muestras chicas y
 * sesgadas —un despacho que quedó abierto el fin de semana— el promedio se va al
 * techo y describe un caso que no es el típico. La mediana aguanta el outlier y el
 * p90 lo muestra aparte, que es donde vive el problema real.
 */
function resumenNumerico(valores) {
  const v = valores.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return { n: 0, mediana: null, p90: null, min: null, max: null };
  const en = (p) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
  const mid = Math.floor(v.length / 2);
  return {
    n: v.length,
    mediana: v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2,
    p90: en(0.9),
    min: v[0],
    max: v[v.length - 1],
  };
}

/** Horas entre dos ISO, o null si falta alguno o el orden es inválido. */
function horas(desde, hasta) {
  if (!desde || !hasta) return null;
  const h = (new Date(hasta).getTime() - new Date(desde).getTime()) / 36e5;
  // Negativo = los hitos quedaron cruzados (un re-sellado, un reintento). No se
  // descarta en silencio: se ignora para no ensuciar la mediana con un imposible.
  return h >= 0 ? h : null;
}

/**
 * Fin del día de una fecha `YYYY-MM-DD`.
 *
 * Un `hasta` crudo se interpreta como medianoche, así que filtrar "hasta el 12"
 * dejaba afuera TODO lo del día 12 — el usuario elige un rango y el último día no
 * aparece, que es el bug clásico de los filtros de fecha.
 */
function finDelDia(fecha) {
  if (!fecha) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(fecha) ? `${fecha}T23:59:59.999Z` : fecha;
}

/**
 * Analítica completa para el Dashboard.
 *
 * @param {object} [opts]
 * @param {number} [opts.dias]  - ventana hacia atrás. Sin esto, todo el histórico.
 * @param {string} [opts.desde] - fecha YYYY-MM-DD. Pisa a `dias` si viene.
 * @param {string} [opts.hasta] - fecha YYYY-MM-DD, inclusive.
 * @param {string} [opts.sede]  - código de bodega. Filtra los traslados donde esa
 *   sede participa, como ORIGEN o como DESTINO — mismo criterio que el Monitor:
 *   preguntar por una bodega incluye lo que le llega y lo que sale de ella.
 */
export async function analitica({ dias, desde, hasta, sede } = {}) {
  // Un rango explícito manda sobre `dias`: si el usuario eligió fechas, eso es lo
  // que quiere ver, y aplicar las dos cosas daría una ventana que no pidió nadie.
  const usaRango = Boolean(desde || hasta);
  const desdeISO = usaRango
    ? desde || null
    : dias
      ? new Date(Date.now() - dias * 864e5).toISOString()
      : null;
  const hastaISO = usaRango ? finDelDia(hasta) : null;

  const despachos = await leerTodo(
    "traslados_despachos",
    "id, origen, destino, flujo, estado, inactivo, created_at, disponible_at, " +
      "recoleccion_iniciada_at, recoleccion_finalizada_at, auditoria_iniciada_at, " +
      "auditoria_finalizada_at, siesa_estado",
    (q) => {
      let out = q;
      if (desdeISO) out = out.gte("created_at", desdeISO);
      if (hastaISO) out = out.lte("created_at", hastaISO);
      // Origen O destino, como en el Monitor. La sede llega ya validada por el
      // controlador contra el maestro de bodegas.
      if (sede) out = out.or(`origen.eq.${sede},destino.eq.${sede}`);
      return out;
    },
  );

  const porId = new Map(despachos.map((d) => [d.id, d]));

  const items = await leerTodo(
    "traslados_items",
    "id, despacho_id, codigo_item, descripcion, grupo, categoria, unidad_medida, factor, " +
      "cantidad_admin, cantidad_despachador, cantidad_auditor, diferencia, motivo, " +
      "agotado, no_recibido, peso_unitario, agregado_por_auditor",
  );
  // Solo los ítems de los despachos de la ventana.
  const itemsVentana = items.filter((it) => porId.has(it.despacho_id));

  /* ── 1. Nivel de servicio ─────────────────────────────────────────────
     Pedido vs. despachado, en UND. Solo cuentan los renglones que el
     despachador REGISTRÓ: los que nunca tocó no son incumplimiento, son
     despachos que todavía no terminaron. Meterlos hundiría el indicador con
     trabajo en curso. */
  const registrados = itemsVentana.filter((it) => {
    const d = porId.get(it.despacho_id);
    // Solo despachos cuyo resultado ya está sellado (el camión salió).
    if (!d || !ESTADOS_CON_RESULTADO.includes(d.estado)) return false;
    // Los renglones que el despachador nunca registró no son incumplimiento.
    if (it.cantidad_despachador == null) return false;
    // Lo que agregó quien recibe no estaba en el pedido: no mide cumplimiento.
    return !it.agregado_por_auditor;
  });

  const acumular = (mapa, clave, it) => {
    if (!mapa.has(clave)) {
      mapa.set(clave, {
        pedido: 0,
        despachado: 0,
        lineas: 0,
        incumplidas: 0,
        // Productos DISTINTOS del grupo. Contra el total de líneas dice si el
        // faltante son muchos productos fallando una vez o unos pocos fallando
        // siempre — que piden cosas opuestas: revisar el surtido o revisar a un
        // proveedor. Sin esto, 144 líneas puede ser cualquiera de las dos.
        items: new Set(),
        itemsIncumplidos: new Set(),
      });
    }
    const a = mapa.get(clave);
    const ped = pedidoEnUnd(it);
    const des = despachadoEnUnd(it);
    a.pedido += ped;
    a.despachado += des;
    a.lineas += 1;
    a.items.add(String(it.codigo_item));
    if (des < ped) {
      a.incumplidas += 1;
      a.itemsIncumplidos.add(String(it.codigo_item));
    }
  };

  const global = { pedido: 0, despachado: 0, lineas: 0, incumplidas: 0 };
  const porSede = new Map();
  // OJO con los nombres de las columnas: `traslados_items.grupo` es el criterio
  // 001 (Grupo) y `traslados_items.categoria` es el 002 (Subgrupo). El nombre de
  // la columna no coincide con el del negocio — se copiaron así desde el carrito
  // del admin (ver `construirItem`) y renombrarlas ahora obligaría a migrar datos.
  const porGrupo = new Map();
  const porCategoria = new Map();
  const porFlujo = new Map();

  for (const it of registrados) {
    const d = porId.get(it.despacho_id);
    const ped = pedidoEnUnd(it);
    const des = despachadoEnUnd(it);
    global.pedido += ped;
    global.despachado += des;
    global.lineas += 1;
    if (des < ped) global.incumplidas += 1;
    acumular(porSede, d.destino || "—", it);
    acumular(porGrupo, (it.grupo || "").trim() || "Sin grupo", it);
    acumular(porCategoria, (it.categoria || "").trim() || "Sin subgrupo", it);
    acumular(porFlujo, d.flujo || "general", it);
  }

  const tasa = (a) => (a.pedido > 0 ? a.despachado / a.pedido : null);
  const aLista = (mapa, nombrar = (k) => k) =>
    [...mapa.entries()]
      .map(([k, a]) => ({
        clave: k,
        nombre: nombrar(k),
        pedido_und: Math.round(a.pedido),
        despachado_und: Math.round(a.despachado),
        faltante_und: Math.round(a.pedido - a.despachado),
        nivel_servicio: tasa(a),
        lineas: a.lineas,
        lineas_incumplidas: a.incumplidas,
        // `items` son productos distintos; `lineas` son veces que se pidieron.
        // La diferencia entre los dos ES la repetición.
        items: a.items?.size ?? 0,
        items_incumplidos: a.itemsIncumplidos?.size ?? 0,
      }))
      .sort((x, y) => y.faltante_und - x.faltante_und);

  /* ── 1b. Detalle por PRODUCTO ─────────────────────────────────────────
     El mismo cálculo del nivel de servicio, pero abierto producto por producto y
     con su grupo/subgrupo encima. Es el paso que faltaba para poder pasar de
     "Abarrotes anda al 71%" a "y es por estos cuatro productos".

     Se devuelven TODOS y no un top: el panel filtra por grupo, y un top global
     dejaría afuera justo los productos de la categoría que se está mirando —
     que es cuando alguien abre este detalle. */
  const porProducto = new Map();
  for (const it of registrados) {
    const k = String(it.codigo_item);
    if (!porProducto.has(k)) {
      porProducto.set(k, {
        codigo_item: k,
        descripcion: (it.descripcion || "").trim(),
        grupo: (it.grupo || "").trim() || "Sin grupo",
        subgrupo: (it.categoria || "").trim() || "Sin subgrupo",
        pedido: 0,
        despachado: 0,
        veces: 0,
        veces_cortas: 0,
      });
    }
    const a = porProducto.get(k);
    const ped = pedidoEnUnd(it);
    const des = despachadoEnUnd(it);
    a.pedido += ped;
    a.despachado += des;
    a.veces += 1;
    if (des < ped) a.veces_cortas += 1;
  }
  const productos = [...porProducto.values()]
    .map((a) => ({
      codigo_item: a.codigo_item,
      descripcion: a.descripcion,
      grupo: a.grupo,
      subgrupo: a.subgrupo,
      pedido_und: Math.round(a.pedido),
      despachado_und: Math.round(a.despachado),
      faltante_und: Math.round(a.pedido - a.despachado),
      // Cuántas VECES se pidió el producto entre todos los traslados de la
      // ventana. Un 3 acá con 3 en `veces_cortas` es un producto que nunca sale
      // completo: eso no es abastecimiento, es un dato mal cargado o un proveedor.
      veces: a.veces,
      veces_cortas: a.veces_cortas,
      nivel_servicio: a.pedido > 0 ? a.despachado / a.pedido : null,
    }))
    .sort((x, y) => y.faltante_und - x.faltante_und || y.pedido_und - x.pedido_und);

  /* ── 2. Pareto de ítems incumplidos ───────────────────────────────────
     Qué productos concentran el faltante. Es la lista con la que compras sabe
     a quién apretar, y casi siempre unos pocos explican la mayoría. */
  const porItem = new Map();
  for (const it of registrados) {
    const falt = pedidoEnUnd(it) - despachadoEnUnd(it);
    if (falt <= 0) continue;
    const k = String(it.codigo_item);
    if (!porItem.has(k)) {
      porItem.set(k, {
        codigo_item: k,
        descripcion: (it.descripcion || "").trim(),
        faltante_und: 0,
        ocurrencias: 0,
        motivos: {},
      });
    }
    const a = porItem.get(k);
    a.faltante_und += falt;
    a.ocurrencias += 1;
    if (it.motivo) a.motivos[it.motivo] = (a.motivos[it.motivo] || 0) + 1;
  }
  const itemsIncumplidos = [...porItem.values()]
    .map((a) => ({ ...a, faltante_und: Math.round(a.faltante_und) }))
    .sort((x, y) => y.faltante_und - x.faltante_und);

  // Cuántos ítems explican el 80% del faltante — el número de Pareto.
  const faltanteTotal = itemsIncumplidos.reduce((s, a) => s + a.faltante_und, 0);
  let acum = 0;
  let itemsPara80 = 0;
  for (const a of itemsIncumplidos) {
    if (acum >= faltanteTotal * 0.8) break;
    acum += a.faltante_und;
    itemsPara80 += 1;
  }

  /* ── 3. Motivos del faltante ──────────────────────────────────────────
     No es lo mismo "no había" que "el sistema decía que había". El primero es
     abastecimiento; el segundo es confiabilidad del inventario, y se arregla en
     otro lado. Por eso van separados y con su impacto en UND, no solo el conteo. */
  const porMotivo = {};
  for (const m of MOTIVOS_FALTANTE) porMotivo[m] = { ocurrencias: 0, und: 0, items: new Set() };
  for (const it of registrados) {
    if (!it.motivo || !porMotivo[it.motivo]) continue;
    const falt = Math.max(0, pedidoEnUnd(it) - despachadoEnUnd(it));
    porMotivo[it.motivo].ocurrencias += 1;
    porMotivo[it.motivo].und += falt;
    porMotivo[it.motivo].items.add(String(it.codigo_item));
  }
  const motivos = Object.fromEntries(
    Object.entries(porMotivo).map(([m, a]) => [
      m,
      { ocurrencias: a.ocurrencias, und: Math.round(a.und), items: a.items.size },
    ]),
  );

  /* ── 4. Inventario fantasma ───────────────────────────────────────────
     El sistema decía que había stock y la bodega no lo encontró. Cada ocurrencia
     es un pedido que se armó mal desde el origen: el admin lo sugirió porque el
     inventario mentía. Es el indicador que dispara conteo cíclico. */
  const FANTASMA = "inventario_inflado";
  const fantasmaItems = new Map();
  const fantasmaSede = new Map();
  for (const it of registrados) {
    if (it.motivo !== FANTASMA) continue;
    const d = porId.get(it.despacho_id);
    const falt = Math.max(0, pedidoEnUnd(it) - despachadoEnUnd(it));
    const k = String(it.codigo_item);
    if (!fantasmaItems.has(k)) {
      fantasmaItems.set(k, {
        codigo_item: k,
        descripcion: (it.descripcion || "").trim(),
        ocurrencias: 0,
        und: 0,
      });
    }
    const a = fantasmaItems.get(k);
    a.ocurrencias += 1;
    a.und += falt;
    const s = d.origen || "—";
    if (!fantasmaSede.has(s)) fantasmaSede.set(s, { ocurrencias: 0, und: 0 });
    fantasmaSede.get(s).ocurrencias += 1;
    fantasmaSede.get(s).und += falt;
  }

  /* ── 5. Tiempos por etapa ─────────────────────────────────────────────
     Dónde se traba el flujo. Cada etapa por separado, porque el total no dice
     dónde poner gente. */
  const etapasDef = [
    { clave: "espera_despachador", label: "Esperando despachador", de: "disponible_at", a: "recoleccion_iniciada_at" },
    { clave: "recoleccion", label: "Recolectando", de: "recoleccion_iniciada_at", a: "recoleccion_finalizada_at" },
    { clave: "espera_camion", label: "Esperando camión", de: "recoleccion_finalizada_at", a: "auditoria_iniciada_at" },
    { clave: "recibo", label: "Recibiendo", de: "auditoria_iniciada_at", a: "auditoria_finalizada_at" },
    { clave: "total", label: "Ciclo completo", de: "created_at", a: "auditoria_finalizada_at" },
  ];
  const etapas = etapasDef.map((e) => ({
    clave: e.clave,
    label: e.label,
    ...resumenNumerico(despachos.map((d) => horas(d[e.de], d[e.a]))),
  }));

  /* ── 6. Exactitud del recibo ──────────────────────────────────────────
     Si lo que salió, llegó. `diferencia` ya está en UND (ver Item.model). */
  const auditados = itemsVentana.filter((it) => it.cantidad_auditor != null);
  const conDif = auditados.filter((it) => num(it.diferencia) !== 0);
  const topDiferencias = [...auditados]
    .filter((it) => num(it.diferencia) !== 0)
    .sort((a, b) => Math.abs(num(b.diferencia)) - Math.abs(num(a.diferencia)))
    .slice(0, 15)
    .map((it) => ({
      codigo_item: String(it.codigo_item),
      descripcion: (it.descripcion || "").trim(),
      diferencia_und: num(it.diferencia),
      // Los dos lados de la diferencia, para poder mostrarla como un versus en
      // vez de un número suelto: "−12" no dice si faltaron 12 de 15 o de 1.200.
      // El despachador guarda en la UM del renglón (por eso el factor) y quien
      // recibe guarda siempre en unidades base — ver Item.model.
      despachado_und: despachadoEnUnd(it),
      recibido_und: num(it.cantidad_auditor),
      no_recibido: !!it.no_recibido,
    }));

  /* ── 7. Peso movido por ruta ──────────────────────────────────────────
     Cuánto carga cada ruta, para dimensionar camión. En gramos; el front formatea. */
  const porRuta = new Map();
  for (const it of registrados) {
    const d = porId.get(it.despacho_id);
    const k = `${d.origen} → ${d.destino}`;
    if (!porRuta.has(k)) porRuta.set(k, { ruta: k, gramos: 0, sinPeso: 0, despachos: new Set() });
    const a = porRuta.get(k);
    a.despachos.add(d.id);
    const p = num(it.peso_unitario);
    if (p > 0) a.gramos += p * despachadoEnUnd(it);
    else a.sinPeso += 1;
  }

  /* ── 8. Salud de la subida a SIESA ────────────────────────────────────
     Una requisición que no llegó al ERP es inventario que el sistema cree movido
     y el ERP no. Se cuenta aparte porque no es un problema de bodega. */
  const siesa = { pendiente: 0, enviado: 0, fallido: 0 };
  for (const d of despachos) if (siesa[d.siesa_estado] != null) siesa[d.siesa_estado] += 1;

  return {
    generado_at: new Date().toISOString(),
    ventana_dias: dias || null,

    // El frontend decide con esto si dibuja o dice "muestra insuficiente".
    muestra: {
      despachos: despachos.length,
      // Los que ya tienen resultado: la base real de los indicadores. Si este
      // número es chico, todo lo de abajo es anecdótico y el panel lo dice.
      despachos_medibles: despachos.filter((d) => ESTADOS_CON_RESULTADO.includes(d.estado)).length,
      despachos_cerrados: despachos.filter((d) => ESTADOS_CERRADOS.includes(d.estado)).length,
      // Trabajo en curso: se excluye del cálculo a propósito, pero se informa para
      // que nadie se pregunte por qué el panel "no ve" despachos que sí existen.
      despachos_en_curso: despachos.filter(
        (d) => !ESTADOS_CON_RESULTADO.includes(d.estado) && d.estado !== "Borrador",
      ).length,
      items: itemsVentana.length,
      items_registrados: registrados.length,
      items_auditados: auditados.length,
      despachos_con_ciclo: etapas.find((e) => e.clave === "total")?.n || 0,
    },

    servicio: {
      pedido_und: Math.round(global.pedido),
      despachado_und: Math.round(global.despachado),
      faltante_und: Math.round(global.pedido - global.despachado),
      nivel_servicio: tasa(global),
      lineas: global.lineas,
      lineas_incumplidas: global.incumplidas,
      por_sede: aLista(porSede, nombreSede),
      // Grupo = criterio 001, subgrupo = criterio 002. Se mandan los dos para que
      // el panel pueda alternar sin pedir de nuevo: son el mismo cálculo agrupado
      // distinto, y traerlos juntos evita un viaje por cada clic.
      por_grupo: aLista(porGrupo),
      por_subgrupo: aLista(porCategoria),
      // Detalle producto por producto, con su grupo y subgrupo, para el desglose
      // del panel. Va acá y no en un endpoint aparte: sale del mismo recorrido y
      // pedirlo por separado sería leer los ítems dos veces.
      por_producto: productos,
      // Nombre viejo, mantenido para no romper a nadie que ya lo consuma.
      por_categoria: aLista(porCategoria),
      por_flujo: aLista(porFlujo),
    },

    pareto: {
      items_para_80pct: itemsPara80,
      items_con_faltante: itemsIncumplidos.length,
      top: itemsIncumplidos.slice(0, 20),
    },

    motivos,

    fantasma: {
      ocurrencias: [...fantasmaItems.values()].reduce((s, a) => s + a.ocurrencias, 0),
      items: fantasmaItems.size,
      und: Math.round([...fantasmaItems.values()].reduce((s, a) => s + a.und, 0)),
      top: [...fantasmaItems.values()]
        .map((a) => ({ ...a, und: Math.round(a.und) }))
        .sort((x, y) => y.ocurrencias - x.ocurrencias)
        .slice(0, 15),
      por_sede: [...fantasmaSede.entries()]
        .map(([k, a]) => ({ sede: k, nombre: nombreSede(k), ...a, und: Math.round(a.und) }))
        .sort((x, y) => y.ocurrencias - x.ocurrencias),
    },

    tiempos: { etapas },

    recibo: {
      lineas: auditados.length,
      lineas_con_diferencia: conDif.length,
      exactitud: auditados.length ? (auditados.length - conDif.length) / auditados.length : null,
      no_recibidos: auditados.filter((it) => it.no_recibido).length,
      extras: itemsVentana.filter((it) => it.agregado_por_auditor).length,
      top_diferencias: topDiferencias,
    },

    peso: {
      por_ruta: [...porRuta.values()]
        .map((a) => ({
          ruta: a.ruta,
          gramos: Math.round(a.gramos),
          despachos: a.despachos.size,
          lineas_sin_peso: a.sinPeso,
        }))
        .sort((x, y) => y.gramos - x.gramos),
    },

    siesa,
  };
}
