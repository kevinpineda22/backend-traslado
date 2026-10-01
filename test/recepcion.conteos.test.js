import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { crearBD } from "./helpers/fakeSupabase.js";

/* =============================================================================
   RECEPCIÓN ESCANEO POR ESCANEO (migración 036) — el conteo del auditor vive en
   la base, sobrevive al celular y se puede repartir entre varias personas.

   Lo que tiene que valer siempre:
     · un reintento de la cola no duplica nada (cada fila guarda un TOTAL);
     · dos auditores suman, no se pisan;
     · lo que se firma es lo del servidor, no lo que trae el celular que firma;
     · un producto ajeno o una recepción ya cerrada no se escriben.
   ============================================================================= */

let bd;
let DespachoModel;
let DespachoService;
let RecepcionService;
let validators;

const D = "d0000000-0000-4000-8000-000000000001";
const OTRO = "d0000000-0000-4000-8000-000000000002";
const ANA = "ana@merkahorrosas.com";
const BETO = "beto@merkahorrosas.com";

const itemId = (n) => `a0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function despacho(over = {}) {
  return {
    id: D,
    estado: "Recolectado",
    flujo: "general",
    origen: "PV001",
    destino: "00201",
    inactivo: false,
    despachador_id: "desp@merkahorrosas.com",
    criterios: [],
    auditoria_iniciada_at: null,
    auditoria_abierta_at: null,
    ...over,
  };
}

function item(n, over = {}) {
  return {
    id: itemId(n),
    despacho_id: D,
    codigo_item: String(1000 + n),
    descripcion: `Producto ${n}`,
    unidad_medida: "UND",
    factor: 1,
    cantidad_admin: 10,
    cantidad_despachador: 10,
    cantidad_auditor: null,
    agotado: false,
    motivo: null,
    no_recibido: false,
    siesa_omitido: false,
    ...over,
  };
}

function mockModulo(ruta, { exports: exportaciones }) {
  const mayor = Number(process.versions.node.split(".")[0]);
  mock.module(ruta, mayor >= 24 ? { exports: exportaciones } : { namedExports: exportaciones });
}

const conteos = () => bd.tablas.traslados_recepcion_conteos;
const renglon = (n) => bd.tablas.traslados_items.find((x) => x.id === itemId(n));
const firmar = (over = {}) =>
  DespachoService.confirmarAuditoria(D, {
    decision: "inconsistencia",
    auditorId: ANA,
    firmaData: "data:image/png;base64,AAA",
    // Lo que trae el celular que firma: a propósito distinto de lo guardado.
    items: [{ id: itemId(0), cantidad_auditor: 999 }],
    ...over,
  });

before(async () => {
  mockModulo("../src/config/supabase.js", {
    exports: { supabase: { from: (t) => bd.supabase.from(t) } },
  });
  mockModulo("../src/services/notificacionesTraslado.service.js", {
    exports: {
      notificarRecoleccionCerrada: async () => {},
      enviarComparativoAuditoria: async () => {},
      enviarErrorSiesa: async () => {},
      enviarInciertoSiesa: async () => {},
      enviarManifiestoCarga: async () => {},
    },
  });
  mockModulo("../src/services/requisicion.service.js", {
    exports: { enviarRequisicion: async () => ({ estado: "enviado" }) },
  });
  mockModulo("../src/services/siesaTransito.consulta.js", {
    exports: { consultaConfigurada: () => false },
  });
  mockModulo("../src/services/siesaStock.service.js", {
    exports: { getStockLote: async () => ({}) },
  });
  mockModulo("../src/services/siesa.service.js", {
    exports: {
      fichaDeItem: async (codigo) => ({ codigo_item: codigo, descripcion: `Ficha ${codigo}` }),
    },
  });
  mockModulo("../src/services/analitica.service.js", {
    exports: { analitica: async () => ({}) },
  });

  DespachoModel = await import("../src/models/Despacho.model.js");
  DespachoService = await import("../src/services/despacho.service.js");
  RecepcionService = await import("../src/services/recepcion.service.js");
  ({ validators } = await import("../src/middleware/validators.js"));
});

beforeEach(() => {
  bd = crearBD({
    traslados_despachos: [despacho()],
    traslados_items: [item(0), item(1), item(2)],
    traslados_firmas: [],
    traslados_recepcion_conteos: [],
  });
});

/* ── GUARDAR ───────────────────────────────────────────────────────────────── */

test("el primer conteo guardado pasa el traslado a En_recepcion y sella el inicio", async () => {
  const r = await RecepcionService.registrarConteos(D, ANA, [{ item_id: itemId(0), cantidad: 4 }]);

  assert.equal(r.guardados, 1);
  const d = bd.tablas.traslados_despachos[0];
  assert.equal(d.estado, "En_recepcion");
  assert.ok(d.auditoria_iniciada_at, "hito de inicio");
  assert.ok(d.auditoria_abierta_at, "señal de actividad para las alertas");
});

test("la cola reenvía el mismo lote: queda UNA fila con el mismo total", async () => {
  const lote = [{ item_id: itemId(0), cantidad: 4 }];
  await RecepcionService.registrarConteos(D, ANA, lote);
  await RecepcionService.registrarConteos(D, ANA, lote);
  await RecepcionService.registrarConteos(D, ANA.toUpperCase(), lote);

  assert.equal(conteos().length, 1);
  assert.equal(conteos()[0].cantidad, 4);
});

test("un producto oculto al auditor o de otro traslado vuelve en `fuera` y no se escribe", async () => {
  bd.tablas.traslados_despachos.push(despacho({ id: OTRO }));
  bd.tablas.traslados_items.push(item(3, { agotado: true }), item(9, { despacho_id: OTRO }));

  const r = await RecepcionService.registrarConteos(D, ANA, [
    { item_id: itemId(0), cantidad: 1 },
    { item_id: itemId(3), cantidad: 1 },
    { item_id: itemId(9), cantidad: 1 },
  ]);

  assert.equal(r.guardados, 1);
  assert.deepEqual(r.fuera.map((f) => f.item_id).sort(), [itemId(3), itemId(9)].sort());
  assert.equal(conteos().length, 1);
});

test("una recepción ya cerrada rechaza con RECEPCION_CERRADA (la cola deja de reintentar)", async () => {
  bd.tablas.traslados_despachos[0].estado = "Auditado";
  await assert.rejects(
    RecepcionService.registrarConteos(D, ANA, [{ item_id: itemId(0), cantidad: 1 }]),
    (e) => e.statusCode === 409 && e.codigo === "RECEPCION_CERRADA",
  );
  assert.equal(conteos().length, 0);
});

test("sobrante escaneado con y sin el relleno de ceros es la MISMA fila", async () => {
  await RecepcionService.registrarConteos(D, ANA, [{ codigo_item: "0189202", cantidad: 2 }]);
  await RecepcionService.registrarConteos(D, ANA, [{ codigo_item: "189202", cantidad: 3 }]);
  assert.equal(conteos().length, 1);
  assert.equal(conteos()[0].cantidad, 3);
});

test("validador: un conteo sin item_id ni código se rechaza", () => {
  let status = null;
  validators.conteosRecepcion(
    { body: { auditor_id: ANA, conteos: [{ cantidad: 1 }] } },
    { status: (s) => ((status = s), { json: () => {} }) },
    () => {},
  );
  assert.equal(status, 400);
});

/* ── VARIOS AUDITORES ──────────────────────────────────────────────────────── */

test("dos auditores suman, y se firma lo del SERVIDOR, no lo del celular que firma", async () => {
  await RecepcionService.registrarConteos(D, ANA, [{ item_id: itemId(0), cantidad: 6 }]);
  await RecepcionService.registrarConteos(D, BETO, [{ item_id: itemId(0), cantidad: 4 }]);

  await firmar();

  assert.equal(renglon(0).cantidad_auditor, 10, "6 de Ana + 4 de Beto, no los 999 del cuerpo");
  assert.equal(renglon(0).diferencia, 0);
  // Los que nadie contó se firman en 0, igual que antes.
  assert.equal(renglon(1).cantidad_auditor, 0);
});

test("la MISMA cuenta en dos celulares (cuenta de sede) suma, no se pisa", async () => {
  await RecepcionService.registrarConteos(D, ANA, [{ item_id: itemId(0), cantidad: 6 }], "cel-1");
  await RecepcionService.registrarConteos(D, ANA, [{ item_id: itemId(0), cantidad: 4 }], "cel-2");

  assert.equal(conteos().length, 2);
  await firmar();
  assert.equal(renglon(0).cantidad_auditor, 10);
});

test("recontar desde un celular deja SOLO esa fila, aunque la otra sea de la misma cuenta", async () => {
  await RecepcionService.registrarConteos(D, ANA, [{ item_id: itemId(0), cantidad: 6 }], "cel-1");
  await RecepcionService.registrarConteos(D, ANA, [{ item_id: itemId(0), cantidad: 4 }], "cel-2");

  const filas = await RecepcionService.recontar(D, ANA, [itemId(0)], "cel-2");
  const del0 = filas.filter((f) => f.item_id === itemId(0));
  assert.equal(del0.length, 1);
  assert.equal(del0[0].dispositivo, "cel-2");
  assert.equal(del0[0].conteo_previo, 10);
});

test("deshacer 'no recibido' apaga la marca aunque la haya puesto un compañero", async () => {
  await RecepcionService.registrarConteos(D, BETO, [{ item_id: itemId(1), cantidad: 0, no_recibido: true }]);
  await RecepcionService.registrarConteos(D, ANA, [
    { item_id: itemId(1), cantidad: 0, quitar_no_recibido: true },
  ]);

  assert.ok(conteos().every((f) => f.no_recibido === false));
  await firmar();
  assert.equal(renglon(1).no_recibido, false);
});

test("comparar usa la suma del servidor", async () => {
  await RecepcionService.registrarConteos(D, ANA, [{ item_id: itemId(0), cantidad: 6 }]);
  await RecepcionService.registrarConteos(D, BETO, [
    { item_id: itemId(0), cantidad: 4 },
    { item_id: itemId(1), cantidad: 10 },
    { item_id: itemId(2), cantidad: 10 },
  ]);

  const { match } = await DespachoService.compararAuditoria(D, [{ id: itemId(0), cantidad_auditor: 1 }]);
  assert.equal(match, true);
});

test("si uno lo marcó no recibido y otro lo contó, LLEGÓ", async () => {
  await RecepcionService.registrarConteos(D, ANA, [{ item_id: itemId(1), cantidad: 0, no_recibido: true }]);
  await RecepcionService.registrarConteos(D, BETO, [{ item_id: itemId(1), cantidad: 5 }]);

  await firmar();
  assert.equal(renglon(1).no_recibido, false);
  assert.equal(renglon(1).cantidad_auditor, 5);
});

test("no recibido sin ningún conteo se firma como no recibido", async () => {
  await RecepcionService.registrarConteos(D, ANA, [{ item_id: itemId(1), cantidad: 0, no_recibido: true }]);
  await firmar();
  assert.equal(renglon(1).no_recibido, true);
  assert.equal(renglon(1).cantidad_auditor, 0);
});

/* ── RECONTAR ──────────────────────────────────────────────────────────────── */

test("recontar: el previo es lo que sumaban todos, las filas ajenas se van y la propia queda en 0", async () => {
  await RecepcionService.registrarConteos(D, ANA, [{ item_id: itemId(0), cantidad: 6 }]);
  await RecepcionService.registrarConteos(D, BETO, [{ item_id: itemId(0), cantidad: 7 }]);

  const filas = await RecepcionService.recontar(D, ANA, [itemId(0)]);

  const del0 = filas.filter((f) => f.item_id === itemId(0));
  assert.equal(del0.length, 1, "no queda la fila de Beto: si quedara, el recuento se le sumaría");
  assert.equal(del0[0].contado_por, ANA);
  assert.equal(del0[0].cantidad, 0);
  assert.equal(del0[0].conteo_previo, 13);
});

test("recontar y no volver a escanear: se firma con el previo, no con el 0 del reset", async () => {
  await RecepcionService.registrarConteos(D, ANA, [{ item_id: itemId(0), cantidad: 8 }]);
  await RecepcionService.recontar(D, ANA, [itemId(0)]);

  await firmar();
  assert.equal(renglon(0).cantidad_auditor, 8);
});

test("un escaneo después del recuento NO borra el previo (sigue pudiendo confirmar por repetición)", async () => {
  await RecepcionService.registrarConteos(D, ANA, [{ item_id: itemId(0), cantidad: 8 }]);
  await RecepcionService.recontar(D, ANA, [itemId(0)]);
  await RecepcionService.registrarConteos(D, ANA, [{ item_id: itemId(0), cantidad: 9 }]);

  const [fila] = conteos();
  assert.equal(fila.cantidad, 9);
  assert.equal(fila.conteo_previo, 8);

  await firmar();
  assert.equal(renglon(0).cantidad_auditor, 9, "el recuento nuevo manda");
});

/* ── COMPATIBILIDAD ────────────────────────────────────────────────────────── */

test("panel VIEJO (sin conteos en el servidor): se firma con el cuerpo, como antes", async () => {
  await firmar({ items: [{ id: itemId(0), cantidad_auditor: 7 }] });
  assert.equal(renglon(0).cantidad_auditor, 7);
});

test("sobrante del servidor que es un renglón de la lista se suma a ese renglón", async () => {
  bd.tablas.traslados_items[0].codigo_item = "189202";
  await RecepcionService.registrarConteos(D, ANA, [
    { item_id: itemId(0), cantidad: 5 },
    { codigo_item: "0189202", cantidad: 1 },
    { codigo_item: "777", descripcion: "Algo raro", cantidad: 2 },
  ]);

  await firmar();
  assert.equal(renglon(0).cantidad_auditor, 6);
  const extras = bd.tablas.traslados_items.filter((x) => x.agregado_por_auditor);
  assert.equal(extras.length, 1);
  assert.equal(extras[0].cantidad_auditor, 2);
});

/* ── MONITOR ───────────────────────────────────────────────────────────────── */

test("monitor: avance contra lo que VE el auditor, con quiénes cuentan", async () => {
  bd.tablas.traslados_items.push(item(3, { agotado: true }));
  await RecepcionService.registrarConteos(D, ANA, [{ item_id: itemId(0), cantidad: 3 }]);
  await RecepcionService.registrarConteos(D, BETO, [{ item_id: itemId(1), cantidad: 0, no_recibido: true }]);

  const [d] = await DespachoModel.findAllWithResumen({});
  assert.deepEqual(d.recepcion, { visibles: 3, contados: 2, auditores: [ANA, BETO] });
});
