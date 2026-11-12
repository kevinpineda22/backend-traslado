import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

/* =============================================================================
   PORTAFOLIO EXTRA: productos que un administrador agregó a mano al portafolio de
   una sede (tabla traslados_portafolio_extra, migración 043).

   Regla de negocio: un extra aparece en la lista de ESA sede en TODOS los flujos
   (Llano, Machado, General) aunque no tenga capacidad (sugerido 0), la sede nunca
   lo haya movido o el origen no lo tenga (disponible 0). Se salta el portafolio del
   flujo (CAT / CAM / requiereCapacidad / requiereOrigen) y la regla de "se esconde
   si no hay origen y no hay necesidad". Vive solo en Supabase.

   Acá NO se mockea `sugerido.service`: se verifica el sugerido REAL (0 sin capacidad).
   ============================================================================= */

let getProductosLlano;
let getProductosTraslado;

let filas = [];
let capacidades = new Map();
let extras = new Set();
let catalogo = new Map();
let avisos = [];

const fila = (
  bodega,
  codigo,
  { disponible = 10, consumo = 0, cat = "CATEGORIA TIPO A", cam = "PORTAFOLIO ACTIVO MACHADO" } = {},
) => ({
  bodega,
  codigo_item: codigo,
  descripcion: `ITEM ${codigo}`,
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

const enCatalogo = (codigo, extra = {}) =>
  catalogo.set(codigo, {
    codigo_item: codigo,
    descripcion: `CATALOGO ${codigo}`,
    referencia: "REF",
    um: "KG",
    um_orden: "KG",
    estado: 1,
    grupo: "FRUVER",
    subgrupo: "FRUTAS",
    ...extra,
  });

const conCapacidad = (codigo, capacidad) =>
  capacidades.set(codigo, [{ capacidad, unidad: "", factor: null, multi_um: false }]);

before(async () => {
  mock.module("../src/services/snapshot.service.js", {
    exports: {
      leerBodegas: async (bodegas) => filas.filter((f) => bodegas.includes(f.bodega)),
      leerBodegasItems: async (bodegas, codigos) =>
        filas.filter((f) => bodegas.includes(f.bodega) && codigos.includes(f.codigo_item)),
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
  mock.module("../src/models/PortafolioExtra.model.js", {
    exports: { codigosDe: async () => new Set(extras), extrasSinOrigen: async () => [] },
  });
  mock.module("../src/models/Catalogo.model.js", {
    exports: {
      porCodigos: async (codigos) =>
        new Map(codigos.filter((c) => catalogo.has(c)).map((c) => [c, catalogo.get(c)])),
    },
  });

  ({ getProductosLlano, getProductosTraslado } = await import("../src/services/siesa.service.js"));

  // Los avisos de "agregado pero sin registro" son esperados en algunos tests.
  mock.method(console, "warn", (...args) => avisos.push(args.join(" ")));
});

beforeEach(() => {
  filas = [];
  capacidades = new Map();
  extras = new Set();
  catalogo = new Map();
  avisos = [];
});

const porCodigo = (data, codigo) => data.find((p) => p.codigo_item === codigo);

/* ─── Flujo Llano (A/B/C, CAT) ──────────────────────────────────────── */

test("Llano: un extra sin fila en origen NI destino y sin capacidad aparece, con la descripción del catálogo", async () => {
  filas = [fila("00301", "1"), fila("00401", "1", { consumo: 1 })];
  extras = new Set(["500"]);
  enCatalogo("500");

  const { data, error } = await getProductosLlano({ origen: "00301", destino: "00401" });

  assert.equal(error, undefined);
  const p = porCodigo(data, "500");
  assert.ok(p, "el extra tiene que estar en la lista");
  assert.equal(p.descripcion, "CATALOGO 500");
  assert.equal(p.unidad_medida, "KG");
  assert.equal(p.disponible_origen, 0);
  assert.equal(p.inventario_destino, 0);
  assert.equal(p.sugerido, 0, "sin capacidad el sugerido es 0");
  assert.equal(p.necesidad, 0);
  assert.equal(p.faltante, 0);
  assert.equal(p.volumen, null, "sin dato, no 'ocupa cero'");
  assert.equal(p.portafolio_extra, true);
  assert.equal(p.sin_registro_origen, true);
  assert.equal(p.sin_registro_destino, true);
  assert.deepEqual(p.unidadesDetalle, [{ unidad: "KG", factor: 1 }]);
  assert.equal(p.criterios["001"], "FRUVER");
  assert.equal(p.criterios["002"], "FRUTAS");
});

test("Llano: un extra que NO pasa el CAT (vacío o DESCODIFICADOS) igual aparece; uno que no es extra sigue fuera", async () => {
  filas = [
    fila("00301", "1"),
    fila("00401", "1", { consumo: 1 }),
    fila("00301", "2", { cat: "" }),
    fila("00401", "2", { cat: "" }),
    fila("00301", "3", { cat: "DESCODIFICADOS" }),
    fila("00401", "3", { cat: "DESCODIFICADOS" }),
    fila("00301", "4", { cat: "" }),
    fila("00401", "4", { cat: "" }),
  ];
  extras = new Set(["2", "3"]);

  const { data } = await getProductosLlano({ origen: "00301", destino: "00401" });

  assert.deepEqual(data.map((p) => p.codigo_item).sort(), ["1", "2", "3"]);
  assert.equal(porCodigo(data, "2").portafolio_extra, true);
  assert.equal(porCodigo(data, "1").portafolio_extra, false);
});

test("Llano: un extra que el destino tiene y el origen no, sin necesidad, igual se muestra", async () => {
  filas = [fila("00301", "1"), fila("00401", "1", { consumo: 1 }), fila("00401", "6", { consumo: 0 })];

  let r = await getProductosLlano({ origen: "00301", destino: "00401" });
  assert.equal(porCodigo(r.data, "6"), undefined, "sin ser extra, necesidad 0 y sin origen: no se muestra");

  extras = new Set(["6"]);
  r = await getProductosLlano({ origen: "00301", destino: "00401" });
  const p = porCodigo(r.data, "6");
  assert.ok(p);
  assert.equal(p.sin_registro_origen, true);
  assert.equal(p.sin_registro_destino, false);
  assert.equal(p.descripcion, "ITEM 6", "con fila en el destino se usa la del snapshot, no la del catálogo");
});

test("las filas de ítems normales llevan los flags en false / según el origen", async () => {
  filas = [fila("00301", "1"), fila("00401", "1", { consumo: 1 }), fila("00401", "2", { consumo: 3 })];
  conCapacidad("2", 20); // sin capacidad y sin origen no se mostraría (no es extra)

  const { data } = await getProductosLlano({ origen: "00301", destino: "00401" });

  assert.equal(porCodigo(data, "1").portafolio_extra, false);
  assert.equal(porCodigo(data, "1").sin_registro_origen, false);
  assert.equal(porCodigo(data, "2").portafolio_extra, false);
  assert.equal(porCodigo(data, "2").sin_registro_origen, true, "no está en el origen");
});

/* ─── Flujo Machado (CAM, exige capacidad y origen) ─────────────────── */

test("Machado: un extra sin CAM, sin capacidad y sin origen aparece con sugerido 0", async () => {
  filas = [fila("PV001", "1"), fila("01201", "1", { consumo: 1 })];
  conCapacidad("1", 10);
  extras = new Set(["500"]);
  enCatalogo("500");

  const { data, ocultos_sin_origen: ocultos, error } = await getProductosLlano({
    origen: "PV001",
    destino: "01201",
  });

  assert.equal(error, undefined);
  const p = porCodigo(data, "500");
  assert.ok(p);
  assert.equal(p.sugerido, 0);
  assert.equal(p.disponible_origen, 0);
  assert.equal(p.portafolio_extra, true);
  assert.equal(p.sin_registro_origen, true);
  assert.equal(p.clase, null, "Machado no clasifica");
  assert.ok(!("CAT" in p.criterios), "el CAT de Llano no se expone en Machado");
  assert.deepEqual(ocultos, []);
});

test("Machado: un extra con CAM vacío y con fila en el origen aparece con lo disponible allí", async () => {
  filas = [fila("PV001", "8", { disponible: 25, cam: "" }), fila("01201", "1")];
  extras = new Set(["8"]);

  const { data } = await getProductosLlano({ origen: "PV001", destino: "01201" });

  const p = porCodigo(data, "8");
  assert.ok(p);
  assert.equal(p.disponible_origen, 25);
  assert.equal(p.sin_registro_origen, false);
  assert.equal(p.sugerido, 0);
});

test("Machado: un extra con capacidad y sin origen NO se lista en ocultos_sin_origen (se muestra en data)", async () => {
  // Es el caso del 'oculto': CAM activo en otra bodega, capacidad > 0, sin fila en PV001.
  filas = [fila("PV001", "1"), fila("01201", "1"), fila("00301", "9", { disponible: 40 })];
  conCapacidad("1", 10);
  conCapacidad("9", 50);
  enCatalogo("9");

  let r = await getProductosLlano({ origen: "PV001", destino: "01201" });
  assert.deepEqual(r.ocultos_sin_origen.map((o) => o.codigo_item), ["9"], "sin ser extra: se avisa aparte");
  assert.equal(porCodigo(r.data, "9"), undefined);

  extras = new Set(["9"]);
  r = await getProductosLlano({ origen: "PV001", destino: "01201" });
  assert.deepEqual(r.ocultos_sin_origen, [], "ya no está oculto: se muestra");
  const p = porCodigo(r.data, "9");
  assert.ok(p);
  assert.equal(p.descripcion, "CATALOGO 9", "sin fila en origen ni destino la descripción sale del catálogo");
});

test("Machado: un extra con capacidad cargada sigue calculando su sugerido (capacidad − inventario)", async () => {
  filas = [fila("PV001", "7", { disponible: 30 }), fila("01201", "1")];
  conCapacidad("7", 50);
  conCapacidad("1", 10);
  extras = new Set(["7"]);

  const { data } = await getProductosLlano({ origen: "PV001", destino: "01201" });

  const p = porCodigo(data, "7");
  assert.equal(p.sugerido, 50);
  assert.equal(p.faltante, 20);
  assert.equal(p.portafolio_extra, true);
});

test("sede con SOLO extras (sin filas en el snapshot ni capacidad) no da error", async () => {
  extras = new Set(["500", "501"]);
  enCatalogo("500");
  enCatalogo("501");

  const { data, error } = await getProductosLlano({ origen: "PV001", destino: "01201" });

  assert.equal(error, undefined);
  assert.deepEqual(data.map((p) => p.codigo_item).sort(), ["500", "501"]);
});

test("sin extras y sin nada que mostrar el error de siempre se mantiene", async () => {
  filas = [fila("PV001", "1")];

  const { error } = await getProductosLlano({ origen: "PV001", destino: "01201" });

  assert.match(error, /Sin datos de inventario para la bodega 01201/);
});

test("un extra que no está ni en el snapshot ni en el catálogo se salta con un aviso, sin romper la lista", async () => {
  filas = [fila("00301", "1"), fila("00401", "1", { consumo: 1 })];
  extras = new Set(["999"]);

  const { data, error } = await getProductosLlano({ origen: "00301", destino: "00401" });

  assert.equal(error, undefined);
  assert.deepEqual(data.map((p) => p.codigo_item), ["1"]);
  assert.ok(avisos.some((a) => a.includes("999")), "deja rastro de por qué no aparece");
});

/* ─── Flujo General (stock de seguridad) ────────────────────────────── */

test("General: un extra sin filas en origen ni destino aparece con sugerido 0 y la descripción del catálogo", async () => {
  filas = [fila("PV001", "1"), fila("00601", "1", { consumo: 1 })];
  extras = new Set(["500"]);
  enCatalogo("500");

  const { data, error } = await getProductosTraslado({ origen: "PV001", destino: "00601" });

  assert.equal(error, undefined);
  const p = porCodigo(data, "500");
  assert.ok(p);
  assert.equal(p.descripcion, "CATALOGO 500");
  assert.equal(p.disponible_origen, 0);
  assert.equal(p.sugerido, 0);
  assert.equal(p.necesidad, 0);
  assert.equal(p.volumen, null);
  assert.equal(p.portafolio_extra, true);
  assert.equal(p.sin_registro_origen, true);
});

test("General: un ítem del destino sin origen y sin necesidad se esconde, salvo que sea extra", async () => {
  filas = [fila("PV001", "1"), fila("00601", "1"), fila("00601", "5", { consumo: 0 })];

  let r = await getProductosTraslado({ origen: "PV001", destino: "00601" });
  assert.equal(porCodigo(r.data, "5"), undefined);

  extras = new Set(["5"]);
  r = await getProductosTraslado({ origen: "PV001", destino: "00601" });
  assert.ok(porCodigo(r.data, "5"));
  assert.equal(porCodigo(r.data, "1").portafolio_extra, false);
  assert.equal(porCodigo(r.data, "1").sin_registro_origen, false);
});

test("General: sede con SOLO extras (sin filas del destino) no da error; sin extras sigue dando el error", async () => {
  filas = [fila("PV001", "1")];

  let r = await getProductosTraslado({ origen: "PV001", destino: "00601" });
  assert.match(r.error, /Sin datos de inventario para la bodega 00601/);

  extras = new Set(["500"]);
  enCatalogo("500");
  r = await getProductosTraslado({ origen: "PV001", destino: "00601" });
  assert.equal(r.error, undefined);
  assert.deepEqual(r.data.map((p) => p.codigo_item), ["500"]);
});

test("los extras son por sede: el de una sede no aparece en otra (el modelo filtra por destino)", async () => {
  // El servicio le pide al modelo los extras de SU destino; con el set vacío no aparece nada extra.
  filas = [fila("PV001", "1"), fila("00601", "1")];
  enCatalogo("500");

  const { data } = await getProductosTraslado({ origen: "PV001", destino: "00601" });

  assert.equal(porCodigo(data, "500"), undefined);
});
