import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { crearBD } from "./helpers/fakeSupabase.js";

/* =============================================================================
   Machado — hallazgos de revisión:
     1. El escaneo de código de barras lee los factores de UM del destino correcto.
     2. Guardar la config con un front viejo (sin `machado`) NO reinicia a Machado.
     3. La carga masiva está prohibida para Llano también del lado del servidor.
   ============================================================================= */

let bd;
let SiesaService;
let ConfigModel;
let CapacidadController;
let SiesaController;

before(async () => {
  bd = crearBD({
    traslados_capacidad: [],
    traslados_config: [],
    siesa_codigos_barras: [],
  });
  mock.module("../src/config/supabase.js", { exports: { supabase: bd.supabase } });
  SiesaService = await import("../src/services/siesa.service.js");
  ConfigModel = await import("../src/models/Config.model.js");
  CapacidadController = await import("../src/controllers/capacidad.controller.js");
  SiesaController = await import("../src/controllers/siesa.controller.js");
});

const cap = (destino, codigo_item, unidad, factor, capacidad = 10) => ({
  destino,
  codigo_item,
  unidad,
  factor,
  capacidad,
  fijo: false,
});

const respuestaFalsa = () => {
  const res = { codigo: 200 };
  res.status = (c) => ((res.codigo = c), res);
  res.json = (b) => ((res.cuerpo = b), res);
  return res;
};

beforeEach(() => {
  bd.tablas.traslados_capacidad = [];
  bd.tablas.traslados_config = [];
  bd.tablas.siesa_codigos_barras = [];
  bd.log.length = 0;
});

/* ─── 1. Código de barras por destino ─────────────────────────────────────── */

test("el escaneo devuelve el factor del destino pedido: Machado y Llano no se mezclan", async () => {
  bd.tablas.siesa_codigos_barras = [{ codigo_barras: "7700001", f120_id: "555", unidad_medida: "P15" }];
  bd.tablas.traslados_capacidad = [
    cap("00401", "555", "P15", 15), // Llano: P15 = 15
    cap("01201", "555", "P15", 12), // Machado: su paquete P15 trae 12
  ];

  const machado = await SiesaService.resolverCodigoBarras("7700001", "01201");
  const llano = await SiesaService.resolverCodigoBarras("7700001", "00401");
  const sinDestino = await SiesaService.resolverCodigoBarras("7700001");

  assert.deepEqual(machado.unidadesDetalle, [{ unidad: "P15", factor: 12 }]);
  assert.deepEqual(llano.unidadesDetalle, [{ unidad: "P15", factor: 15 }]);
  assert.deepEqual(sinDestino.unidadesDetalle, [{ unidad: "P15", factor: 15 }], "sin destino = Llano, como antes");
});

test("también por código base (PLU): usa los factores del destino", async () => {
  bd.tablas.siesa_codigos_barras = [{ codigo_barras: "7700002", f120_id: "556", unidad_medida: "P15" }];
  bd.tablas.traslados_capacidad = [cap("00401", "556", "P15", 15), cap("01201", "556", "P15", 12)];

  const r = await SiesaService.resolverCodigoBarras("556", "01201");

  assert.equal(r.isBase, true);
  assert.deepEqual(r.unidadesDetalle, [{ unidad: "P15", factor: 12 }]);
});

test("la ruta valida ?destino=: uno que no es A/B/C responde 400 y no resuelve nada", async () => {
  const res = respuestaFalsa();
  await SiesaController.resolverCodigoBarrasCtrl(
    { params: { codigo: "7700001" }, query: { destino: "00201" } },
    res,
    (e) => assert.fail(e.message),
  );

  assert.equal(res.codigo, 400);
  assert.match(res.cuerpo.error, /00201/);
  assert.equal(bd.log.length, 0, "no tocó la base");
});

/* ─── 2. Config: una clave ausente conserva lo guardado ──────────────────── */

const vigente = {
  llano: { A: 2, B: 4, C: 6 },
  machado: { A: 7, B: 8, C: 9 },
  general: { periodoCubrimiento: 10 },
};

test("un PUT sin `machado` (front viejo) conserva las cadencias de Machado guardadas", async () => {
  bd.tablas.traslados_config = [{ clave: "reposicion", valor: structuredClone(vigente) }];

  const r = await ConfigModel.guardar({
    llano: { A: 1, B: 2, C: 3 },
    general: { periodoCubrimiento: null },
  });

  assert.deepEqual(r.machado, { A: 7, B: 8, C: 9 }, "Machado no se reinició a 1/3/5");
  assert.deepEqual(r.llano, { A: 1, B: 2, C: 3 }, "lo que sí viene se guarda");
  assert.deepEqual(bd.tablas.traslados_config[0].valor.machado, { A: 7, B: 8, C: 9 });
});

test("un PUT sin `llano` conserva las de Llano, y con `machado` lo reemplaza", async () => {
  bd.tablas.traslados_config = [{ clave: "reposicion", valor: structuredClone(vigente) }];

  const r = await ConfigModel.guardar({
    machado: { A: 1, B: 1, C: 1 },
    general: { periodoCubrimiento: null },
  });

  assert.deepEqual(r.llano, { A: 2, B: 4, C: 6 });
  assert.deepEqual(r.machado, { A: 1, B: 1, C: 1 });
});

test("sin nada guardado y sin la clave, caen los defaults 1/3/5", async () => {
  const r = await ConfigModel.guardar({ general: { periodoCubrimiento: null } });

  assert.deepEqual(r.llano, { A: 1, B: 3, C: 5 });
  assert.deepEqual(r.machado, { A: 1, B: 3, C: 5 });
});

/* ─── 3. Carga masiva: 403 para Llano en el servidor ─────────────────────── */

test("PUT /capacidad sin destino (= Llano) responde 403 y no escribe nada", async () => {
  bd.tablas.traslados_capacidad = [cap("00401", "600", "", null, 12)];
  const antes = structuredClone(bd.tablas.traslados_capacidad);
  let error;

  await CapacidadController.subir(
    { query: {}, body: { items: [{ item: "600", capacidad: 999 }] } },
    respuestaFalsa(),
    (e) => (error = e),
  );

  assert.equal(error.statusCode, 403);
  assert.match(error.message, /Girardota Llano/);
  assert.deepEqual(bd.tablas.traslados_capacidad, antes);
});

test("PUT /capacidad con destino 00401 explícito también responde 403", async () => {
  let error;

  await CapacidadController.subir(
    { query: {}, body: { destino: "00401", items: [{ item: "600", capacidad: 1 }] } },
    respuestaFalsa(),
    (e) => (error = e),
  );

  assert.equal(error.statusCode, 403);
});

test("PUT /capacidad con destino Machado sigue funcionando y no toca Llano", async () => {
  bd.tablas.traslados_capacidad = [cap("00401", "600", "", null, 12)];
  const res = respuestaFalsa();

  await CapacidadController.subir(
    { query: {}, body: { destino: "01201", items: [{ item: "600", capacidad: 77 }] } },
    res,
    (e) => assert.fail(e.message),
  );

  assert.equal(res.cuerpo.ok, true);
  const t = bd.tablas.traslados_capacidad;
  assert.equal(t.find((f) => f.destino === "00401").capacidad, 12);
  assert.equal(t.find((f) => f.destino === "01201").capacidad, 77);
});
