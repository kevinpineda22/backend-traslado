import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { crearBD } from "./helpers/fakeSupabase.js";

/* =============================================================================
   RECEPCIÓN POR CANASTILLA (migración 038)

   El auditor recibe canastilla por canastilla, a ciegas. Lo que tiene que valer:
     · nunca le llega una cantidad esperada ni el contenido de una canastilla;
     · al cerrar una, se compara SOLO esa;
     · la comparación final suma todas las zonas por producto (mal ubicado ≠ faltante);
     · nada se compara ni se firma con una canastilla a medio contar.
   ============================================================================= */

let bd;
let R; // recepcionContenedores.service
let Recepcion; // recepcion.service
let DespachoService;

const D = "d0000000-0000-4000-8000-000000000001";
const ANA = "ana@merkahorrosas.com";
const BETO = "beto@merkahorrosas.com";
const C15 = "c0000000-0000-4000-8000-000000000015";
const C22 = "c0000000-0000-4000-8000-000000000022";
const itemId = (n) => `a0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function item(n, over = {}) {
  return {
    id: itemId(n),
    despacho_id: D,
    codigo_item: String(1000 + n),
    descripcion: `Producto ${n}`,
    unidad_medida: "UND",
    factor: 1,
    cantidad_admin: 10,
    cantidad_despachador: 0,
    cantidad_suelta: 0,
    cantidad_auditor: null,
    agotado: false,
    motivo: null,
    no_recibido: false,
    siesa_omitido: false,
    ...over,
  };
}

const canastilla = (id, numero, over = {}) => ({
  id,
  despacho_id: D,
  numero,
  estado: "cerrado",
  no_listado: false,
  recepcion_estado: "pendiente",
  recepcion_por: null,
  recepcion_resultado: null,
  created_at: `2026-10-01T10:00:${numero}`,
  ...over,
});

function mockModulo(ruta, { exports: exportaciones }) {
  const mayor = Number(process.versions.node.split(".")[0]);
  mock.module(ruta, mayor >= 24 ? { exports: exportaciones } : { namedExports: exportaciones });
}

const contar = (conteos, por = ANA, disp = "cel-1") => Recepcion.registrarConteos(D, por, conteos, disp);
const en = (cid, n, cantidad) => ({ contenedor_id: cid, item_id: itemId(n), cantidad });
const can = (id) => bd.tablas.traslados_contenedores.find((c) => c.id === id);
const renglon = (n) => bd.tablas.traslados_items.find((x) => x.id === itemId(n));

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
    exports: { fichaDeItem: async (c) => ({ codigo_item: c }) },
  });
  mockModulo("../src/services/analitica.service.js", {
    exports: { analitica: async () => ({}) },
  });

  DespachoService = await import("../src/services/despacho.service.js");
  Recepcion = await import("../src/services/recepcion.service.js");
  R = await import("../src/services/recepcionContenedores.service.js");
});

beforeEach(() => {
  // Despacho: producto 0 → 4 en la 15 + 1 suelto; producto 1 (P6) → 2 P6 en la 15;
  // producto 2 → 3 en la 22.
  bd = crearBD({
    traslados_despachos: [
      { id: D, estado: "Recolectado", flujo: "general", origen: "PV001", destino: "00201", inactivo: false },
    ],
    traslados_items: [
      item(0, { cantidad_despachador: 5, cantidad_suelta: 1 }),
      item(1, { unidad_medida: "P6", factor: 6, cantidad_admin: 2, cantidad_despachador: 2 }),
      item(2, { cantidad_despachador: 3 }),
    ],
    traslados_firmas: [],
    traslados_contenedores: [canastilla(C15, "15"), canastilla(C22, "22")],
    traslados_contenedor_items: [
      { id: "x1", contenedor_id: C15, item_id: itemId(0), cantidad: 4 },
      { id: "x2", contenedor_id: C15, item_id: itemId(1), cantidad: 2 },
      { id: "x3", contenedor_id: C22, item_id: itemId(2), cantidad: 3 },
    ],
    traslados_recepcion_conteos: [],
  });
});

/* ── LA CEGUERA ────────────────────────────────────────────────────────────── */

test("el auditor ve números y estado, nunca el contenido", async () => {
  const lista = await R.listarParaAuditor(D);
  assert.deepEqual(lista.map((c) => c.numero), ["15", "22"]);
  for (const c of lista) {
    assert.equal(c.items, undefined);
    assert.equal(JSON.stringify(c).includes(itemId(0)), false);
  }
});

test("cerrar con diferencias NO devuelve cantidades esperadas; los no encontrados solo se cuentan", async () => {
  await contar([en(C15, 0, 3)]); // esperaba 4, y el P6 no se contó
  const r = await R.cerrar(D, C15, ANA);

  assert.equal(r.cerrado, false);
  assert.deepEqual(r.recontar, [
    { id: itemId(0), codigo_item: "1000", descripcion: "Producto 0", tipo: "diferencia" },
  ]);
  assert.equal(r.faltantes, 1, "el P6 que no se encontró, sin nombrarlo");
  const json = JSON.stringify(r);
  assert.equal(json.includes(itemId(1)), false, "no se nombra lo que falta");
  assert.equal(/esperad/i.test(json), false, "no viaja nada esperado");
  assert.equal(can(C15).recepcion_estado, "contando", "sigue abierta para recontar");
});

/* ── ENTRAR / VARIOS AUDITORES ─────────────────────────────────────────────── */

test("entrar la marca; otro auditor recibe aviso y puede tomarla", async () => {
  await R.entrar(D, C15, ANA);
  assert.equal(can(C15).recepcion_por, ANA);
  await assert.rejects(R.entrar(D, C15, BETO), (e) => e.codigo === "CANASTILLA_EN_USO" && e.quien === ANA);
  await R.entrar(D, C15, BETO, { tomar: true });
  assert.equal(can(C15).recepcion_por, BETO);
  // El traslado pasó a recepción.
  assert.equal(bd.tablas.traslados_despachos[0].estado, "En_recepcion");
});

test("lo que contó quien perdió la canastilla sigue sumando", async () => {
  await contar([en(C15, 0, 2)], ANA);
  await R.entrar(D, C15, BETO, { tomar: true });
  await contar([en(C15, 0, 2), en(C15, 1, 12)], BETO, "cel-b");
  const r = await R.cerrar(D, C15, BETO);
  assert.equal(r.cerrado, true, "2 de Ana + 2 de Beto = 4; 12 UND = 2 P6");
});

/* ── CERRAR ────────────────────────────────────────────────────────────────── */

test("cuadra en UND (2 P6 = 12) y se cierra con la foto guardada", async () => {
  await contar([en(C15, 0, 4), en(C15, 1, 12)]);
  const r = await R.cerrar(D, C15, ANA);
  assert.equal(r.cerrado, true);
  assert.equal(r.match, true);
  assert.equal(can(C15).recepcion_estado, "cerrado");
  assert.deepEqual(can(C15).recepcion_resultado.contado, { [itemId(0)]: 4, [itemId(1)]: 12 });
});

test("producto que no iba en esa canastilla: recontar como 'no_esperado'", async () => {
  await contar([en(C15, 0, 4), en(C15, 1, 12), en(C15, 2, 3)]);
  const r = await R.cerrar(D, C15, ANA);
  assert.equal(r.cerrado, false);
  assert.equal(r.recontar[0].tipo, "no_esperado");
});

test("recontar en la canastilla y repetir el número la confirma; lo no encontrado exige forzar", async () => {
  await contar([en(C15, 0, 3)]);
  await Recepcion.recontar(D, ANA, [itemId(0)], "cel-1", { contenedorId: C15 });
  await contar([en(C15, 0, 3)]);

  const r = await R.cerrar(D, C15, ANA);
  assert.equal(r.confirmadas, 1);
  assert.equal(r.recontar.length, 0);
  assert.equal(r.faltantes, 1);
  assert.equal(r.cerrado, false);

  const f = await R.cerrar(D, C15, ANA, { forzar: true });
  assert.equal(f.cerrado, true);
  assert.equal(can(C15).recepcion_resultado.forzado, true);
});

test("un sobrante fuera de lista se informa pero no pide recontar", async () => {
  await contar([en(C15, 0, 4), en(C15, 1, 12), { contenedor_id: C15, codigo_item: "777", cantidad: 1 }]);
  const r = await R.cerrar(D, C15, ANA);
  assert.equal(r.cerrado, true);
  assert.equal(r.sobrantes, 1);
});

test("contar en una canastilla ya cerrada vuelve en `fuera` y no se escribe", async () => {
  await contar([en(C15, 0, 4), en(C15, 1, 12)]);
  await R.cerrar(D, C15, ANA);
  const r = await contar([en(C15, 0, 9)], BETO, "cel-b");
  assert.equal(r.guardados, 0);
  assert.equal(r.fuera[0].codigo, "CANASTILLA_CERRADA");
  // Reabrir permite corregir.
  await R.reabrir(D, C15, BETO);
  assert.equal(can(C15).recepcion_estado, "contando");
  assert.equal(can(C15).recepcion_resultado, null);
});

/* ── NO LLEGÓ / NO ESTABA EN LA LISTA ──────────────────────────────────────── */

test("canastilla que no llegó: se descarta lo contado adentro", async () => {
  await contar([en(C22, 2, 1)]);
  await R.noRecibida(D, C22, ANA);
  assert.equal(can(C22).recepcion_estado, "no_recibido");
  assert.equal(bd.tablas.traslados_recepcion_conteos.filter((f) => f.contenedor_id === C22).length, 0);
});

test("canastilla que llegó sin estar en la lista; si el número sí está, no se duplica", async () => {
  const c = await R.registrarNoListada(D, "040", ANA);
  assert.equal(c.numero, "40");
  assert.equal(c.no_listado, true);
  assert.equal(c.recepcion_estado, "contando");
  await assert.rejects(R.registrarNoListada(D, "15", ANA), (e) => e.codigo === "CANASTILLA_EN_LISTA");
});

/* ── LA COMPARACIÓN FINAL ──────────────────────────────────────────────────── */

test("no se compara ni se firma con una canastilla sin cerrar", async () => {
  await assert.rejects(DespachoService.compararAuditoria(D, []), (e) => e.codigo === "CANASTILLAS_SIN_CERRAR");
  await assert.rejects(
    DespachoService.confirmarAuditoria(D, { decision: "aprobado", auditorId: ANA, firmaData: "x", items: [] }),
    (e) => e.codigo === "CANASTILLAS_SIN_CERRAR",
  );
});

test("mal ubicado: el total cuadra en la comparación final y el admin lo ve aparte", async () => {
  // El producto 2 iba en la 22 pero llegó en la 15.
  await contar([en(C15, 0, 4), en(C15, 1, 12), en(C15, 2, 3), { item_id: itemId(0), cantidad: 1 }]);
  await R.cerrar(D, C15, ANA, { forzar: true });
  await R.cerrar(D, C22, ANA, { forzar: true });

  const { match } = await DespachoService.compararAuditoria(D, []);
  assert.equal(match, true, "por producto, todo llegó");

  const det = await R.detalleAdmin(D);
  assert.deepEqual(det.mal_ubicados.map((m) => m.item_id), [itemId(2)]);
  assert.match(R.textoResumenCorreo(det), /mal ubicados/);

  await DespachoService.confirmarAuditoria(D, { decision: "aprobado", auditorId: ANA, firmaData: "x", items: [] });
  assert.equal(renglon(0).cantidad_auditor, 5, "4 en la 15 + 1 suelto");
  assert.equal(renglon(1).cantidad_auditor, 12);
  assert.equal(renglon(2).cantidad_auditor, 3);
});

test("canastilla no recibida: su contenido queda como faltante en la final", async () => {
  await contar([en(C15, 0, 4), en(C15, 1, 12), { item_id: itemId(0), cantidad: 1 }]);
  await R.cerrar(D, C15, ANA);
  await R.noRecibida(D, C22, ANA);
  const { match } = await DespachoService.compararAuditoria(D, []);
  assert.equal(match, false);
  await DespachoService.confirmarAuditoria(D, { decision: "inconsistencia", auditorId: ANA, firmaData: "x", items: [] });
  assert.equal(renglon(2).cantidad_auditor, 0);
  assert.equal(renglon(2).diferencia, -3);
});

test("recuento del traslado entero junta el producto de todas las zonas en una fila", async () => {
  await contar([en(C15, 0, 4), { item_id: itemId(0), cantidad: 1 }]);
  const filas = await Recepcion.recontar(D, ANA, [itemId(0)], "cel-1", { todas: true });
  const del0 = filas.filter((f) => f.item_id === itemId(0));
  assert.equal(del0.length, 1);
  assert.equal(del0[0].contenedor_id, null);
  assert.equal(del0[0].conteo_previo, 5);
});
