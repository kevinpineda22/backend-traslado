import { test, mock, before } from "node:test";
import assert from "node:assert/strict";
import { crearBD } from "./helpers/fakeSupabase.js";

/* =============================================================================
   Comparación de capacidad SRI vs. traslados_capacidad (dry-run).

   Se prueba SIN red y SIN Supabase real:
     - la comparación es una función pura, así que se alimenta con datos;
     - el cliente HTTP recibe un `fetch` falso;
     - la tabla es el Supabase en memoria de los otros tests.

   Lo más importante de cubrir es la conversión: SRI entrega capacidad en
   unidades BASE y nuestra tabla guarda la capacidad EN LA UM. Un error acá
   cambia el sugerido A/B/C de traslados reales.
   ============================================================================= */

let compararCapacidad;
let compararConSri;
let aplicarConSri;
let obtenerItemsSri;
let calcularFaltantes;
let faltantesConSri;
let crearFaltantesConSri;
let bd;

before(async () => {
  bd = crearBD({ traslados_capacidad: [] });
  mock.module("../src/config/supabase.js", { exports: { supabase: bd.supabase } });
  ({
    compararCapacidad,
    compararConSri,
    aplicarConSri,
    obtenerItemsSri,
    calcularFaltantes,
    faltantesConSri,
    crearFaltantesConSri,
  } = await import(
    "../src/services/sriCapacidad.service.js"
  ));
});

/** Ítem de SRI con una sola unidad de medida, con lo mínimo que se lee. */
const itemSri = (item, entradas, descripcion = `ITEM ${item}`) => ({
  item,
  descripcion,
  // SRI PARTICIONA por ubicación: el total del ítem es la suma de las rebanadas.
  capacidad_total_tienda: entradas.reduce((acc, e) => acc + e.capacidad_total, 0),
  capacidades_por_unidad_medida: entradas.map((e) => ({
    cantidad_ubicaciones: 1,
    factor_variable: false,
    ...e,
  })),
});

const entrada = (unidad_medida, capacidad_total, factor_um) => ({
  unidad_medida,
  capacidad_total,
  factor_um,
  factor_min: factor_um,
  factor_max: factor_um,
});

const filaNuestra = (codigo_item, unidad, capacidad, factor, extra = {}) => ({
  codigo_item,
  unidad,
  capacidad,
  factor,
  descripcion: `NUESTRO ${codigo_item}`,
  fijo: false,
  ...extra,
});

/* ---------------------------------------------------------------------------
   Conversión
   --------------------------------------------------------------------------- */

test("convierte unidades base a la UM: 900 con factor 15 propone 60", () => {
  const r = compararCapacidad(
    [itemSri("25588", [entrada("P15", 900, 15)])],
    [filaNuestra("25588", "P15", 40, 15)],
  );
  assert.equal(r.cambios.length, 1);
  assert.deepEqual(r.cambios[0], {
    codigo_item: "25588",
    descripcion: "NUESTRO 25588",
    unidad: "P15",
    capacidad_actual: 40,
    capacidad_propuesta: 60,
    diferencia: 20,
    factor: 15,
  });
  assert.equal(r.resumen.cambiarian, 1);
});

test("la fila base usa factor 1 aunque no tenga factor guardado", () => {
  const r = compararCapacidad(
    [itemSri("19", [entrada("UND", 300, 1)])],
    [filaNuestra("19", "", 100, null)],
  );
  assert.equal(r.cambios[0].capacidad_propuesta, 300);
  assert.equal(r.cambios[0].factor, 1);
});

test("ítem de una sola rebanada UND: la propuesta sigue siendo esa rebanada", () => {
  const r = compararCapacidad(
    [itemSri("19", [entrada("UND", 300, 1)])],
    [filaNuestra("19", "", 100, null)],
  );
  assert.equal(r.cambios.length, 1);
  assert.equal(r.cambios[0].unidad, "");
  assert.equal(r.cambios[0].capacidad_propuesta, 300);
  assert.equal(r.saltados.length, 0);
  assert.equal(r.avisos.length, 0); // una sola rebanada: no hay total consolidado
});

/* ---------------------------------------------------------------------------
   Fila base = TOTAL del ítem (SRI particiona por ubicación)
   --------------------------------------------------------------------------- */

// Caso real 901 "SALCHICHAS ZENU VIENA TRAD X 150 GR": 54 (P3) + 36 (UND) = 90.
const item901 = () => itemSri("901", [entrada("P3", 54, 3), entrada("UND", 36, 1)]);

test("caso 901: la fila base con el total correcto (90) NO genera cambio", () => {
  const r = compararCapacidad([item901()], [filaNuestra("901", "", 90, null)]);
  assert.equal(item901().capacidad_total_tienda, 90);
  assert.equal(r.cambios.length, 0);
  assert.equal(r.resumen.iguales, 1);
});

test("caso 901: la fila base en 36 propone 90 (el total), no 36 (la rebanada UND)", () => {
  const r = compararCapacidad([item901()], [filaNuestra("901", "", 36, null)]);
  assert.equal(r.cambios.length, 1);
  assert.equal(r.cambios[0].capacidad_propuesta, 90);
  assert.equal(r.cambios[0].diferencia, 54);
});

test("ítem con varias rebanadas genera el aviso de total consolidado", () => {
  const r = compararCapacidad([item901()], [filaNuestra("901", "", 36, null)]);
  const aviso = r.avisos.find((a) => /SUMA/.test(a.aviso));
  assert.ok(aviso);
  assert.equal(aviso.codigo_item, "901");
  // "unidades de medida" y NO "ubicaciones": el número son rebanadas por UM, y
  // cada una puede abarcar varias ubicaciones físicas (SRI las cuenta aparte en
  // `cantidad_ubicaciones`). El aviso lo lee una persona que va a comparar ese
  // número contra las góndolas, así que la palabra importa.
  assert.match(aviso.aviso, /2 unidades de medida distintas/);
  assert.match(aviso.aviso, /P3, UND/);
  // Ese aviso sobrevive al recorte porque esta fila SÍ cambia (36 -> 90).
  assert.equal(r.cambios.length, 1);
});

test("el aviso de total consolidado NO sale si esa fila no cambia", () => {
  // Mismo ítem, pero ya con la capacidad correcta: no hay nada propuesto, así que
  // un aviso que habla de "la capacidad propuesta" estaría describiendo algo que no
  // está pasando. Es lo que llenaba la pantalla de 36 avisos sobre 2 cambios.
  const r = compararCapacidad([item901()], [filaNuestra("901", "", 90, null)]);
  assert.equal(r.cambios.length, 0);
  assert.equal(r.resumen.iguales, 1);
  assert.deepEqual(r.avisos, []);
});

test("un factor discrepante SÍ sale aunque la fila no cambie: habla del dato, no de la propuesta", () => {
  // Guarda de regresión del recorte de avisos. El factor nuestro (15) y el de SRI
  // (12) no coinciden, y eso hay que saberlo aunque la capacidad ya esté bien.
  const r = compararCapacidad(
    [itemSri("25588", [entrada("P15", 900, 12)])],
    [filaNuestra("25588", "P15", 60, 15)],
  );
  assert.equal(r.cambios.length, 0, "900/15 = 60, que es lo que ya tenemos");
  assert.equal(r.avisos.length, 1);
  assert.equal(r.avisos[0].tipo, "factor_discrepante");
});

test("SRI solo con rebanadas con UM (sin UND) y nosotros solo con fila base: compara contra el total", () => {
  const r = compararCapacidad(
    [itemSri("77", [entrada("P6", 60, 6), entrada("P12", 120, 12)])],
    [filaNuestra("77", "", 100, null)],
  );
  assert.ok(!r.saltados.some((s) => s.motivo === "solo_nuestros"));
  assert.equal(r.resumen.solo_nuestros, 0);
  assert.equal(r.cambios.length, 1);
  assert.equal(r.cambios[0].capacidad_propuesta, 180);
});

test("una fila nuestra con unidad 'UND' literal matchea la rebanada UND por nombre", () => {
  const r = compararCapacidad(
    [item901()],
    [filaNuestra("901", "", 90, null), filaNuestra("901", "UND", 10, 1)],
  );
  assert.equal(r.cambios.length, 1);
  assert.equal(r.cambios[0].unidad, "UND");
  assert.equal(r.cambios[0].capacidad_propuesta, 36); // la rebanada, no el total
  assert.equal(r.resumen.iguales, 1); // la fila base contra el total
});

test("la rebanada UND sin fila 'UND' nuestra no se reporta como solo_en_sri", () => {
  const r = compararCapacidad([item901()], [filaNuestra("901", "", 90, null)]);
  assert.ok(!r.saltados.some((s) => s.unidad === "UND"));
});

/* ---------------------------------------------------------------------------
   fijo
   --------------------------------------------------------------------------- */

test("fijo en CUALQUIERA de las filas salta el ítem entero", () => {
  const r = compararCapacidad(
    [itemSri("25588", [entrada("P15", 900, 15), entrada("UND", 2076, 1)])],
    [
      filaNuestra("25588", "", 10, null, { fijo: false }),
      filaNuestra("25588", "P15", 10, 15, { fijo: true }),
    ],
  );
  assert.equal(r.cambios.length, 0);
  assert.equal(r.saltados.length, 2);
  assert.ok(r.saltados.every((s) => s.motivo === "fijo"));
  assert.equal(r.resumen.saltados_fijo, 2);
});

/* ---------------------------------------------------------------------------
   sin_factor
   --------------------------------------------------------------------------- */

test("fila con UM sin factor se salta como sin_factor, sin NaN ni división por cero", () => {
  for (const factor of [null, undefined, 0, "abc"]) {
    const r = compararCapacidad(
      [itemSri("7", [entrada("P6", 600, 6)])],
      [filaNuestra("7", "P6", 10, factor)],
    );
    assert.equal(r.cambios.length, 0, `factor=${factor}`);
    assert.deepEqual(r.saltados, [
      { codigo_item: "7", descripcion: "NUESTRO 7", unidad: "P6", motivo: "sin_factor" },
    ]);
    assert.equal(r.resumen.sin_factor, 1);
    assert.ok(!JSON.stringify(r).includes("NaN"));
    assert.ok(!JSON.stringify(r).includes("Infinity"));
  }
});

/* ---------------------------------------------------------------------------
   solo_en_sri / solo_nuestros
   --------------------------------------------------------------------------- */

test("clasifica solo_en_sri y solo_nuestros con su propio motivo", () => {
  const r = compararCapacidad(
    [itemSri("100", [entrada("UND", 50, 1)]), itemSri("1", [entrada("UND", 5, 1)])],
    [filaNuestra("1", "", 5, null), filaNuestra("200", "", 30, null)],
  );
  const motivos = Object.fromEntries(r.saltados.map((s) => [s.codigo_item, s.motivo]));
  assert.deepEqual(motivos, { 100: "solo_en_sri", 200: "solo_nuestros" });
  assert.equal(r.resumen.solo_en_sri, 1);
  assert.equal(r.resumen.solo_nuestros, 1);
  assert.equal(r.resumen.items_sri, 2);
  assert.equal(r.resumen.items_nuestros, 2);
});

test("una UM que SRI trae y nosotros no es solo_en_sri aunque el ítem exista", () => {
  // Total del ítem = 10 (UND) + 60 (P6) = 70, que es lo que guarda la fila base.
  const r = compararCapacidad(
    [itemSri("5", [entrada("UND", 10, 1), entrada("P6", 60, 6)])],
    [filaNuestra("5", "", 70, null)],
  );
  assert.deepEqual(
    r.saltados.map((s) => [s.unidad, s.motivo]),
    [["P6", "solo_en_sri"]],
  );
  assert.equal(r.resumen.iguales, 1);
});

/* ---------------------------------------------------------------------------
   Avisos
   --------------------------------------------------------------------------- */

test("factor discrepante genera aviso pero NO bloquea el cambio y se divide con el nuestro", () => {
  const r = compararCapacidad(
    [itemSri("9", [entrada("P15", 900, 12)])],
    [filaNuestra("9", "P15", 10, 15)],
  );
  assert.equal(r.cambios.length, 1);
  assert.equal(r.cambios[0].capacidad_propuesta, 60); // 900 / 15, no 900 / 12
  assert.equal(r.cambios[0].factor, 15);
  assert.equal(r.resumen.factor_discrepante, 1);
  assert.equal(r.avisos.length, 1);
  assert.match(r.avisos[0].aviso, /discrepante/i);
});

test("factor_variable va a avisos", () => {
  const r = compararCapacidad(
    [itemSri("9", [{ ...entrada("P15", 900, 15), factor_variable: true, factor_min: 12, factor_max: 15 }])],
    [filaNuestra("9", "P15", 10, 15)],
  );
  assert.equal(r.cambios.length, 1);
  assert.ok(r.avisos.some((a) => /variable/i.test(a.aviso)));
});

test("capacidad_total 0 en SRI va a avisos y no se propone pisar con 0", () => {
  const r = compararCapacidad(
    [itemSri("9", [entrada("UND", 0, 1)])],
    [filaNuestra("9", "", 50, null)],
  );
  assert.equal(r.cambios.length, 0);
  assert.equal(r.resumen.sin_capacidad_sri, 1);
  assert.ok(r.avisos.some((a) => /capacidad_total 0/.test(a.aviso)));
});

test("una propuesta no entera genera aviso", () => {
  const r = compararCapacidad(
    [itemSri("9", [entrada("P15", 100, 15)])],
    [filaNuestra("9", "P15", 1, 15)],
  );
  assert.equal(r.cambios[0].capacidad_propuesta, 6.6667);
  assert.ok(r.avisos.some((a) => /no es entera/.test(a.aviso)));
});

/* ---------------------------------------------------------------------------
   Normalización de códigos e iguales
   --------------------------------------------------------------------------- */

test("códigos con ceros a la izquierda matchean contra SRI", () => {
  const r = compararCapacidad(
    [itemSri("19", [entrada("UND", 300, 1)])],
    [filaNuestra("0000019", "", 100, null)],
  );
  assert.equal(r.saltados.length, 0);
  assert.equal(r.cambios.length, 1);
  // Se reporta el código real de la fila, que es la clave primaria.
  assert.equal(r.cambios[0].codigo_item, "0000019");
});

test("capacidades iguales no entran en cambios y se cuentan como iguales", () => {
  const r = compararCapacidad(
    [itemSri("25588", [entrada("P15", 900, 15)])],
    [filaNuestra("25588", "P15", 60, 15)],
  );
  assert.equal(r.cambios.length, 0);
  assert.equal(r.resumen.iguales, 1);
  assert.equal(r.resumen.cambiarian, 0);
});

test("el reporte trae la forma acordada", () => {
  const r = compararCapacidad([], [], { tienda: "GIRARDOTA LLANO", ahora: new Date("2026-01-02T03:04:05Z") });
  assert.equal(r.ok, true);
  assert.equal(r.tienda, "GIRARDOTA LLANO");
  assert.equal(r.consultado_en, "2026-01-02T03:04:05.000Z");
  assert.deepEqual(Object.keys(r.resumen).sort(), [
    "cambiarian",
    "factor_discrepante",
    "iguales",
    "items_nuestros",
    "items_sri",
    "saltados_fijo",
    "sin_capacidad_sri",
    "sin_factor",
    "solo_en_sri",
    "solo_nuestros",
  ]);
});

/* ---------------------------------------------------------------------------
   Cliente HTTP con fetch falso
   --------------------------------------------------------------------------- */

const respuesta = (status, cuerpo) => ({ ok: status >= 200 && status < 300, status, json: async () => cuerpo });
const pagina = (items, total_paginas) => respuesta(200, { ok: true, data: { items, total_paginas } });

test("falla con un mensaje accionable si falta el token, sin llamar a la red", async () => {
  const previo = process.env.SRI_CAPACIDAD_TOKEN;
  delete process.env.SRI_CAPACIDAD_TOKEN;
  let llamadas = 0;
  try {
    await assert.rejects(
      obtenerItemsSri({ fetchImpl: async () => { llamadas += 1; } }),
      /SRI_CAPACIDAD_TOKEN/,
    );
    assert.equal(llamadas, 0);
  } finally {
    if (previo !== undefined) process.env.SRI_CAPACIDAD_TOKEN = previo;
  }
});

test("recorre todas las páginas, manda el token solo en el header y GET", async () => {
  process.env.SRI_CAPACIDAD_TOKEN = "token-secreto-de-prueba";
  const pedidas = [];
  const fetchImpl = async (url, init) => {
    pedidas.push({ url: String(url), init });
    const p = Number(new URL(url).searchParams.get("pagina"));
    return pagina([{ item: String(p) }], 3);
  };
  const items = await obtenerItemsSri({ tienda: "GIRARDOTA LLANO", fetchImpl });
  assert.deepEqual(items.map((i) => i.item), ["1", "2", "3"]);
  assert.equal(pedidas.length, 3);
  for (const p of pedidas) {
    assert.equal(p.init.method, "GET");
    assert.equal(p.init.headers["X-API-Key"], "token-secreto-de-prueba");
    assert.ok(!p.url.includes("token-secreto-de-prueba"));
    assert.equal(new URL(p.url).searchParams.get("limite"), "500");
    assert.equal(new URL(p.url).searchParams.get("tienda"), "GIRARDOTA LLANO");
  }
});

test("un total_paginas corrupto no cuelga el proceso", async () => {
  process.env.SRI_CAPACIDAD_TOKEN = "token-secreto-de-prueba";
  let llamadas = 0;
  await assert.rejects(
    obtenerItemsSri({ fetchImpl: async () => { llamadas += 1; return pagina([], 999999999); } }),
    /tope de seguridad/,
  );
  assert.equal(llamadas, 1);
});

test("traduce el 401 a un mensaje sobre el token, sin filtrarlo", async () => {
  process.env.SRI_CAPACIDAD_TOKEN = "token-secreto-de-prueba";
  await assert.rejects(
    obtenerItemsSri({ fetchImpl: async () => respuesta(401, { ok: false, error: { codigo: "UNAUTHORIZED" } }) }),
    (err) => {
      assert.match(err.message, /token.*(mal|vencido)/i);
      assert.ok(!err.message.includes("token-secreto-de-prueba"));
      assert.equal(err.statusCode, 502);
      return true;
    },
  );
});

test("una respuesta con otra forma falla fuerte en lugar de dar un reporte vacío", async () => {
  process.env.SRI_CAPACIDAD_TOKEN = "token-secreto-de-prueba";
  await assert.rejects(
    obtenerItemsSri({ fetchImpl: async () => respuesta(200, { ok: true, data: { otra: [] } }) }),
    /forma esperada/,
  );
});

/* ---------------------------------------------------------------------------
   Orquestación: lee la tabla real (en memoria) y NO escribe
   --------------------------------------------------------------------------- */

test("compararConSri lee fijo de la tabla y no hace ninguna escritura", async () => {
  process.env.SRI_CAPACIDAD_TOKEN = "token-secreto-de-prueba";
  bd.tablas.traslados_capacidad = [
    { codigo_item: "0000019", unidad: "", capacidad: 100, factor: null, fijo: false, descripcion: "A" },
    { codigo_item: "21", unidad: "", capacidad: 5, factor: null, fijo: true, descripcion: "B" },
  ];
  bd.log.length = 0;

  const fetchImpl = async () =>
    pagina(
      [itemSri("19", [entrada("UND", 300, 1)]), itemSri("21", [entrada("UND", 999, 1)])],
      1,
    );
  const r = await compararConSri({ fetchImpl });

  assert.equal(r.tienda, "GIRARDOTA LLANO");
  assert.deepEqual(r.cambios.map((c) => c.capacidad_propuesta), [300]);
  assert.deepEqual(r.saltados.map((s) => s.motivo), ["fijo"]);

  assert.ok(bd.log.length > 0);
  assert.ok(bd.log.every((op) => op.op === "select"), "solo debe haber lecturas");
  assert.equal(bd.tablas.traslados_capacidad[0].capacidad, 100, "la tabla no cambió");
});

/* ---------------------------------------------------------------------------
   POST /aplicar: la única ruta que escribe
   --------------------------------------------------------------------------- */

// Tabla con `n` ítems que SRI quiere cambiar de 10 a 20, más ruido que NO debe
// tocarse: uno igual, uno fijo (SRI lo mide distinto) y uno que SRI no conoce.
function escenarioAplicar(n) {
  const filas = [];
  const items = [];
  for (let i = 1; i <= n; i += 1) {
    const codigo = String(1000 + i);
    filas.push({ codigo_item: codigo, unidad: "", capacidad: 10, factor: null, fijo: false, descripcion: `D${codigo}`, updated_at: "viejo" });
    items.push(itemSri(codigo, [entrada("UND", 20, 1)]));
  }
  filas.push({ codigo_item: "5001", unidad: "", capacidad: 7, factor: null, fijo: false, descripcion: "IGUAL", updated_at: "viejo" });
  items.push(itemSri("5001", [entrada("UND", 7, 1)]));
  filas.push({ codigo_item: "5002", unidad: "", capacidad: 3, factor: null, fijo: true, descripcion: "FIJO", updated_at: "viejo" });
  items.push(itemSri("5002", [entrada("UND", 99, 1)]));
  filas.push({ codigo_item: "5003", unidad: "", capacidad: 4, factor: null, fijo: false, descripcion: "SOLO NUESTRO", updated_at: "viejo" });
  bd.tablas.traslados_capacidad = filas;
  bd.log.length = 0;
  bd.hooks.antesDe = null;
  process.env.SRI_CAPACIDAD_TOKEN = "token-secreto-de-prueba";
  return { fetchImpl: async () => pagina(items, 1) };
}

const escrituras = () => bd.log.filter((op) => op.op !== "select");

test("aplicar sin `esperados` responde 400 y no escribe", async () => {
  const { fetchImpl } = escenarioAplicar(3);
  for (const esperados of [undefined, null, "3", 3.5, -1]) {
    await assert.rejects(aplicarConSri({ esperados, fetchImpl }), (err) => {
      assert.equal(err.statusCode, 400);
      return true;
    });
  }
  assert.equal(escrituras().length, 0);
});

test("aplicar con `esperados` que no coincide responde 409 nombrando ambos números y no escribe", async () => {
  const { fetchImpl } = escenarioAplicar(3);
  await assert.rejects(aplicarConSri({ esperados: 5, fetchImpl }), (err) => {
    assert.equal(err.statusCode, 409);
    assert.match(err.message, /5/);
    assert.match(err.message, /3/);
    return true;
  });
  assert.equal(escrituras().length, 0);
  assert.ok(bd.tablas.traslados_capacidad.every((f) => f.updated_at === "viejo"));
});

test("aplicar con `esperados` correcto escribe exactamente las filas de `cambios` y ninguna más", async () => {
  const { fetchImpl } = escenarioAplicar(3);
  const antes = structuredClone(bd.tablas.traslados_capacidad);
  const r = await aplicarConSri({ esperados: 3, fetchImpl });

  assert.equal(r.ok, true);
  assert.equal(r.esperados, 3);
  assert.equal(r.aplicados, 3);
  assert.deepEqual(r.fallidos, []);
  assert.deepEqual(r.escritos, [
    { codigo_item: "1001", unidad: "", capacidad_anterior: 10, capacidad_nueva: 20 },
    { codigo_item: "1002", unidad: "", capacidad_anterior: 10, capacidad_nueva: 20 },
    { codigo_item: "1003", unidad: "", capacidad_anterior: 10, capacidad_nueva: 20 },
  ]);
  assert.equal(r.resumen.cambiarian, 3);
  assert.equal(escrituras().length, 3);

  for (const fila of bd.tablas.traslados_capacidad) {
    const previa = antes.find((a) => a.codigo_item === fila.codigo_item);
    if (["1001", "1002", "1003"].includes(fila.codigo_item)) {
      assert.equal(fila.capacidad, 20);
      assert.notEqual(fila.updated_at, "viejo");
      // Solo cambian `capacidad` y `updated_at`.
      assert.deepEqual({ ...fila, capacidad: 0, updated_at: 0 }, { ...previa, capacidad: 0, updated_at: 0 });
    } else {
      assert.deepEqual(fila, previa, `la fila ${fila.codigo_item} no debía tocarse`);
    }
  }
});

test("aplicar aborta sin escribir NADA si un cambio cae sobre un ítem con fijo = true", async () => {
  const { fetchImpl } = escenarioAplicar(3);
  // La comparación real nunca produce esto; se fuerza con un `comparar` roto que
  // incluye el ítem fijo 5002 (con ceros a la izquierda) entre los cambios.
  const comparar = async ({ filas }) => {
    const real = await compararConSri({ fetchImpl, filas });
    return {
      ...real,
      cambios: [
        ...real.cambios,
        { codigo_item: "0005002", descripcion: "FIJO", unidad: "", capacidad_actual: 3, capacidad_propuesta: 99, diferencia: 96, factor: 1 },
      ],
    };
  };
  await assert.rejects(aplicarConSri({ esperados: 4, fetchImpl, comparar }), (err) => {
    assert.equal(err.statusCode, 500);
    assert.match(err.message, /0005002/);
    return true;
  });
  assert.equal(escrituras().length, 0);
  assert.equal(bd.tablas.traslados_capacidad.find((f) => f.codigo_item === "5002").capacidad, 3);
  assert.ok(bd.tablas.traslados_capacidad.every((f) => f.updated_at === "viejo"));
});

test("aplicar escribe ~120 cambios en tandas de 50 y los escribe todos", async () => {
  const { fetchImpl } = escenarioAplicar(120);
  const r = await aplicarConSri({ esperados: 120, fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.aplicados, 120);
  assert.equal(r.escritos.length, 120);
  assert.equal(escrituras().length, 120);
  assert.equal(bd.tablas.traslados_capacidad.filter((f) => f.capacidad === 20).length, 120);
  // Las que no eran cambio siguen igual.
  assert.deepEqual(
    bd.tablas.traslados_capacidad.filter((f) => f.codigo_item >= "5000").map((f) => [f.codigo_item, f.capacidad]),
    [["5001", 7], ["5002", 3], ["5003", 4]],
  );
});

test("aplicar frena en la tanda que falla y reporta lo escrito y lo fallido", async () => {
  const { fetchImpl } = escenarioAplicar(120);
  let updates = 0;
  // La primera escritura de la 2.ª tanda (la n.º 51) falla como fallaría PostgREST.
  bd.hooks.antesDe = async (_tabla, op) => {
    if (op !== "update") return null;
    updates += 1;
    return updates === 51 ? { error: { message: "conexión caída" } } : null;
  };
  const r = await aplicarConSri({ esperados: 120, fetchImpl });
  bd.hooks.antesDe = null;

  assert.equal(r.ok, false);
  assert.equal(r.fallidos.length, 1);
  assert.equal(r.fallidos[0].codigo_item, "1051");
  assert.match(r.fallidos[0].motivo, /conexión caída/);
  assert.equal(r.aplicados, 99); // 50 de la 1.ª tanda + 49 de la 2.ª
  assert.equal(r.escritos.length, 99);
  assert.equal(r.no_intentados, 20); // la 3.ª tanda no se intentó
  assert.equal(updates, 100, "no debe seguir escribiendo tras la tanda fallida");
  assert.equal(bd.tablas.traslados_capacidad.filter((f) => f.capacidad === 20).length, 99);
});

test("aplicar vía controlador: 400 sin esperados y 500 con el detalle si una tanda falla", async () => {
  const { aplicar } = await import("../src/controllers/sriCapacidad.controller.js");
  const respuestaFalsa = () => {
    const res = { codigo: 200 };
    res.status = (c) => ((res.codigo = c), res);
    res.json = (b) => ((res.cuerpo = b), res);
    return res;
  };

  const { fetchImpl } = escenarioAplicar(2);
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl; // el controlador no inyecta fetch: no se toca la red real
  try {
    let error;
    await aplicar({ body: {} }, respuestaFalsa(), (e) => (error = e));
    assert.equal(error.statusCode, 400);
    assert.equal(escrituras().length, 0);

    bd.hooks.antesDe = async (_t, op) => (op === "update" ? { error: { message: "falla" } } : null);
    const res = respuestaFalsa();
    await aplicar({ body: { esperados: 2 } }, res, (e) => assert.fail(e.message));
    bd.hooks.antesDe = null;
    assert.equal(res.codigo, 500);
    assert.equal(res.cuerpo.ok, false);
    assert.equal(res.cuerpo.fallidos.length, 2);
  } finally {
    globalThis.fetch = original;
  }
});

/* ---------------------------------------------------------------------------
   /comparar sigue siendo de solo lectura
   --------------------------------------------------------------------------- */

test("GET /comparar no escribe; /aplicar y /crear son las únicas rutas que mutan", async () => {
  const { comparar } = await import("../src/controllers/sriCapacidad.controller.js");
  const { default: router } = await import("../src/routes/sriCapacidad.routes.js");

  const { fetchImpl } = escenarioAplicar(5);
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    let cuerpo;
    await comparar({ query: {} }, { json: (b) => (cuerpo = b) }, (e) => assert.fail(e.message));
    assert.equal(cuerpo.cambios.length, 5);
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(escrituras().length, 0);
  assert.ok(bd.tablas.traslados_capacidad.every((f) => f.updated_at === "viejo"));

  const rutas = router.stack
    .filter((l) => l.route)
    .flatMap((l) => Object.keys(l.route.methods).map((m) => `${m.toUpperCase()} ${l.route.path}`))
    .sort();
  assert.deepEqual(rutas, ["GET /comparar", "GET /faltantes", "POST /aplicar", "POST /crear"]);
});

/* ---------------------------------------------------------------------------
   Faltantes: ítems de SRI sin NINGUNA fila nuestra (función pura)
   --------------------------------------------------------------------------- */

test("faltantes: ítem sin filas y con total válido se crea como fila base con el total", () => {
  const r = calcularFaltantes({
    itemsSri: [itemSri("500", [entrada("UND", 40, 1)], "ITEM NUEVO")],
    filasNuestras: [],
    tienda: "GIRARDOTA LLANO",
  });
  assert.deepEqual(r.crear, [{ codigo_item: "500", descripcion: "ITEM NUEVO", unidad: "", capacidad: 40 }]);
  assert.deepEqual(r.omitidos, []);
  assert.deepEqual(r.resumen, {
    items_sri: 1,
    items_nuestros: 0,
    crearian: 1,
    sin_capacidad_sri: 0,
    ya_existen: 0,
  });
  assert.equal(r.tienda, "GIRARDOTA LLANO");
});

test("faltantes: un ítem con fila base NO se crea y cuenta en ya_existen", () => {
  const r = calcularFaltantes({
    itemsSri: [itemSri("19", [entrada("UND", 300, 1)])],
    filasNuestras: [filaNuestra("19", "", 100, null)],
  });
  assert.deepEqual(r.crear, []);
  assert.equal(r.resumen.ya_existen, 1);
  assert.equal(r.resumen.crearian, 0);
});

test("faltantes: un ítem con SOLO una fila con UM (sin base) NO se crea: es del flujo comparar", () => {
  const r = calcularFaltantes({
    itemsSri: [itemSri("25588", [entrada("P15", 900, 15)])],
    filasNuestras: [filaNuestra("25588", "P15", 40, 15)],
  });
  assert.deepEqual(r.crear, []);
  assert.deepEqual(r.omitidos, []);
  assert.equal(r.resumen.ya_existen, 1);
});

test("faltantes: total 0, negativo, ausente o ilegible se omite con sin_capacidad_sri", () => {
  const sin = (item, total) => ({ item, descripcion: `D${item}`, capacidad_total_tienda: total, capacidades_por_unidad_medida: [] });
  const r = calcularFaltantes({
    itemsSri: [sin("1", 0), sin("2", -5), sin("3", undefined), sin("4", "abc"), sin("5", null), sin("6", NaN)],
    filasNuestras: [],
  });
  assert.deepEqual(r.crear, []);
  assert.equal(r.omitidos.length, 6);
  assert.ok(r.omitidos.every((o) => o.motivo === "sin_capacidad_sri"));
  assert.equal(r.resumen.sin_capacidad_sri, 6);
  assert.equal(r.resumen.crearian, 0);
});

test("faltantes: un ítem medido en varias UM genera UNA sola fila base con el TOTAL", () => {
  const r = calcularFaltantes({
    itemsSri: [itemSri("901", [entrada("P3", 54, 3), entrada("UND", 36, 1)])],
    filasNuestras: [],
  });
  assert.equal(r.crear.length, 1);
  assert.deepEqual(r.crear[0], { codigo_item: "901", descripcion: "ITEM 901", unidad: "", capacidad: 90 });
  assert.ok(r.crear.every((c) => c.unidad === ""), "nunca una fila con UM");
});

test("faltantes: sin `capacidad_total_tienda` legible, suma las rebanadas como la comparación", () => {
  // SRI particiona por ubicación, así que la suma de las rebanadas ES el total. Si
  // acá se omitiera el ítem, quedaría afuera de este flujo y adentro del de
  // comparar, que sí hace este respaldo.
  const sinTotal = (item, entradas, total) => ({
    item,
    descripcion: `D${item}`,
    capacidad_total_tienda: total,
    capacidades_por_unidad_medida: entradas,
  });
  const r = calcularFaltantes({
    itemsSri: [
      sinTotal("50", [entrada("P3", 54, 3), entrada("UND", 36, 1)], undefined),
      sinTotal("51", [entrada("UND", 12, 1)], ""),
      sinTotal("52", [entrada("UND", 7, 1)], "abc"),
    ],
    filasNuestras: [],
  });
  assert.deepEqual(
    r.crear.map((c) => [c.codigo_item, c.capacidad]),
    [["50", 90], ["51", 12], ["52", 7]],
  );
  assert.equal(r.resumen.sin_capacidad_sri, 0);
  assert.ok(r.crear.every((c) => c.unidad === ""), "sigue siendo solo fila base");
});

test("el total de SRI se lee IGUAL en los dos flujos: una unidad repetida no cuenta doble", () => {
  // Sin total declarado, el total sale de sumar las rebanadas. Si SRI repitiera la
  // misma unidad dentro del ítem, sumar el arreglo crudo daría 120 en lugar de 60 e
  // inflaría la capacidad. `totalTiendaSri` deduplica por unidad, y los DOS flujos
  // tienen que llegar al mismo número: comparar lo usa para la fila base y faltantes
  // para la fila que crea.
  const item = {
    item: "70",
    descripcion: "UNIDAD REPETIDA",
    capacidades_por_unidad_medida: [entrada("P6", 60, 6), entrada("P6", 60, 6)],
  };

  const f = calcularFaltantes({ itemsSri: [item], filasNuestras: [] });
  assert.equal(f.crear.length, 1);
  assert.equal(f.crear[0].capacidad, 60, "faltantes: la unidad repetida cuenta una vez");

  const c = compararCapacidad([item], [filaNuestra("70", "", 60, null)]);
  assert.equal(c.resumen.cambiarian, 0, "comparar llega al mismo 60 y no propone cambio");
  assert.equal(c.resumen.iguales, 1);
});

test("faltantes: ítem repetido cuyo primer total es ilegible toma el total válido del segundo", () => {
  // La rama más sutil del cálculo: el primer registro no sirve, el repetido sí.
  const r = calcularFaltantes({
    itemsSri: [
      { item: "80", descripcion: "PRIMERO ILEGIBLE", capacidad_total_tienda: "abc", capacidades_por_unidad_medida: [] },
      { item: "0080", descripcion: "SEGUNDO VALIDO", capacidad_total_tienda: 18, capacidades_por_unidad_medida: [] },
    ],
    filasNuestras: [],
  });
  assert.equal(r.crear.length, 1);
  assert.equal(r.crear[0].capacidad, 18);
  assert.equal(r.resumen.sin_capacidad_sri, 0, "no queda omitido por el primer registro");
  assert.equal(r.resumen.items_sri, 1, "sigue siendo un solo ítem");
});

test("faltantes: sin total declarado Y sin rebanadas, se omite (no se inventa un 0)", () => {
  const r = calcularFaltantes({
    itemsSri: [{ item: "60", descripcion: "D60", capacidades_por_unidad_medida: [] }],
    filasNuestras: [],
  });
  assert.deepEqual(r.crear, []);
  assert.equal(r.omitidos.length, 1);
  assert.equal(r.omitidos[0].motivo, "sin_capacidad_sri");
});

test("faltantes: códigos que difieren solo por ceros matchean y no duplican inserts", () => {
  const r = calcularFaltantes({
    itemsSri: [itemSri("19", [entrada("UND", 300, 1)]), itemSri("0000020", [entrada("UND", 10, 1)])],
    filasNuestras: [filaNuestra("0000019", "", 100, null)],
  });
  assert.deepEqual(r.crear.map((c) => c.codigo_item), ["20"]);
  assert.equal(r.resumen.ya_existen, 1);
  assert.equal(r.resumen.items_nuestros, 1);
});

test("faltantes: SRI repetido (incluso con ceros) produce un solo insert", () => {
  const r = calcularFaltantes({
    itemsSri: [itemSri("77", [entrada("UND", 10, 1)]), itemSri("0077", [entrada("UND", 99, 1)])],
    filasNuestras: [],
  });
  assert.equal(r.crear.length, 1);
  assert.equal(r.crear[0].capacidad, 10);
  assert.equal(r.resumen.items_sri, 1);
});

test("faltantes: redondea igual que la comparación", () => {
  const r = calcularFaltantes({
    itemsSri: [{ item: "8", descripcion: "X", capacidad_total_tienda: 10.123456789, capacidades_por_unidad_medida: [] }],
    filasNuestras: [],
  });
  assert.equal(r.crear[0].capacidad, 10.1235);
});

/* ---------------------------------------------------------------------------
   POST /crear: inserta, nunca pisa
   --------------------------------------------------------------------------- */

function escenarioCrear() {
  bd.tablas.traslados_capacidad = [
    { codigo_item: "0000019", unidad: "", capacidad: 100, factor: null, fijo: false, descripcion: "EXISTE", updated_at: "viejo" },
    { codigo_item: "25588", unidad: "P15", capacidad: 40, factor: 15, fijo: false, descripcion: "SOLO UM", updated_at: "viejo" },
  ];
  bd.log.length = 0;
  bd.hooks.antesDe = null;
  process.env.SRI_CAPACIDAD_TOKEN = "token-secreto-de-prueba";
  const items = [
    itemSri("19", [entrada("UND", 300, 1)]),
    itemSri("25588", [entrada("P15", 900, 15)]),
    itemSri("600", [entrada("UND", 12, 1)], "NUEVO A"),
    itemSri("601", [entrada("P3", 54, 3), entrada("UND", 36, 1)], "NUEVO B"),
    itemSri("602", [entrada("UND", 0, 1)], "SIN CAPACIDAD"),
  ];
  return { fetchImpl: async () => pagina(items, 1) };
}

test("faltantesConSri solo lee y arma el reporte", async () => {
  const { fetchImpl } = escenarioCrear();
  const r = await faltantesConSri({ fetchImpl });
  assert.deepEqual(r.crear.map((c) => [c.codigo_item, c.capacidad]), [["600", 12], ["601", 90]]);
  assert.deepEqual(r.omitidos.map((o) => o.codigo_item), ["602"]);
  assert.equal(r.resumen.ya_existen, 2);
  assert.ok(bd.log.length > 0 && bd.log.every((op) => op.op === "select"));
});

test("crear con `esperados` que no coincide responde 409 nombrando ambos números y no escribe", async () => {
  const { fetchImpl } = escenarioCrear();
  await assert.rejects(crearFaltantesConSri({ esperados: 5, fetchImpl }), (err) => {
    assert.equal(err.statusCode, 409);
    // Que los dígitos aparezcan no alcanza: tienen que estar en el orden correcto,
    // o el mensaje podría decir al revés cuál se esperaba y cuál hay.
    assert.match(err.message, /esperabas 5 filas a crear y ahora hay 2/);
    return true;
  });
  assert.equal(escrituras().length, 0);
  assert.equal(bd.tablas.traslados_capacidad.length, 2);
});

test("crear con `esperados` inválido responde 400 y no escribe", async () => {
  const { fetchImpl } = escenarioCrear();
  for (const esperados of [null, "2", 2.5, -1]) {
    await assert.rejects(crearFaltantesConSri({ esperados, fetchImpl }), (err) => err.statusCode === 400);
  }
  assert.equal(escrituras().length, 0);
});

test("crear con `esperados` correcto inserta solo filas base nuevas y no toca las existentes", async () => {
  const { fetchImpl } = escenarioCrear();
  const antes = structuredClone(bd.tablas.traslados_capacidad);
  const r = await crearFaltantesConSri({ esperados: 2, fetchImpl });

  assert.equal(r.ok, true);
  assert.equal(r.creados, 2);
  assert.deepEqual(r.fallidos, []);
  assert.deepEqual(r.escritos.map((e) => [e.codigo_item, e.unidad, e.capacidad]), [["600", "", 12], ["601", "", 90]]);

  // Solo inserts: nunca update ni upsert.
  assert.deepEqual([...new Set(escrituras().map((op) => op.op))], ["insert"]);

  const nuevas = bd.tablas.traslados_capacidad.slice(2);
  assert.equal(nuevas.length, 2);
  for (const f of nuevas) {
    assert.equal(f.unidad, "");
    assert.equal(f.factor, null);
    assert.ok(!("multi_um" in f) && !("fijo" in f), "multi_um y fijo quedan al default de la columna");
    assert.ok(!Number.isNaN(Date.parse(f.updated_at)));
  }
  assert.equal(nuevas[1].descripcion, "NUEVO B");
  assert.deepEqual(bd.tablas.traslados_capacidad.slice(0, 2), antes);
});

test("crear SIN `esperados` responde 400 y no escribe: la confirmación es obligatoria", async () => {
  const { fetchImpl } = escenarioCrear();
  await assert.rejects(crearFaltantesConSri({ fetchImpl }), (err) => {
    assert.equal(err.statusCode, 400);
    assert.match(err.message, /esperados/);
    return true;
  });
  // Un POST con el body vacío no puede alcanzar para cargar filas que nadie miró.
  // Ni una operación: la validación corta antes de leer SRI y antes de la tabla.
  assert.deepEqual(bd.log, [], "no tocó la base");
});

test("crear aborta sin escribir NADA si un código a insertar ya tiene fila (guarda)", async () => {
  const { fetchImpl } = escenarioCrear();
  // La comparación real nunca produce esto; se fuerza un cálculo roto que incluye
  // el ítem 19 (ya existe como "0000019") junto a uno legítimo.
  const faltantes = async (args) => {
    const real = await faltantesConSri({ ...args, fetchImpl });
    return { ...real, crear: [...real.crear, { codigo_item: "19", descripcion: "X", unidad: "", capacidad: 300 }] };
  };
  await assert.rejects(crearFaltantesConSri({ esperados: 3, faltantes }), (err) => {
    // 409 y no 500: tras releer no se distingue un cálculo roto de alguien que
    // cargó el ítem en el medio, y mandar al operario a buscar un bug es peor.
    assert.equal(err.statusCode, 409);
    assert.match(err.message, /19/);
    return true;
  });
  assert.equal(escrituras().length, 0);
  assert.equal(bd.tablas.traslados_capacidad.length, 2);
});

test("crear: un conflicto de la base se reporta en fallidos, no se oculta", async () => {
  const { fetchImpl } = escenarioCrear();
  bd.hooks.antesDe = async (_t, op) =>
    op === "insert" ? { error: { message: "duplicate key value violates unique constraint" } } : null;
  const r = await crearFaltantesConSri({ esperados: 2, fetchImpl });
  bd.hooks.antesDe = null;
  assert.equal(r.ok, false);
  assert.equal(r.creados, 0);
  assert.equal(r.fallidos.length, 2);
  assert.match(r.fallidos[0].motivo, /duplicate key/);
  assert.equal(r.no_intentados, 0);
});

test("crear vía controlador: 200 al crear y 500 con el detalle si el insert falla", async () => {
  const { crear, faltantes } = await import("../src/controllers/sriCapacidad.controller.js");
  const respuestaFalsa = () => {
    const res = { codigo: 200 };
    res.status = (c) => ((res.codigo = c), res);
    res.json = (b) => ((res.cuerpo = b), res);
    return res;
  };
  const { fetchImpl } = escenarioCrear();
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    const rep = respuestaFalsa();
    await faltantes({ query: {} }, rep, (e) => assert.fail(e.message));
    assert.equal(rep.cuerpo.crear.length, 2);
    assert.equal(escrituras().length, 0);

    bd.hooks.antesDe = async (_t, op) => (op === "insert" ? { error: { message: "falla" } } : null);
    const fallo = respuestaFalsa();
    await crear({ body: { esperados: 2 } }, fallo, (e) => assert.fail(e.message));
    bd.hooks.antesDe = null;
    assert.equal(fallo.codigo, 500);
    assert.equal(fallo.cuerpo.fallidos.length, 2);

    const bueno = respuestaFalsa();
    await crear({ body: { esperados: 2 } }, bueno, (e) => assert.fail(e.message));
    assert.equal(bueno.codigo, 200);
    assert.equal(bueno.cuerpo.creados, 2);

    let error;
    await crear({ body: { esperados: 99 } }, respuestaFalsa(), (e) => (error = e));
    assert.equal(error.statusCode, 409);
  } finally {
    globalThis.fetch = original;
  }
});
