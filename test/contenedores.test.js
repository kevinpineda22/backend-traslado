import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { crearBD } from "./helpers/fakeSupabase.js";

/* =============================================================================
   CONTENEDORES (migración 037) — el total por producto siempre es
   suelto + Σ canastillas, y ninguna operación cotidiana lo descuadra.
   ============================================================================= */

let bd;
let DespachoService;
let DespachoModel;
let Contenedores;
let ContenedorModel;

const D = "d0000000-0000-4000-8000-000000000001";
const ANA = "ana@merkahorrosas.com";
const BETO = "beto@merkahorrosas.com";
const itemId = (n) => `a0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function despacho(over = {}) {
  return {
    id: D,
    estado: "En_recoleccion",
    flujo: "llano",
    origen: "00301",
    destino: "00401",
    inactivo: false,
    despachador_id: ANA,
    criterios: [],
    parte_num: null,
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
    cantidad_despachador: null,
    cantidad_suelta: null,
    agotado: false,
    motivo: null,
    recolectado_por: null,
    ...over,
  };
}

function mockModulo(ruta, { exports: exportaciones }) {
  const mayor = Number(process.versions.node.split(".")[0]);
  mock.module(ruta, mayor >= 24 ? { exports: exportaciones } : { namedExports: exportaciones });
}

const renglon = (n) => bd.tablas.traslados_items.find((x) => x.id === itemId(n));
const nuevo = async (numero, por = ANA) => (await Contenedores.crear(D, numero, por)).contenedor;
const meter = (c, n, cantidad, por = ANA) =>
  Contenedores.asignar(D, por, [{ contenedor_id: c.id, item_id: itemId(n), cantidad }]);
const suelto = (n, cantidad_suelta, por = ANA) =>
  DespachoService.registrarLoteRecoleccion(
    D,
    [{ id: itemId(n), cantidad: 0, agotado: false, cantidad_suelta }],
    por,
  );

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

  DespachoModel = await import("../src/models/Despacho.model.js");
  DespachoService = await import("../src/services/despacho.service.js");
  Contenedores = await import("../src/services/contenedores.service.js");
  ContenedorModel = await import("../src/models/Contenedor.model.js");
});

beforeEach(() => {
  bd = crearBD({
    traslados_despachos: [despacho()],
    traslados_items: [item(0), item(1), item(2)],
    traslados_firmas: [],
    traslados_contenedores: [],
    traslados_contenedor_items: [],
    traslados_recepcion_conteos: [],
  });
  bd.defaults.traslados_contenedores = { estado: "abierto", cerrado_por: null };
});

/* ── CREAR ─────────────────────────────────────────────────────────────────── */

test("el número se normaliza y no se puede repetir en el mismo traslado", async () => {
  const c = await nuevo(" 007 ");
  assert.equal(c.numero, "7");
  await assert.rejects(nuevo("7"), (e) => e.statusCode === 409 && e.codigo === "NUMERO_DUPLICADO");
  await assert.rejects(nuevo("0007", BETO), (e) => e.codigo === "NUMERO_DUPLICADO");
  assert.equal((await nuevo("c-15")).numero, "C-15");
});

test("no se crean contenedores fuera de la recolección", async () => {
  bd.tablas.traslados_despachos[0].estado = "Pendiente_carga";
  await assert.rejects(nuevo("1"), (e) => e.statusCode === 409);
});

/* ── EL TOTAL ──────────────────────────────────────────────────────────────── */

test("total = suelto + canastillas, escriba quien escriba y en el orden que sea", async () => {
  const c1 = await nuevo("1");
  const c2 = await nuevo("2", BETO);

  await meter(c1, 0, 4);
  assert.equal(renglon(0).cantidad_despachador, 4);
  await suelto(0, 3);
  assert.equal(renglon(0).cantidad_despachador, 7);
  await meter(c2, 0, 3, BETO); // otra persona, otra canastilla, mismo producto
  assert.equal(renglon(0).cantidad_despachador, 10);
  assert.equal(renglon(0).cantidad_suelta, 3);

  // Corregir una canastilla: el valor es TOTAL en esa canastilla, no un incremento.
  await meter(c1, 0, 2);
  assert.equal(renglon(0).cantidad_despachador, 8);
  // Reenviar el mismo lote (cola del celular) no cambia nada.
  await meter(c1, 0, 2);
  assert.equal(renglon(0).cantidad_despachador, 8);
});

test("el tope cuenta lo suelto y las OTRAS canastillas", async () => {
  const c1 = await nuevo("1");
  const c2 = await nuevo("2");
  await suelto(0, 5);
  await meter(c1, 0, 4);

  const r = await meter(c2, 0, 2);
  assert.equal(r.rechazados[0].codigo, "TOPE");
  assert.match(r.rechazados[0].error, /como máximo 1/);
  assert.equal(renglon(0).cantidad_despachador, 9, "no se escribió nada");
});

test("sacar un producto de la canastilla (0) borra la fila y baja el total", async () => {
  const c1 = await nuevo("1");
  await meter(c1, 1, 6);
  await meter(c1, 1, 0);
  assert.equal(bd.tablas.traslados_contenedor_items.length, 0);
  // Nunca se contó suelto: queda SIN contar, no "contado en cero".
  assert.equal(renglon(1).cantidad_despachador, null);
});

test("renglón contado antes de la 037 (sin cantidad_suelta) no pierde lo contado", async () => {
  Object.assign(renglon(0), { cantidad_despachador: 5, cantidad_suelta: null });
  const c1 = await nuevo("1");
  await meter(c1, 0, 2);
  assert.equal(renglon(0).cantidad_suelta, 5);
  assert.equal(renglon(0).cantidad_despachador, 7);
});

test("meter en canastilla desmiente 'agotado' (igual que escanearlo suelto)", async () => {
  Object.assign(renglon(0), { cantidad_despachador: 0, cantidad_suelta: 0, agotado: true, motivo: "sin_stock" });
  const c1 = await nuevo("1");
  await meter(c1, 0, 3);
  assert.equal(renglon(0).agotado, false);
  assert.equal(renglon(0).motivo, null);
});

test("un motivo que explica un faltante parcial se conserva al meter en canastilla", async () => {
  Object.assign(renglon(0), { cantidad_despachador: 2, cantidad_suelta: 2, motivo: "surtido_parcial" });
  const c1 = await nuevo("1");
  await meter(c1, 0, 3);
  assert.equal(renglon(0).motivo, "surtido_parcial");
  assert.equal(renglon(0).cantidad_despachador, 5);
});

/* ── LO SUELTO RESPETA LAS CANASTILLAS ─────────────────────────────────────── */

test("panel viejo (total sin cantidad_suelta) no puede bajar por debajo de las canastillas", async () => {
  const c1 = await nuevo("1");
  await meter(c1, 0, 6);
  await assert.rejects(
    DespachoService.registrarLoteRecoleccion(D, [{ id: itemId(0), cantidad: 4 }], ANA),
    (e) => e.statusCode === 422,
  );
  assert.equal(renglon(0).cantidad_despachador, 6);
  // Con un total mayor, lo suelto se deduce.
  await DespachoService.registrarLoteRecoleccion(D, [{ id: itemId(0), cantidad: 8 }], ANA);
  assert.equal(renglon(0).cantidad_suelta, 2);
});

test("con producto en canastillas no se marca agotado ni se cambia la unidad", async () => {
  const c1 = await nuevo("1");
  await meter(c1, 0, 2);
  await assert.rejects(
    DespachoService.registrarLoteRecoleccion(D, [{ id: itemId(0), cantidad: 0, agotado: true, cantidad_suelta: 0 }], ANA),
    (e) => e.statusCode === 422,
  );
  await assert.rejects(
    DespachoService.registrarLoteRecoleccion(
      D,
      [{ id: itemId(0), cantidad: 0, cantidad_suelta: 0, nueva_unidad_medida: "P6", nueva_cantidad_admin: 2, nuevo_factor: 6 }],
      ANA,
    ),
    (e) => e.statusCode === 422,
  );
});

/* ── CERRAR / REABRIR / BORRAR ─────────────────────────────────────────────── */

test("canastilla cerrada no recibe más; reabierta sí", async () => {
  const c1 = await nuevo("1");
  await meter(c1, 0, 2);
  await Contenedores.cerrar(D, c1.id, BETO);

  const r = await meter(c1, 0, 5);
  assert.equal(r.rechazados[0].codigo, "CONTENEDOR_CERRADO");
  assert.match(r.rechazados[0].error, /beto@/);

  await Contenedores.reabrir(D, c1.id, ANA);
  await meter(c1, 0, 5);
  assert.equal(renglon(0).cantidad_despachador, 5);
});

test("no se cierra vacía; no se borra con contenido; vacía se borra", async () => {
  const c1 = await nuevo("1");
  await assert.rejects(Contenedores.cerrar(D, c1.id, ANA), (e) => e.codigo === "CONTENEDOR_VACIO");
  await meter(c1, 0, 1);
  await assert.rejects(Contenedores.borrar(D, c1.id, ANA), (e) => e.codigo === "CONTENEDOR_CON_CONTENIDO");
  await meter(c1, 0, 0);
  await Contenedores.borrar(D, c1.id, ANA);
  assert.equal(bd.tablas.traslados_contenedores.length, 0);
});

/* ── FINALIZAR ─────────────────────────────────────────────────────────────── */

test("no se finaliza con una canastilla abierta; el despacho sigue en recolección", async () => {
  const c1 = await nuevo("15");
  await meter(c1, 0, 2);
  await assert.rejects(
    DespachoService.cambiarEstado(D, "Pendiente_carga"),
    (e) => e.codigo === "CONTENEDORES_ABIERTOS" && /15/.test(e.message),
  );
  assert.equal(bd.tablas.traslados_despachos[0].estado, "En_recoleccion");
});

test("finalizar RECALCULA el total con la lista quieta (la red de las carreras)", async () => {
  const c1 = await nuevo("1");
  await meter(c1, 0, 4);
  await suelto(0, 1);
  await Contenedores.cerrar(D, c1.id, ANA);
  // Una carrera de dos recálculos dejó un total viejo.
  renglon(0).cantidad_despachador = 4;

  await DespachoService.cambiarEstado(D, "Pendiente_carga");
  assert.equal(renglon(0).cantidad_despachador, 5);
  assert.equal(bd.tablas.traslados_despachos[0].estado, "Pendiente_carga");
});

/* ── ABANDONAR / DIVIDIR ───────────────────────────────────────────────────── */

test("abandonar se lleva las canastillas con el conteo", async () => {
  const c1 = await nuevo("1");
  await meter(c1, 0, 4);
  await DespachoService.abandonarRecoleccion(D, ANA);
  assert.equal(bd.tablas.traslados_contenedores.length, 0);
  assert.equal(bd.tablas.traslados_contenedor_items.length, 0);
  assert.equal(renglon(0).cantidad_despachador, null);
  assert.equal(renglon(0).cantidad_suelta, null);
});

/*
 * UNA CANASTILLA ABIERTA YA NO BLOQUEA LA SEGUNDA PARTE — y antes sí.
 *
 * El bloqueo existía cuando partir lo hacía el DESPACHADOR: "cerrá la canastilla
 * 1 antes de enviar" era algo que podía hacer ahí mismo. Ahora parte el ADMIN
 * desde el monitor, y ese mensaje le pedía algo que no está en sus manos.
 *
 * No se perdió ninguna red: lo que está en una canastilla está CONTADO, y lo
 * contado nunca se muda. La integridad que importaba —no cerrar el conteo con
 * una canastilla a medio declarar— sigue cubierta en el cierre, por
 * `validarParaFinalizar` (ver el test "no se finaliza con una canastilla
 * abierta" más arriba).
 */
test("segunda parte con canastilla ABIERTA: se parte igual y lo de la canastilla se queda", async () => {
  const c1 = await nuevo("1");
  await meter(c1, 0, 4);

  const { parte2 } = await DespachoService.dividirEnPartes(D);

  assert.equal(renglon(0).despacho_id, D, "lo que está en la canastilla está contado: se queda");
  assert.equal(renglon(1).despacho_id, parte2.id, "lo que nadie tocó se va a la parte 2");

  // La canastilla sigue en la parte 1, y sigue abierta: no se tocó.
  const c = bd.tablas.traslados_contenedores.find((x) => x.id === c1.id);
  assert.equal(c.despacho_id, D);
  assert.notEqual(c.estado, "cerrado");

  // Y la parte 1 NO se puede cerrar con ella abierta: la red quedó donde debía.
  await assert.rejects(
    DespachoService.cambiarEstado(D, "Pendiente_carga"),
    (e) => e.codigo === "CONTENEDORES_ABIERTOS",
    "partir no habilita cerrar con una canastilla abierta",
  );
});

test("segunda parte con canastilla CERRADA: igual que antes", async () => {
  const c1 = await nuevo("1");
  await meter(c1, 0, 4);
  await Contenedores.cerrar(D, c1.id, ANA);

  const { parte2 } = await DespachoService.dividirEnPartes(D);
  assert.equal(renglon(0).despacho_id, D, "lo que está en la canastilla se queda");
  assert.equal(renglon(1).despacho_id, parte2.id);
});

/* ── MANIFIESTO ────────────────────────────────────────────────────────────── */

test("resumen del manifiesto: canastillas y suelto, en unidades base y kg", () => {
  const items = [
    { id: "i1", factor: 6, peso_unitario: 500, cantidad_despachador: 3 },
    { id: "i2", factor: 1, peso_unitario: null, cantidad_despachador: 4 },
  ];
  const contenedores = [{ numero: "15", items: [{ item_id: "i1", cantidad: 2 }] }];
  const r = Contenedores.resumenParaManifiesto(items, contenedores);
  assert.deepEqual(r.contenedores, [{ numero: "15", productos: 1, unidades: 12, peso_kg: 6 }]);
  // Suelto: 1 P6 de i1 + 4 de i2 (sin peso ⇒ el peso del grupo es desconocido).
  assert.deepEqual(r.suelto, { productos: 2, unidades: 10, peso_kg: null });
  assert.equal(Contenedores.resumenParaManifiesto(items, []), null);
});

test("normalizarNumero", () => {
  assert.equal(ContenedorModel.normalizarNumero(" 0 "), "0");
  assert.equal(ContenedorModel.normalizarNumero("a  b"), "A B");
});
