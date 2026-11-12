import {
  calcularSugeridoGeneral,
  calcularSugeridoABC,
  calcularSugeridoCapacidad,
} from "./sugerido.service.js";
import { leerBodegas, leerBodegasItems } from "./snapshot.service.js";
import { mapaCapacidades, factoresDeItem } from "../models/Capacidad.model.js";
import { obtener as obtenerConfig } from "../models/Config.model.js";
import { codigosDe as extrasDe } from "../models/PortafolioExtra.model.js";
import { porCodigos as catalogoPorCodigos } from "../models/Catalogo.model.js";
import { supabase } from "../config/supabase.js";
import { SEDES, FLUJOS, nombreSede, getFlujoPorDestino } from "../config/flujos.js";
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

/* ─── Portafolio EXTRA (productos agregados a mano a una sede) ─────────
   Un administrador agrega un producto al portafolio de UNA sede (tabla
   `traslados_portafolio_extra`, migración 043). Ese producto tiene que aparecer en
   la lista de esa sede en TODOS los flujos aunque:
     - no tenga capacidad (en los flujos A/B/C sale con sugerido 0),
     - la sede nunca lo haya movido (sin fila en el snapshot del destino),
     - no cumpla el portafolio del flujo (CAT / CAM / requiereCapacidad / requiereOrigen),
     - no exista en el origen (sale con disponible 0).
   Las reglas de "se esconde si no hay origen y no hay necesidad" tampoco le aplican.
   Vive SOLO en Supabase: nada de esto escribe en SIESA. */

/**
 * Fila con la forma del snapshot para un extra que NO tiene fila en ningún lado
 * (ni en el origen ni en el destino). Sale del catálogo: identidad del ítem y nada
 * más. Todo lo demás lleva un valor seguro — factor 1, volumen null ("sin dato", no
 * "ocupa cero"), existencias y consumo en 0 — porque el constructor de filas del
 * producto lee de acá descripción, UM, factor, volumen, criterios y rotación.
 *
 * Los criterios 001 (Grupo) y 002 (Subgrupo) vienen del catálogo para que el ítem
 * también responda a los filtros de la barra de criterios.
 */
function filaDesdeCatalogo(c, bodega) {
  return {
    bodega,
    codigo_item: trim(c.codigo_item),
    descripcion: trim(c.descripcion),
    um: trim(c.um),
    um_orden: trim(c.um_orden) || trim(c.um),
    factor: 1,
    volumen: null,
    inventario: 0,
    disponible: 0,
    comprometido: 0,
    consumo_promedio: 0,
    periodo_cubrimiento: 0,
    rotacion: "",
    referencia: trim(c.referencia),
    criterios: { "001": trim(c.grupo), "002": trim(c.subgrupo) },
  };
}

/**
 * Filas del catálogo de los extras que no tienen fila en el origen ni en el destino,
 * ya con forma de snapshot (`Map<codigo, fila>`). Si el catálogo no los tiene tampoco
 * (el ítem salió de SIESA), no entran al mapa y el llamador los salta con un aviso.
 */
async function filasDeExtrasSinRegistro(extras, oMap, dMap, destino) {
  const sinFila = [...extras].filter((c) => !oMap.has(c) && !dMap.has(c));
  const filas = new Map();
  if (sinFila.length === 0) return filas;
  const catalogo = await catalogoPorCodigos(sinFila);
  for (const [codigo, c] of catalogo) filas.set(codigo, filaDesdeCatalogo(c, destino));
  return filas;
}

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
 * Productos de la TIENDA DESTINO cruzados con el stock del ORIGEN + sugerido
 * (stock de seguridad).
 * @param {object} opts
 * @param {string} opts.origen  - Bodega origen
 * @param {string} opts.destino - Bodega destino
 */
export async function getProductosTraslado({ origen, destino }) {
  try {
    const [rows, capacidades, config, extras] = await Promise.all([
      leerBodegas([origen, destino]),
      // Las UM cargadas en Capacidad·Llano se usan TAMBIÉN acá para partir el ítem
      // en una fila por unidad. Lo que NO cruza es la `capacidad` en sí: ese número
      // alimenta el sugerido A/B/C y es exclusivo de Llano — General calcula por
      // stock de seguridad. De esa tabla solo se toman `unidad` y `factor`.
      mapaCapacidades(),
      obtenerConfig(),
      // Productos agregados a mano al portafolio de este destino (ver extrasDe).
      extrasDe(destino),
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
    // SOLO lo que existe en la TIENDA DESTINO — misma regla que Llano (ver
    // getProductosLlano). El panel se pide por destino y tiene que mostrar los
    // productos de esa sede, no el catálogo del CEDI.
    //
    // Antes esto recorría la UNIÓN origen ∪ destino, y como en General no hay
    // filtro de CAT, TODO el catálogo del CEDI (PV001, 17.005 ítems) aparecía para
    // cada tienda. Medido el 28/09/2026: entre el 27% (Girardota Parque) y el 54%
    // (San Juan) de la lista eran productos que esa tienda nunca manejó. Entraban
    // con sugerido 0 —así que "Solo sugeridos" estaba limpio— pero llenaban la
    // lista al filtrar por Grupo, Proveedor o Marca.
    //
    // COSTO ACEPTADO: desde este panel ya no se le puede mandar a una tienda un
    // producto que nunca tuvo (introducir un producto nuevo, o sacar inventario
    // muerto del CEDI hacia una tienda que no lo manejaba). Fue una decisión de
    // negocio explícita. Si ese caso vuelve a hacer falta, la salida no es volver
    // a la unión: es marcar cada fila con `en_destino` y esconder las `false` por
    // defecto, con un interruptor para mostrarlas.
    //
    // Los AGOTADOS de la tienda NO se pierden: la consulta de Connekta parte de
    // t400_cm_existencia sin filtrar existencia > 0 (ver docs/CONSULTA_SNAPSHOT_CONNEKTA.md).
    //
    // Lo que la tienda tiene y el CEDI no se sigue mostrando si la tienda lo
    // necesita (necesidad > 0): se puede mandar desde otra sede.
    // Sin filas del destino no hay nada que mostrar, y una lista vacía con ok:true
    // se lee como "no hay productos". Casi siempre es otra cosa: una bodega que
    // está en flujos.js pero no en el WHERE de la consulta de Connekta (ver
    // docs/CONSULTA_SNAPSHOT_CONNEKTA.md), o una sede nueva. Se dice con todas las
    // letras; el controlador lo responde como 502.
    //
    // Los extras (portafolio agregado a mano) cuentan como "algo que mostrar": una sede
    // sin filas en el snapshot pero con extras NO es un error. Por eso el chequeo va
    // DESPUÉS de sumarlos.
    const codigos = new Set(dMap.keys());
    for (const extra of extras) codigos.add(extra);
    if (codigos.size === 0) {
      return { error: `Sin datos de inventario para la bodega ${destino} en el snapshot` };
    }
    const filasCatalogo = await filasDeExtrasSinRegistro(extras, oMap, dMap, destino);

    for (const codigo of codigos) {
      const o = oMap.get(codigo);
      const d = dMap.get(codigo);
      const esExtra = extras.has(codigo);
      // descripción/UM/criterios: preferimos el origen; un extra sin fila en ninguna
      // bodega usa la del catálogo.
      const fuente = o || d || (esExtra ? filasCatalogo.get(codigo) : undefined);
      if (!fuente) {
        console.warn(
          `[portafolio-extra] ${codigo} está agregado a ${destino} pero no está en el snapshot ni en el catálogo: no se muestra.`,
        );
        continue;
      }

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
      // Un extra se muestra SIEMPRE: el administrador lo agregó a propósito.
      if (!o && necesidad <= 0 && !esExtra) continue;

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
          // Agregado a mano al portafolio de este destino (ver "Portafolio EXTRA").
          portafolio_extra: esExtra,
          // El origen no tiene fila del ítem: su disponible 0 no es un agotado medido.
          sin_registro_origen: !o,
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
 * Clase A/B/C de varios ítems, para mostrarla en el detalle de un despacho Llano.
 *
 * POR QUÉ SE DERIVA Y NO SE LEE DEL ÍTEM: la clase nunca se guardó. El panel de
 * armado mandaba `rotacion: p.rotacion || p.clase`, con la intención de guardar
 * la clase en Llano, pero `getProductosLlano` devuelve `rotacion` como "N/A"
 * cuando no hay dato — nunca vacío — así que el `||` siempre se quedaba con la
 * rotación. Derivarla acá funciona también para los despachos ya creados.
 *
 * Es la clase ACTUAL del maestro, no la del día en que se armó el despacho. Una
 * reclasificación en SIESA cambia lo que se ve en despachos viejos.
 *
 * Usa `claseDeCategoria`, la misma función del panel de armado: la clase que se
 * ve en el monitor es la misma con la que se calculó el sugerido.
 *
 * @param {string} destino - bodega destino (el CAT es del ítem, pero se lee de
 *   la fila del destino por coherencia con getProductosLlano)
 * @param {string[]} codigos
 * @returns {Promise<Map<string, "A"|"B"|"C"|"ninguno">>} ítems sin fila en el
 *   snapshot quedan fuera del mapa (el llamador decide cómo mostrarlos)
 */
export async function clasesLlanoDeItems(destino, codigos) {
  const flujo = reglasDe(destino);
  // Un flujo sin clasificación (Machado) no tiene clases: ni se lee el snapshot ni se
  // toca el CAT, que es exclusivo de Llano.
  if (!flujo.clasificacion) return new Map();
  const filas = await leerBodegasItems([destino], codigos);
  const clases = new Map();
  for (const r of filas) {
    clases.set(String(r.codigo_item).trim(), claseSegunFlujo(flujo, r, null));
  }
  return clases;
}

/**
 * Regla del flujo de un destino (portafolio y clasificación, ver config/flujos.js).
 * Un destino sin flujo cae en las de Llano, el comportamiento histórico de esta función.
 */
function reglasDe(destino) {
  return getFlujoPorDestino(destino) || FLUJOS.llano;
}

/**
 * Ítems del portafolio que NO se muestran solo porque no existen en el origen.
 *
 * Machado oculta lo que no tiene fila en PV001 (no se puede despachar desde ahí), pero
 * ocultarlo EN SILENCIO hace que el usuario cuente 371 productos donde espera 375. Esto
 * devuelve esos ítems —los que cumplen TODAS las demás reglas del portafolio— con las
 * sedes donde SÍ hay existencia, para avisarlos en pantalla sin ofrecerlos como despachables.
 *
 * Solo hace una lectura extra del snapshot cuando hay candidatos.
 *
 * @returns {Promise<Array<{codigo_item, descripcion, capacidad, unidad, sedes: Array<{codigo, nombre, disponible}>}>>}
 */
async function ocultosSinOrigen({ flujo, origen, destino, oMap, dMap, capacidades, extras = new Set() }) {
  const reglasSinOrigen = { ...flujo, portafolio: { ...flujo.portafolio, requiereOrigen: false } };
  const plan = flujo.portafolio.plan;

  // Candidatos baratos: capacidad > 0, sin fila en el origen y, si el destino tiene fila,
  // con el portafolio activo según ella. Sin fila del destino se decide con las demás.
  const candidatos = [];
  for (const [codigo, capRows] of capacidades) {
    if (oMap.has(codigo)) continue;
    // Un extra SÍ se muestra (sin origen y todo): no está "oculto", así que no se avisa.
    if (extras.has(codigo)) continue;
    if (!capRows.some((r) => num(r.capacidad) > 0)) continue;
    const d = dMap.get(codigo);
    if (d && !pasaPortafolio(reglasSinOrigen, d, undefined, capRows)) continue;
    candidatos.push(codigo);
  }
  if (candidatos.length === 0) return [];

  const filas = await leerBodegasItems(Object.keys(SEDES), candidatos);
  const porItem = new Map();
  for (const r of filas) {
    const k = String(r.codigo_item).trim();
    if (!porItem.has(k)) porItem.set(k, []);
    porItem.get(k).push(r);
  }

  const ocultos = [];
  for (const codigo of candidatos) {
    const filasItem = porItem.get(codigo) || [];
    if (filasItem.length === 0) continue; // sin ninguna fila no hay forma de verificar el CAM
    const capRows = capacidades.get(codigo);
    // El criterio es del ítem: da igual de qué bodega salga, pero se prefiere una fila que lo traiga.
    const conCriterio = filasItem.find((r) => trim(r.criterios?.[plan])) || filasItem[0];
    if (!pasaPortafolio(reglasSinOrigen, conCriterio, undefined, capRows)) continue;

    const cap = capRows.find((r) => num(r.capacidad) > 0);
    const sedes = filasItem
      .filter((r) => r.bodega !== destino && r.bodega !== origen)
      .map((r) => ({
        codigo: trim(r.bodega),
        nombre: nombreSede(trim(r.bodega)),
        disponible: Math.max(0, Math.floor(num(r.disponible))),
      }))
      .filter((s) => s.disponible > 0)
      .sort((a, b) => b.disponible - a.disponible);
    ocultos.push({
      codigo_item: codigo,
      descripcion:
        trim(filasItem.find((r) => trim(r.descripcion))?.descripcion) ||
        capRows.find((r) => r.descripcion)?.descripcion ||
        "",
      capacidad: cap.capacidad,
      unidad: cap.unidad || "",
      sedes,
    });
  }
  return ocultos.sort((a, b) => a.codigo_item.localeCompare(b.codigo_item, "es", { numeric: true }));
}

/**
 * Criterios que se devuelven con cada producto. En un flujo que NO clasifica (Machado) se
 * quita el CAT: es la clasificación de Llano, y dejarlo a la vista invita a que algún
 * consumidor lea la clase de Llano para Machado. Llano y General reciben el objeto tal cual.
 */
function criteriosVisibles(flujo, criterios) {
  const c = criterios || {};
  if (flujo.clasificacion) return c;
  const { CAT: _cat, ...resto } = c; // eslint-disable-line no-unused-vars
  return resto;
}

/**
 * Clase A/B/C de un ítem según la regla de clasificación del flujo.
 * `null` si el flujo no clasifica (Machado): NO se lee ningún criterio.
 * Mismo origen del dato que siempre: el registro del destino y, sin él, el del origen.
 */
function claseSegunFlujo(flujo, d, o) {
  const plan = flujo.clasificacion?.plan;
  if (!plan) return null;
  return claseDeCategoria(d ? d.criterios?.[plan] : o?.criterios?.[plan]);
}

/**
 * ¿El ítem pertenece al portafolio del flujo? Reemplaza al filtro fijo de CAT que tenía
 * Llano: la regla ahora es configuración (`flujo.portafolio`). El criterio es del ÍTEM
 * (no de la bodega), así que da igual leerlo del destino o del origen.
 *
 * Con la regla de Llano (`plan: "CAT"`, excluir DESCODIFICADOS) el resultado es el mismo
 * de antes: sin CAT → fuera; DESCODIFICADOS → fuera; cualquier otro valor → dentro.
 */
function pasaPortafolio(flujo, d, o, capRows) {
  const reglas = flujo.portafolio;
  if (!reglas) return true;
  // Machado solo muestra lo que se le puede mandar desde el origen: un ítem con fila en
  // la tienda pero sin fila en PV001 no tiene de dónde salir (Llano, en cambio, muestra
  // lo que "se puede mandar desde otra sede").
  if (reglas.requiereOrigen && !o) return false;
  const valor = trim(d?.criterios?.[reglas.plan] || o?.criterios?.[reglas.plan]);
  if (!valor) return false;
  const norm = normalizarCriterio(valor);
  if (reglas.valor && norm !== normalizarCriterio(reglas.valor)) return false;
  if ((reglas.excluir || []).some((x) => norm === normalizarCriterio(x))) return false;
  if (reglas.requiereCapacidad && !(capRows || []).some((r) => num(r.capacidad) > 0)) return false;
  return true;
}

/**
 * Normaliza un valor de criterio para compararlo: sin tildes, sin espacios en los
 * bordes y en mayúsculas. El valor viene de una descripción escrita a mano en el
 * maestro del ERP, y una caja o tilde distinta dejaría pasar (o esconder) todo en
 * silencio.
 */
function normalizarCriterio(v) {
  return String(v ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toUpperCase();
}

/**
 * ¿El ítem está descodificado? (criterio CAT = "DESCODIFICADOS").
 *
 * SOLO SE EXCLUYE EN LLANO. Un descodificado es un producto que se deja de
 * manejar: no tiene sentido reponer Girardota Llano con algo que sale del
 * surtido. Pero en el flujo General sí hay que verlo — es justamente el
 * inventario que conviene sacar del CEDI hacia las tiendas antes de que quede
 * muerto en la bodega.
 *
 * ANTES ESTO SE FILTRABA EN EL QUERY DE SIESA, y por eso no se podía distinguir
 * por flujo: lo que no entra al snapshot no lo ve nadie. El filtro tenía que
 * bajar al backend, donde sí se sabe para qué flujo se está pidiendo.
 *
 * La comparación normaliza mayúsculas y tildes: el valor viene de una
 * descripción escrita a mano en el maestro del ERP, y un "Descodificados" con
 * otra caja dejaría pasar todo sin que nadie lo note.
 */
function esDescodificado(cat) {
  return normalizarCriterio(cat) === "DESCODIFICADOS";
}

/**
 * Productos de un flujo A/B/C (Llano, Machado) — facetado (los ítems que maneja el
 * DESTINO, igual que General) con sugerido A/B/C. La clase sale del criterio CAT del
 * DESTINO (ej. Girardota Llano, 00401) y la capacidad de la tabla
 * `traslados_capacidad` filtrada por ese destino. El nombre conserva "Llano" por
 * historia: el comportamiento es el de cualquier flujo con lógica "abc".
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
    const [rows, capacidades, config, extras] = await Promise.all([
      leerBodegas([origen, destino]),
      // Capacidad DEL DESTINO: Llano y Machado tienen filas separadas (migración 042).
      mapaCapacidades(destino),
      obtenerConfig(),
      // Productos agregados a mano al portafolio de este destino (ver extrasDe).
      extrasDe(destino),
    ]);
    // Cadencias del flujo que se está calculando (config.llano, config.machado…),
    // no las de Llano a ciegas: cada flujo A/B/C las edita por separado. El respaldo
    // a Llano cubre un flujo A/B/C nuevo al que todavía no se le sumó clave en la config.
    const flujo = reglasDe(destino);
    const cadenciasEfectivas = cadencias || config[flujo.id] || config.llano;

    const oMap = new Map();
    const dMap = new Map();
    for (const r of rows) {
      if (r.bodega === origen) oMap.set(String(r.codigo_item), r);
      else if (r.bodega === destino) dMap.set(String(r.codigo_item), r);
    }

    const productos = [];
    // SOLO lo que existe en el DESTINO (Girardota Llano). El panel se pide por
    // destino: tiene que mostrar los productos de esa sede, no el catálogo del
    // origen.
    //
    // Antes esto recorría la UNIÓN origen ∪ destino, y cualquier ítem de
    // Girardota Parque entraba aunque Llano no lo manejara. El filtro de CAT de
    // abajo no lo atajaba: el CAT es del maestro del ítem (no de la bodega), así
    // que si Llano no tenía el ítem se leía el del origen — que es el mismo — y
    // "SIN CLASIFICACION" no es vacío, así que también pasaba.
    //
    // Los AGOTADOS de Llano NO se pierden: el snapshot incluye los ítems en cero
    // (verificado el 28/09/2026: 4132 de 9344 ítems de 00401 con inventario ≤ 0,
    // y por diseño: la consulta no filtra existencia — ver
    // docs/CONSULTA_SNAPSHOT_CONNEKTA.md). Si algún día esa consulta empezara a
    // filtrar `existencia > 0`, este recorrido escondería justo lo que más hay
    // que reponer — revisar esto antes de tocar ese WHERE.
    //
    // Lo que Llano tiene y el origen no se sigue mostrando si Llano lo necesita
    // (necesidad > 0): se puede mandar desde otra sede.
    // Si el flujo exige un plan de criterios (Machado: CAM) y NINGUNA fila del snapshot
    // trae esa clave, la consulta de Connekta registrada no devuelve el plan (o el
    // snapshot es anterior a registrarla): el portafolio saldría vacío y parecería "no
    // hay productos". Se distingue de "este ítem no tiene CAM": `aRegistro` guarda la
    // clave (aunque sea "") cuando la consulta trae la columna, y la omite si no la trae.
    const planObligatorio = flujo.portafolio?.exigirPlanEnSnapshot ? flujo.portafolio.plan : null;
    if (
      planObligatorio &&
      rows.length > 0 &&
      !rows.some((r) => Object.hasOwn(r.criterios || {}, planObligatorio))
    ) {
      return {
        error:
          `El snapshot no trae el plan ${planObligatorio}: registrá la consulta con ` +
          `${planObligatorio} en Connekta y refrescá el snapshot, o ningún ítem de ` +
          `estas bodegas tiene el criterio ${planObligatorio} cargado en SIESA.`,
      };
    }

    const codigos = new Set(dMap.keys());

    // Y ADEMÁS los ítems con capacidad cargada que el destino todavía no registra.
    //
    // SIESA devuelve una fila por (ítem, bodega) solo cuando el ítem se movió
    // alguna vez en esa bodega (docs/CONSULTA_SNAPSHOT_CONNEKTA.md, punto 1). Un
    // producto nuevo queda encerrado en un círculo: Llano no lo tiene, entonces no
    // sale en el panel, entonces nadie se lo despacha, entonces nunca se mueve,
    // entonces Llano nunca lo tiene. Verificado el 20/10/2026 con el 189409 (ARROZ
    // FEDERAL ARTESANO): estaba en las otras seis bodegas y en ninguna de Llano.
    //
    // Cargarle la capacidad en el módulo Capacidad es la decisión humana que rompe
    // el círculo, y es la ÚNICA puerta de entrada por acá: nada entra por tener
    // stock en el origen, que fue justo el agujero que cerró el filtro de arriba.
    // Se piden además dos cosas:
    //   - capacidad > 0, porque con capacidad 0 el sugerido da 0 y la fila no
    //     serviría para nada (y hay filas en 0 a propósito: ver sriCapacidad);
    //   - existencia en el ORIGEN, de donde salen la descripción, el CAT, la UM y
    //     el volumen —el destino no tiene fila de la que leerlos— y de donde sale
    //     lo que realmente se puede mandar.
    for (const [codigo, capRows] of capacidades) {
      if (dMap.has(codigo) || !oMap.has(codigo)) continue;
      if (!capRows.some((r) => num(r.capacidad) > 0)) continue;
      codigos.add(codigo);
    }

    // Y los extras: el portafolio agregado a mano. Van DESPUÉS del bucle de capacidad y
    // ANTES del chequeo de "sin nada que mostrar", así una sede con solo extras (sin
    // snapshot ni capacidad) tampoco da error. No exigen capacidad ni fila en el origen
    // ni en el destino (ver "Portafolio EXTRA" arriba).
    for (const extra of extras) codigos.add(extra);
    const filasCatalogo = await filasDeExtrasSinRegistro(extras, oMap, dMap, destino);

    // Sin NADA que mostrar: ni filas del destino en el snapshot ni capacidad cargada
    // de un ítem que exista en el origen. Una lista vacía con ok:true se lee como "no
    // hay productos", y casi siempre es otra cosa: una bodega que está en flujos.js
    // pero no en el WHERE de la consulta de Connekta (ver
    // docs/CONSULTA_SNAPSHOT_CONNEKTA.md) — la causa más común —, o una sede nueva sin
    // capacidad. Se dice con todas las letras; el controlador lo responde como 502.
    //
    // Este chequeo va DESPUÉS del bucle de capacidad y no antes: una sede NUEVA (Machado)
    // no tiene filas en t400 hasta que se mueva su primer ítem, y con el error antes del
    // bucle nunca podía mostrar productos ni siquiera con la capacidad ya cargada. Con
    // capacidad, el ítem sale con inventario 0 y consumo 0 (sugerido = capacidad, o sea
    // "llenar la góndola"), limitado por lo disponible en el origen.
    if (codigos.size === 0) {
      return {
        error:
          `Sin datos de inventario para la bodega ${destino} en el snapshot. ` +
          "Revisá que la bodega esté en el filtro de la consulta de Connekta; si es una sede " +
          "nueva, cargá su capacidad en el módulo Capacidad y sus productos aparecerán.",
      };
    }

    for (const codigo of codigos) {
      const o = oMap.get(codigo);
      const d = dMap.get(codigo);
      const esExtra = extras.has(codigo);
      // Un extra sin fila en el origen ni en el destino se arma desde el catálogo.
      const fuente = o || d || (esExtra ? filasCatalogo.get(codigo) : undefined);
      if (!fuente) {
        console.warn(
          `[portafolio-extra] ${codigo} está agregado a ${destino} pero no está en el snapshot ni en el catálogo: no se muestra.`,
        );
        continue;
      }

      // La clase A/B/C debe ser la de Girardota Llano (destino, 00401), no la
      // del origen (Girardota Parque). Por eso se lee el CAT del registro `d`.
      // Sin fila en el destino se lee la del origen, que es la misma: el CAT es
      // del maestro del ítem, no de la bodega (ver el punto 2 de la misma doc).
      // `null` si el flujo no clasifica (Machado): ahí no se lee ningún criterio.
      const clase = claseSegunFlujo(flujo, d, o);
      // Portafolio del flujo (config/flujos.js). En Llano: solo ítems clasificados en el
      // CAT (A/B/C o "SIN CLASIFICACION" = Ninguno); los que no tienen NINGUNA
      // clasificación (CAT vacío) no son de Llano → quedan fuera, y los DESCODIFICADOS
      // también: reponer Llano con algo que sale del surtido no tiene sentido (en General
      // sí se muestran, que es donde hay que sacar ese inventario del CEDI antes de que
      // quede muerto; ver `esDescodificado`). En Machado: solo ítems con CAM
      // "PORTAFOLIO ACTIVO MACHADO" y capacidad > 0 — un ítem del Excel sin CAM activo
      // se esconde igual que Llano esconde los que no tienen CAT.
      // Un extra se salta el portafolio completo (CAT/CAM, requiereCapacidad,
      // requiereOrigen): lo agregó un administrador, no lo decide la clasificación.
      if (!esExtra && !pasaPortafolio(flujo, d, o, capacidades.get(codigo))) continue;
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
        // Con clasificación: sugerido A/B/C. Sin ella (Machado): llenar la góndola,
        // capacidad − inventario. El tope por el origen lo expresa `faltante`.
        const necesidad = flujo.clasificacion
          ? calcularSugeridoABC({
              clase,
              capacidad: capacidadBase,
              consumoDiario: consumoDestino,
              inventario: inventarioDestino,
              cadencias: cadenciasEfectivas,
            })
          : calcularSugeridoCapacidad({ capacidad: capacidadBase, inventario: inventarioDestino });
        const sugerido = necesidad;
        const faltante = Math.max(0, necesidad - Math.max(0, Math.floor(disponibleOrigen)));

        // Ítem que no está en el origen: solo tiene sentido si Llano lo necesita.
        // Un extra se muestra SIEMPRE, aun con sugerido 0 y sin origen.
        if (!o && necesidad <= 0 && !esExtra) continue;

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
          criterios: criteriosVisibles(flujo, fuente.criterios),
          inventario_origen: inventarioOrigen,
          disponible_origen: disponibleOrigen,
          inventario_destino: inventarioDestino,
          // El destino no tiene fila en SIESA: el ítem entró por su capacidad
          // cargada. El 0 de arriba no es un inventario medido, es que Llano
          // todavía no maneja el ítem. Se marca para que nadie lea ese 0 como un
          // agotado y para poder explicar por qué apareció.
          sin_registro_destino: !d,
          // Agregado a mano al portafolio de este destino (ver "Portafolio EXTRA").
          portafolio_extra: esExtra,
          // El origen no tiene fila del ítem: su disponible 0 no es un agotado medido,
          // y NO hay de dónde sacar mercancía para despachar.
          sin_registro_origen: !o,
          consumo_destino: consumoDestino,
          dias_inventario: diasInventario,
          necesidad,
          faltante,
          sugerido,
        });
      }
    }

    // Los que se esconden solo por no existir en el origen se informan aparte (no son
    // despachables, pero el usuario tiene que saber que existen). Solo en flujos que
    // exigen origen; Llano y General no reciben el campo.
    if (flujo.portafolio?.requiereOrigen) {
      const ocultos = await ocultosSinOrigen({ flujo, origen, destino, oMap, dMap, capacidades, extras });
      return { data: productos, ocultos_sin_origen: ocultos };
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
      mapaCapacidades(destino),
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
      // Misma regla de clasificación que el panel: Machado no clasifica y NO lee CAT.
      const clase = claseSegunFlujo(flujo, d, null);
      const capRows = capacidades.get(String(codigo)) || [];
      const umRows = capRows.filter((r) => r.unidad && r.factor);
      const cr = umRows[0] || capRows.find((r) => !r.unidad) || null;
      const capacidad = (cr?.capacidad || 0) * (cr?.factor || 1); // en base
      necesidad = flujo.clasificacion
        ? calcularSugeridoABC({
            clase,
            capacidad,
            consumoDiario: consumoDestino,
            inventario: inventarioDestino,
            cadencias: config[flujo.id] || config.llano,
          })
        : calcularSugeridoCapacidad({ capacidad, inventario: inventarioDestino });
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
async function conFactores(f120_id, umsCrudas, destino) {
  let porCapacidad = new Map();
  try {
    // Los factores de UM viven en la capacidad POR DESTINO (migración 042): el P15 de
    // Machado puede no ser el de Llano. Sin destino se lee el por defecto (Llano).
    porCapacidad = await factoresDeItem(f120_id, destino);
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
 * @param {string} [destino] - bodega destino A/B/C cuyos factores de UM se leen
 *   (ausente = Llano, el comportamiento anterior a Machado).
 */
export async function resolverCodigoBarras(codigo, destino) {
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
        ...(await conFactores(eanMatch.f120_id, [eanMatch.unidad_medida].filter(Boolean), destino)),
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
      ...(await conFactores(limpio, unidades.length > 0 ? unidades : ["UND"], destino)),
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

  // PASO 0 — ¿YA ES UN CÓDIGO SIESA? Entonces NO se vuelve a resolver.
  //
  // Los dos que llaman a esta función casi siempre mandan un f120_id ya resuelto
  // (el controller de /codigos-barras y el auditor al agregar fuera de lista).
  // Pasarlo otra vez por `resolverCodigoBarras` lo trataba como código de barras,
  // y hay códigos de barras cortos que son el NÚMERO de otro ítem: el EAN del
  // JABON JOHNSONS BABY ORIGINAL resuelve a 17899, y "17899" es el barras del
  // EXPRIMIDOR NARANJA (175559). Bodega veía un exprimidor al escanear un jabón,
  // y el auditor GUARDABA el renglón con el código del exprimidor.
  let codigoItem = null;
  try {
    const idNumerico = Number(crudo);
    if (Number.isInteger(idNumerico)) {
      const { data: existente } = await supabase
        .from("items_siesa")
        .select("f120_id")
        .eq("f120_id", idNumerico)
        .limit(1)
        .maybeSingle();
      if (existente) codigoItem = crudo;
    }
  } catch {
    // Si el maestro no responde, se resuelve como antes.
  }

  if (!codigoItem) {
    codigoItem = crudo;
    try {
      const resuelto = await resolverCodigoBarras(crudo);
      if (resuelto?.f120_id) codigoItem = String(resuelto.f120_id).trim();
    } catch {
      // Se sigue con el código crudo: el paso 2 igual puede reconocerlo.
    }
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


