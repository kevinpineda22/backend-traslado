import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

/* =============================================================================
   Machado (PV001 → 01201): portafolio por el plan CAM, SIN clasificación A/B/C.

   Decisiones de negocio:
     - El plan CAT ("CLASIFICACIÓN ABC LLANO") es EXCLUSIVO de Llano: Machado nunca lo
       lee (ni para la clase, ni para filtrar el portafolio, ni en la disponibilidad).
     - Un ítem se muestra en Machado solo si su CAM es "PORTAFOLIO ACTIVO MACHADO"
       (comparado sin tildes ni mayúsculas), tiene capacidad > 0 cargada para 01201 y
       existe en el origen. Los del Excel sin CAM activo quedan escondidos.
     - sugerido = max(0, capacidad − inventario del destino), sin clase ni cadencias.

   No se mockea `sugerido.service`: se verifica la cuenta real.
   ============================================================================= */

const ORIGEN = "PV001";
const DESTINO = "01201";
const ACTIVO = "PORTAFOLIO ACTIVO MACHADO";

let getProductosLlano;
let getDisponibilidadItem;
let clasesLlanoDeItems;
let filas = [];
let capacidades = new Map();
let lecturasItems = 0;

const fila = (
  bodega,
  codigo,
  { disponible = 10, consumo = 0, cat = "", cam = ACTIVO, descripcion } = {},
) => ({
  bodega,
  codigo_item: codigo,
  descripcion: descripcion ?? `ITEM ${codigo}`,
  um: "UND",
  um_orden: "UND",
  factor: 1,
  volumen: null,
  inventario: disponible,
  disponible,
  consumo_promedio: consumo,
  periodo_cubrimiento: 0,
  rotacion: "",
  criterios: { CAT: cat, CAM: cam },
});

const conCapacidad = (codigo, capacidad) =>
  capacidades.set(codigo, [{ capacidad, unidad: "", factor: null, multi_um: false }]);

const codigosDe = async () => {
  const { data, error } = await getProductosLlano({ origen: ORIGEN, destino: DESTINO });
  assert.equal(error, undefined);
  return data.map((p) => p.codigo_item).sort();
};

before(async () => {
  mock.module("../src/services/snapshot.service.js", {
    exports: {
      leerBodegas: async (bodegas) => filas.filter((f) => bodegas.includes(f.bodega)),
      leerBodegasItems: async (bodegas, codigos) => {
        lecturasItems += 1;
        return filas.filter((f) => bodegas.includes(f.bodega) && codigos.includes(f.codigo_item));
      },
      // Lo que importa el controlador de SIESA (la ruta se prueba en este archivo).
      refrescarSnapshotUnico: async () => ({}),
      refreshEnProgreso: () => false,
      ultimaActualizacion: async () => null,
      dispararRefreshRemoto: async () => ({}),
      RefreshEnCursoError: class RefreshEnCursoError extends Error {},
      PullIncompletoError: class PullIncompletoError extends Error {},
    },
  });
  mock.module("../src/models/Capacidad.model.js", {
    exports: { mapaCapacidades: async () => capacidades, factoresDeItem: async () => new Map() },
  });
  mock.module("../src/models/Config.model.js", {
    exports: {
      obtener: async () => ({
        llano: { A: 1, B: 3, C: 5 },
        machado: { A: 1, B: 3, C: 5 },
        general: { periodoCubrimiento: null },
      }),
    },
  });
  mock.module("../src/config/supabase.js", { exports: { supabase: {} } });

  ({ getProductosLlano, getDisponibilidadItem, clasesLlanoDeItems } = await import(
    "../src/services/siesa.service.js"
  ));
});

beforeEach(() => {
  filas = [];
  capacidades = new Map();
  lecturasItems = 0;
});

test("CAM activo + capacidad + existe en el origen: se muestra, sin clase, sugerido = capacidad − inventario", async () => {
  filas = [fila(ORIGEN, "7", { disponible: 30 }), fila(DESTINO, "7", { disponible: 12, consumo: 3 })];
  conCapacidad("7", 50);

  const { data } = await getProductosLlano({ origen: ORIGEN, destino: DESTINO });

  assert.equal(data.length, 1);
  const p = data[0];
  assert.equal(p.clase, null);
  assert.equal(p.capacidad, 50);
  assert.equal(p.inventario_destino, 12);
  assert.equal(p.sugerido, 38, "50 − 12; el consumo no interviene");
  assert.equal(p.necesidad, 38);
  assert.equal(p.disponible_origen, 30);
  assert.equal(p.faltante, 8, "tope por el origen: 38 − 30 que no se alcanzan a cubrir");
});

test("con la góndola llena o pasada de capacidad no se sugiere nada (nunca negativo)", async () => {
  filas = [fila(ORIGEN, "7"), fila(DESTINO, "7", { disponible: 80 })];
  conCapacidad("7", 50);

  const { data } = await getProductosLlano({ origen: ORIGEN, destino: DESTINO });

  assert.equal(data[0].sugerido, 0);
});

test("el CAM se compara sin tildes, mayúsculas ni espacios en los bordes", async () => {
  filas = [
    fila(ORIGEN, "1"), fila(DESTINO, "1", { cam: "  portafolio activo machado " }),
    fila(ORIGEN, "2"), fila(DESTINO, "2", { cam: "Portafolío Activo Machado" }),
  ];
  conCapacidad("1", 10);
  conCapacidad("2", 10);

  assert.deepEqual(await codigosDe(), ["1", "2"]);
});

test("capacidad cargada pero CAM vacío u otro valor: el ítem queda ESCONDIDO", async () => {
  filas = [
    // El criterio es del ÍTEM: origen y destino traen el mismo valor.
    fila(ORIGEN, "1", { cam: "" }), fila(DESTINO, "1", { cam: "" }),
    fila(ORIGEN, "2", { cam: "PORTAFOLIO INACTIVO MACHADO" }), fila(DESTINO, "2", { cam: "PORTAFOLIO INACTIVO MACHADO" }),
    fila(ORIGEN, "3", { cam: "PORTAFOLIO ACTIVO LLANO" }), fila(DESTINO, "3", { cam: "PORTAFOLIO ACTIVO LLANO" }),
    fila(ORIGEN, "4"), fila(DESTINO, "4"), // este sí
  ];
  for (const c of ["1", "2", "3", "4"]) conCapacidad(c, 10);

  assert.deepEqual(await codigosDe(), ["4"]);
});

test("un ítem con CAT 'CATEGORIA TIPO A' pero sin CAM activo se esconde: el CAT se ignora", async () => {
  filas = [
    fila(ORIGEN, "1", { cat: "CATEGORIA TIPO A", cam: "" }),
    fila(DESTINO, "1", { cat: "CATEGORIA TIPO A", cam: "" }),
    fila(ORIGEN, "4"), fila(DESTINO, "4"),
  ];
  conCapacidad("1", 10);
  conCapacidad("4", 10);

  assert.deepEqual(await codigosDe(), ["4"]);
});

test("el CAT de un ítem con CAM activo no cambia nada: sin clase y mismo sugerido", async () => {
  filas = [
    fila(ORIGEN, "1", { cat: "CATEGORIA TIPO A" }),
    fila(DESTINO, "1", { cat: "CATEGORIA TIPO A", disponible: 5, consumo: 100 }),
    fila(ORIGEN, "2", { cat: "DESCODIFICADOS" }), // descodificado es regla de Llano
    fila(DESTINO, "2", { cat: "DESCODIFICADOS", disponible: 5, consumo: 100 }),
  ];
  conCapacidad("1", 50);
  conCapacidad("2", 50);

  const { data } = await getProductosLlano({ origen: ORIGEN, destino: DESTINO });

  assert.deepEqual(data.map((p) => p.codigo_item).sort(), ["1", "2"]);
  for (const p of data) {
    assert.equal(p.clase, null);
    assert.equal(p.sugerido, 45, "50 − 5, aunque el consumo (100/día) hubiera dado otra cosa con A/B/C");
  }
});

test("CAM activo pero capacidad 0 o sin capacidad: no se muestra (Machado exige capacidad > 0)", async () => {
  filas = [
    fila(ORIGEN, "1"), fila(DESTINO, "1"),
    fila(ORIGEN, "2"), fila(DESTINO, "2"),
    fila(ORIGEN, "3"), fila(DESTINO, "3"),
  ];
  conCapacidad("1", 0);
  conCapacidad("3", 20);

  assert.deepEqual(await codigosDe(), ["3"]);
});

test("getDisponibilidadItem de Machado: sugerido = capacidad − inventario, sin leer el CAT", async () => {
  filas = [
    fila(ORIGEN, "7", { cat: "CATEGORIA TIPO A", disponible: 100 }),
    fila(DESTINO, "7", { cat: "CATEGORIA TIPO A", disponible: 12, consumo: 500 }),
  ];
  conCapacidad("7", 50);

  const { data } = await getDisponibilidadItem({ codigo: "7", destino: DESTINO });

  assert.equal(data.flujo, "machado");
  assert.equal(data.inventario_destino, 12);
  assert.equal(data.necesidad, 38);
});

test("las clases del detalle de un despacho de Machado: ninguna, y ni siquiera se lee el snapshot", async () => {
  filas = [fila(DESTINO, "7", { cat: "CATEGORIA TIPO A" })];

  const clases = await clasesLlanoDeItems(DESTINO, ["7"]);

  assert.equal(clases.size, 0);
  assert.equal(lecturasItems, 0);
});

test("Llano sigue igual: clasifica por CAT, esconde CAT vacío y DESCODIFICADOS, ignora el CAM", async () => {
  filas = [
    fila("00301", "1", { cat: "CATEGORIA TIPO A", cam: "" }),
    fila("00401", "1", { cat: "CATEGORIA TIPO A", cam: "", consumo: 1 }),
    fila("00301", "2", { cat: "" }), fila("00401", "2", { cat: "" }),
    fila("00301", "3", { cat: "Descodificados" }), fila("00401", "3", { cat: "Descodificados" }),
  ];
  const { data } = await getProductosLlano({ origen: "00301", destino: "00401" });

  assert.deepEqual(data.map((p) => p.codigo_item), ["1"]);
  assert.equal(data[0].clase, "A");
  const clases = await clasesLlanoDeItems("00401", ["1"]);
  assert.equal(clases.get("1"), "A");
});

/* ─── Revisión: origen obligatorio, plan ausente del snapshot, CAT fuera ─── */

test("un ítem con CAM activo y capacidad pero SIN fila en PV001 no se muestra en Machado", async () => {
  filas = [fila(DESTINO, "7", { disponible: 0 }), fila(ORIGEN, "8"), fila(DESTINO, "8")];
  conCapacidad("7", 50);
  conCapacidad("8", 50);

  assert.deepEqual(await codigosDe(), ["8"], "el 7 no existe en el origen: no hay de dónde mandarlo");
});

test("Llano NO exige origen: muestra lo que tiene aunque el origen no lo tenga y lo necesita", async () => {
  filas = [
    fila("00301", "1"), fila("00401", "1", { cat: "CATEGORIA TIPO A" }),
    fila("00401", "2", { cat: "CATEGORIA TIPO A", disponible: 0, consumo: 5 }), // solo en Llano
  ];

  const { data } = await getProductosLlano({ origen: "00301", destino: "00401" });

  assert.deepEqual(data.map((p) => p.codigo_item).sort(), ["1", "2"]);
});

test("si el snapshot no trae el plan CAM en ninguna fila, Machado responde un error explícito", async () => {
  const sinCam = (bodega, codigo) => {
    const f = fila(bodega, codigo);
    delete f.criterios.CAM; // la consulta registrada todavía no devuelve DescMayorCAM
    return f;
  };
  filas = [sinCam(ORIGEN, "7"), sinCam(DESTINO, "7")];
  conCapacidad("7", 50);

  const { data, error } = await getProductosLlano({ origen: ORIGEN, destino: DESTINO });

  assert.equal(data, undefined);
  assert.match(error, /El snapshot no trae el plan CAM/);
  assert.match(error, /Connekta/);
});

test("CAM presente pero vacío en los ítems NO es error: es una lista vacía legítima", async () => {
  filas = [fila(ORIGEN, "7", { cam: "" }), fila(DESTINO, "7", { cam: "" })];
  conCapacidad("7", 50);

  const { data, error } = await getProductosLlano({ origen: ORIGEN, destino: DESTINO });

  assert.equal(error, undefined);
  assert.deepEqual(data, []);
});

test("basta UNA fila con la clave CAM para que no sea error (los demás ítems solo están fuera)", async () => {
  const sinCam = fila(ORIGEN, "9");
  delete sinCam.criterios.CAM;
  filas = [sinCam, fila(ORIGEN, "7"), fila(DESTINO, "7")];
  conCapacidad("7", 50);

  assert.deepEqual(await codigosDe(), ["7"]);
});

test("Llano no pide el plan CAM: sin esa clave en el snapshot funciona igual", async () => {
  const origen = fila("00301", "1", { cat: "CATEGORIA TIPO A" });
  const destino = fila("00401", "1", { cat: "CATEGORIA TIPO A" });
  delete origen.criterios.CAM;
  delete destino.criterios.CAM;
  filas = [origen, destino];

  const { data, error } = await getProductosLlano({ origen: "00301", destino: "00401" });

  assert.equal(error, undefined);
  assert.equal(data.length, 1);
});

test("los criterios de un producto de Machado no incluyen el CAT; los de Llano sí", async () => {
  filas = [
    fila(ORIGEN, "7", { cat: "CATEGORIA TIPO A" }), fila(DESTINO, "7", { cat: "CATEGORIA TIPO A" }),
    fila("00301", "1", { cat: "CATEGORIA TIPO B" }), fila("00401", "1", { cat: "CATEGORIA TIPO B" }),
  ];
  conCapacidad("7", 50);

  const machado = (await getProductosLlano({ origen: ORIGEN, destino: DESTINO })).data[0];
  const llano = (await getProductosLlano({ origen: "00301", destino: "00401" })).data[0];

  assert.equal("CAT" in machado.criterios, false);
  assert.equal(machado.criterios.CAM, ACTIVO);
  assert.equal(llano.criterios.CAT, "CATEGORIA TIPO B");
});

/* ─── Ítems del portafolio ocultos solo por no existir en el origen ─── */

const VILLAHERMOSA = "00201";

test("los ítems con CAM y capacidad que no existen en PV001 se informan aparte, con dónde hay stock", async () => {
  filas = [
    fila(ORIGEN, "1"), fila(DESTINO, "1"), // visible
    fila(DESTINO, "188291", { descripcion: "BORNEO UNO" }),
    fila(VILLAHERMOSA, "188291", { disponible: 19, descripcion: "BORNEO UNO" }),
    fila("00601", "188291", { disponible: 4, descripcion: "BORNEO UNO" }),
    fila("00701", "188291", { disponible: 0 }), // sin stock: no se lista
  ];
  conCapacidad("1", 10);
  conCapacidad("188291", 30);

  const r = await getProductosLlano({ origen: ORIGEN, destino: DESTINO });

  assert.deepEqual(r.data.map((p) => p.codigo_item), ["1"], "sigue sin ser despachable");
  assert.deepEqual(r.ocultos_sin_origen, [
    {
      codigo_item: "188291",
      descripcion: "BORNEO UNO",
      capacidad: 30,
      unidad: "",
      sedes: [
        { codigo: VILLAHERMOSA, nombre: "Villahermosa", disponible: 19 },
        { codigo: "00601", nombre: "Vegas", disponible: 4 },
      ],
    },
  ]);
});

test("un ítem sin fila en 01201 pero con CAM activo en otra bodega también se informa", async () => {
  filas = [fila(ORIGEN, "1"), fila(DESTINO, "1"), fila(VILLAHERMOSA, "188293", { disponible: 7 })];
  conCapacidad("1", 10);
  conCapacidad("188293", 12);

  const r = await getProductosLlano({ origen: ORIGEN, destino: DESTINO });

  assert.deepEqual(r.ocultos_sin_origen.map((o) => o.codigo_item), ["188293"]);
});

test("no se informan los que fallan OTRA regla: sin CAM activo o sin capacidad", async () => {
  filas = [
    fila(ORIGEN, "1"), fila(DESTINO, "1"),
    fila(DESTINO, "2", { cam: "" }), fila(VILLAHERMOSA, "2", { cam: "" }), // sin CAM
    fila(DESTINO, "3"), fila(VILLAHERMOSA, "3"), // CAM activo pero capacidad 0
    fila(DESTINO, "4"), // CAM activo y sin capacidad cargada
  ];
  conCapacidad("1", 10);
  conCapacidad("2", 10);
  conCapacidad("3", 0);

  const r = await getProductosLlano({ origen: ORIGEN, destino: DESTINO });

  assert.deepEqual(r.ocultos_sin_origen, []);
});

test("la descripción cae a la de la capacidad cuando ninguna fila del snapshot la trae", async () => {
  filas = [fila(ORIGEN, "1"), fila(DESTINO, "1"), fila(VILLAHERMOSA, "9", { descripcion: "" })];
  conCapacidad("1", 10);
  capacidades.set("9", [{ capacidad: 5, unidad: "", factor: null, multi_um: false, descripcion: "DESDE EXCEL" }]);

  const r = await getProductosLlano({ origen: ORIGEN, destino: DESTINO });

  assert.equal(r.ocultos_sin_origen[0].descripcion, "DESDE EXCEL");
});

test("Llano no recibe el campo ocultos_sin_origen", async () => {
  filas = [fila("00301", "1", { cat: "CATEGORIA TIPO A" }), fila("00401", "1", { cat: "CATEGORIA TIPO A" })];

  const r = await getProductosLlano({ origen: "00301", destino: "00401" });

  assert.equal("ocultos_sin_origen" in r, false);
});

test("la ruta incluye ocultos_sin_origen solo cuando el servicio lo manda", async () => {
  const { listarProductos } = await import("../src/controllers/siesa.controller.js");
  filas = [fila(ORIGEN, "1"), fila(DESTINO, "1"), fila(VILLAHERMOSA, "9")];
  conCapacidad("1", 10);
  conCapacidad("9", 5);
  const responder = async (destino) => {
    let cuerpo;
    await listarProductos({ query: { destino } }, { json: (b) => (cuerpo = b), status: () => ({ json: (b) => (cuerpo = b) }) }, (e) => assert.fail(e.message));
    return cuerpo;
  };

  const machado = await responder(DESTINO);

  assert.equal(machado.ok, true);
  assert.equal(machado.ocultos_sin_origen.length, 1);
  assert.equal(machado.data.length, 1);
});
