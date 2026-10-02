import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { crearBD } from "./helpers/fakeSupabase.js";

/* =============================================================================
   Hitos de la migración 039: `publicado_at` y `recepcion_iniciada_at`.

   Son las marcas con las que el Dashboard mide "Esperando despachador", "Cargue
   y viaje" y "Recibiendo". Se escriben en las transiciones de estado, que es
   donde viven todos los hitos del despacho. Se prueba contra los flujos REALES
   (la recepción por conteos de la 036 incluida), sobre la base falsa en memoria
   de `helpers/fakeSupabase.js` — mismo andamiaje que recepcion.conteos.test.js.

   Lo que tiene que valer siempre:
     · publicar (crear listo, finalizar borrador) sella `publicado_at`;
       un borrador no.
     · el primer conteo de quien recibe sella `recepcion_iniciada_at`, y un
       segundo conteo NO lo mueve.
     · un traslado que se firma sin pasar por En_recepcion (panel viejo, sin
       escaneos guardados) NO recibe la marca: queda fuera de las medianas en vez
       de mezclar definiciones.
   ============================================================================= */

let bd;
let DespachoModel;
let RecepcionService;
let DespachoService;

const D = "d0000000-0000-4000-8000-000000000039";
const ANA = "ana@merkahorrosas.com";
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
    publicado_at: null,
    recepcion_iniciada_at: null,
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

// Igual que en los tests de recepción: `mock.module` cambió de forma entre
// versiones de Node (`namedExports` hasta la 22, `exports` después).
function mockModulo(ruta, { exports: exportaciones }) {
  const mayor = Number(process.versions.node.split(".")[0]);
  mock.module(ruta, mayor >= 24 ? { exports: exportaciones } : { namedExports: exportaciones });
}

const cabecera = () => bd.tablas.traslados_despachos.find((d) => d.id === D);
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

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
  RecepcionService = await import("../src/services/recepcion.service.js");
  DespachoService = await import("../src/services/despacho.service.js");
});

beforeEach(() => {
  bd = crearBD({
    traslados_despachos: [despacho()],
    traslados_items: [item(0), item(1)],
    traslados_firmas: [],
    traslados_recepcion_conteos: [],
  });
});

/* ── recepcion_iniciada_at ─────────────────────────────────────────────────── */

test("el primer conteo de quien recibe sella recepcion_iniciada_at", async () => {
  await RecepcionService.registrarConteos(D, ANA, [{ item_id: itemId(0), cantidad: 4 }]);
  const d = cabecera();
  assert.equal(d.estado, "En_recepcion");
  assert.ok(d.recepcion_iniciada_at, "hito de inicio real de la recepción");
});

test("un segundo conteo NO mueve recepcion_iniciada_at", async () => {
  await RecepcionService.registrarConteos(D, ANA, [{ item_id: itemId(0), cantidad: 4 }]);
  const primero = cabecera().recepcion_iniciada_at;
  await dormir(5); // que un re-sellado se notara en el timestamp
  await RecepcionService.registrarConteos(D, ANA, [{ item_id: itemId(1), cantidad: 7 }]);
  assert.equal(cabecera().recepcion_iniciada_at, primero);
});

test("firmar sin pasar por En_recepcion (panel viejo) NO sella la marca", async () => {
  // Recolectado → firma directa: así cierra un panel que no guarda escaneos.
  await DespachoModel.updateStatus(D, "Recibido_con_inconsistencia");
  const d = cabecera();
  assert.equal(d.recepcion_iniciada_at, null);
  assert.ok(d.auditoria_finalizada_at, "el cierre sí se sella");
});

/* ── publicado_at ──────────────────────────────────────────────────────────── */

test("finalizar un borrador sella publicado_at", async () => {
  bd.tablas.traslados_despachos[0] = despacho({ estado: "Borrador" });
  await DespachoModel.finalizarBorrador(D);
  const d = cabecera();
  assert.equal(d.estado, "Creado");
  assert.ok(d.publicado_at);
});

test("Borrador → Creado por la puerta genérica también sella publicado_at", async () => {
  bd.tablas.traslados_despachos[0] = despacho({ estado: "Borrador" });
  await DespachoModel.updateStatus(D, "Creado");
  assert.ok(cabecera().publicado_at);
});

test("transiciones que no son publicación no tocan publicado_at", async () => {
  bd.tablas.traslados_despachos[0] = despacho({ estado: "Pendiente_carga" });
  await DespachoModel.updateStatus(D, "Recolectado");
  assert.equal(cabecera().publicado_at, null);
});

test("crear listo sella publicado_at; crear como borrador no", async () => {
  bd.tablas.traslados_despachos.length = 0;
  const base = { origen: "PV001", destino: "00201", admin_id: "admin@merkahorrosas.com", items: [] };
  const listo = await DespachoModel.create({ ...base });
  const borrador = await DespachoModel.create({ ...base, destino: "00601", estado: "Borrador" });
  const fila = (id) => bd.tablas.traslados_despachos.find((d) => d.id === id);
  assert.ok(fila(listo.id).publicado_at, "nace Creado → publicado");
  assert.equal(fila(listo.id).publicado_at, fila(listo.id).disponible_at, "mismo instante");
  assert.equal(fila(borrador.id).publicado_at ?? null, null, "un borrador nadie lo ve");
});

test("abandonar la recolección NO toca publicado_at (devolver al pool no es publicar)", async () => {
  const publicado = "2026-10-01T08:00:00.000Z";
  bd.tablas.traslados_despachos[0] = despacho({
    estado: "En_recoleccion",
    despachador_id: "desp@merkahorrosas.com",
    publicado_at: publicado,
  });
  await DespachoModel.abandonarRecoleccion(D, "desp@merkahorrosas.com");
  const d = cabecera();
  assert.equal(d.estado, "Creado");
  assert.equal(d.publicado_at, publicado);
});

/* ── clase A/B/C en obtener() ───────────────────────────────────────────────── */

test("obtener sin conClase no agrega la clase (panel del recibidor)", async () => {
  bd.tablas.traslados_despachos[0] = despacho({ destino: "00401", origen: "00301", flujo: "llano" });
  const d = await DespachoService.obtener(D);
  assert.ok(d.traslados_items.every((it) => !("clase" in it)));
});

test("obtener con conClase en General no agrega la clase", async () => {
  const d = await DespachoService.obtener(D, { conClase: true });
  assert.ok(d.traslados_items.every((it) => !("clase" in it)));
});

test("si leer la clase falla, el detalle sale igual con sus ítems", async () => {
  // El mock de siesa.service de este archivo NO trae clasesLlanoDeItems: la llamada
  // tira, y el detalle tiene que salir entero igual (es una columna informativa).
  bd.tablas.traslados_despachos[0] = despacho({ destino: "00401", origen: "00301", flujo: "llano" });
  const d = await DespachoService.obtener(D, { conClase: true });
  assert.equal(d.traslados_items.length, 2);
});
