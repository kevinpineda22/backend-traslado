import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

/* =============================================================================
   Panel "Nuevo despacho" con destino Girardota Llano: SOLO productos de Llano.

   El panel recorría la unión origen ∪ destino, así que al elegir Llano aparecía
   todo el catálogo de Girardota Parque, aunque Llano nunca hubiera manejado esos
   ítems. El filtro de CAT no lo atajaba (el CAT es del maestro del ítem, así que
   se leía el del origen, que es el mismo).

   Se prueba sin tocar Supabase ni Connekta:
     - un ítem que solo tiene el origen NO aparece;
     - un ítem de Llano en CERO sí aparece (es lo que más hay que reponer);
     - un ítem que solo tiene Llano aparece si lo necesita, y no si no.

   `calcularSugeridoABC` se reemplaza por `consumoDiario` para controlar la
   necesidad desde el fixture: acá importa QUÉ ítems salen, no la cuenta A/B/C.
   ============================================================================= */

const ORIGEN = "00301";
const DESTINO = "00401";

let getProductosLlano;
let clasesLlanoDeItems;
let filas = [];
/** codigo → filas de traslados_capacidad, en el formato de `mapaCapacidades`. */
let capacidades = new Map();

/** Fila del snapshot con lo mínimo que lee getProductosLlano. */
const fila = (bodega, codigo, { disponible = 10, consumo = 0, cat = "CATEGORIA TIPO A" } = {}) => ({
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
  criterios: { CAT: cat },
});

before(async () => {
  mock.module("../src/services/snapshot.service.js", {
    exports: {
      leerBodegas: async () => filas,
      leerBodegasItems: async (bodegas, codigos) =>
        filas.filter((f) => bodegas.includes(f.bodega) && codigos.includes(f.codigo_item)),
    },
  });
  mock.module("../src/models/Capacidad.model.js", {
    exports: { mapaCapacidades: async () => capacidades, factoresDeItem: async () => new Map() },
  });
  mock.module("../src/models/Config.model.js", {
    exports: {
      obtener: async () => ({ llano: { A: 1, B: 3, C: 5 }, general: { periodoCubrimiento: null } }),
    },
  });
  mock.module("../src/config/supabase.js", { exports: { supabase: {} } });
  mock.module("../src/services/sugerido.service.js", {
    exports: {
      calcularSugeridoABC: ({ consumoDiario }) => consumoDiario,
      calcularSugeridoGeneral: () => ({ stockSeguridad: 0, necesidad: 0 }),
    },
  });

  ({ getProductosLlano, clasesLlanoDeItems } = await import("../src/services/siesa.service.js"));
});

beforeEach(() => {
  capacidades = new Map();
});

const productosDe = async () => {
  const { data, error } = await getProductosLlano({ origen: ORIGEN, destino: DESTINO });
  assert.equal(error, undefined);
  return data;
};

const codigosDe = async () => (await productosDe()).map((p) => p.codigo_item).sort();

/** Fila de capacidad como la devuelve `mapaCapacidades` (clave ya normalizada). */
const conCapacidad = (codigo, capacidad, extra = {}) =>
  capacidades.set(codigo, [
    { capacidad, unidad: "", factor: null, multi_um: false, ...extra },
  ]);

test("un ítem que SOLO tiene el origen no aparece en el panel de Llano", async () => {
  filas = [
    fila(ORIGEN, "1"), fila(DESTINO, "1"), // de los dos → sale
    fila(ORIGEN, "2"), // solo Girardota Parque → NO sale
  ];
  assert.deepEqual(await codigosDe(), ["1"]);
});

test("aunque tenga CAT 'SIN CLASIFICACION', un ítem solo del origen no se cuela", async () => {
  // Era el agujero: el CAT no vacío pasaba el filtro y el ítem se mostraba como "Ninguno".
  // Llano tiene otro ítem (si no tuviera ninguno, el panel avisa "sin datos").
  filas = [fila(ORIGEN, "2", { cat: "SIN CLASIFICACION" }), fila(ORIGEN, "1"), fila(DESTINO, "1")];
  assert.deepEqual(await codigosDe(), ["1"]);
});

test("un ítem de Llano en CERO sigue apareciendo", async () => {
  // Agotado en Llano, con stock en Parque: es justo lo que hay que reponer.
  filas = [fila(ORIGEN, "3", { disponible: 50 }), fila(DESTINO, "3", { disponible: 0 })];
  assert.deepEqual(await codigosDe(), ["3"]);
});

test("un ítem que SOLO tiene Llano aparece si lo necesita, y no si no", async () => {
  filas = [
    fila(DESTINO, "4", { consumo: 5 }), // necesidad > 0 → sale (se manda desde otra sede)
    fila(DESTINO, "5", { consumo: 0 }), // necesidad 0 y sin origen → no sale
  ];
  assert.deepEqual(await codigosDe(), ["4"]);
});

test("los filtros de CAT de Llano se mantienen: vacío y descodificados fuera", async () => {
  // Mismo CAT en las dos bodegas: el CAT es del maestro del ítem, no de la bodega.
  filas = [
    fila(ORIGEN, "6", { cat: "" }), fila(DESTINO, "6", { cat: "" }),
    fila(ORIGEN, "7", { cat: "Descodificados" }), fila(DESTINO, "7", { cat: "Descodificados" }),
  ];
  assert.deepEqual(await codigosDe(), []);
});

/* ─── Productos que Llano todavía no registra ─────────────────────────────────
   SIESA solo devuelve una fila por (ítem, bodega) cuando el ítem se movió alguna
   vez en esa bodega. Un producto nuevo queda encerrado: Llano no lo tiene → no
   sale en el panel → nadie se lo despacha → nunca se mueve → Llano no lo tiene.
   La capacidad cargada a mano es la única puerta que rompe ese círculo.
   ────────────────────────────────────────────────────────────────────────────── */

test("un ítem que Llano todavía no registra entra si tiene capacidad cargada", async () => {
  // El caso del 189409 (ARROZ FEDERAL, 20/10/2026): SIESA lo tenía en Parque y en
  // otras cinco bodegas, en Llano en ninguna. Sin esto no hay primer despacho.
  filas = [fila(ORIGEN, "1"), fila(DESTINO, "1"), fila(ORIGEN, "189409", { disponible: 48 })];
  conCapacidad("189409", 4);
  assert.deepEqual(await codigosDe(), ["1", "189409"]);
});

test("el que entra por capacidad queda marcado, con inventario de destino en 0", async () => {
  filas = [fila(ORIGEN, "1"), fila(DESTINO, "1"), fila(ORIGEN, "189409", { disponible: 48 })];
  conCapacidad("189409", 4);

  const productos = await productosDe();
  const nuevo = productos.find((p) => p.codigo_item === "189409");
  assert.equal(nuevo.sin_registro_destino, true, "el 0 de abajo no es un agotado medido");
  assert.equal(nuevo.inventario_destino, 0);
  assert.equal(nuevo.capacidad, 4);
  assert.equal(nuevo.disponible_origen, 48);

  const conocido = productos.find((p) => p.codigo_item === "1");
  assert.equal(conocido.sin_registro_destino, false, "el que SÍ tiene fila en Llano no se marca");
});

test("capacidad en 0 no alcanza para entrar", async () => {
  // El sugerido daría 0 y la fila no serviría para nada. Hay filas en 0 a propósito.
  filas = [fila(ORIGEN, "1"), fila(DESTINO, "1"), fila(ORIGEN, "2")];
  conCapacidad("2", 0);
  assert.deepEqual(await codigosDe(), ["1"]);
});

test("sin existencia en el origen no entra, aunque tenga capacidad cargada", async () => {
  // No hay de dónde leer descripción, CAT ni UM, y no hay nada que mandar.
  // Hoy el filtro de CAT lo atajaría igual (sin fila en ninguna bodega, el CAT
  // sale vacío), así que esto fija la intención: la guarda de origen es explícita
  // para no depender de ese rebote y para que `fuente` nunca llegue indefinida.
  filas = [fila(ORIGEN, "1"), fila(DESTINO, "1")];
  conCapacidad("77", 10);
  assert.deepEqual(await codigosDe(), ["1"]);
});

test("la capacidad no saltea los filtros de CAT: vacío y descodificados siguen fuera", async () => {
  filas = [
    fila(ORIGEN, "1"), fila(DESTINO, "1"),
    fila(ORIGEN, "8", { cat: "" }),
    fila(ORIGEN, "9", { cat: "Descodificados" }),
  ];
  conCapacidad("8", 10);
  conCapacidad("9", 10);
  assert.deepEqual(await codigosDe(), ["1"]);
});

test("sin fila en el destino, la clase A/B/C sale del CAT del origen", async () => {
  // El CAT es del maestro del ítem: es el mismo en toda bodega. Leyéndolo solo del
  // destino, estos ítems entrarían siempre como "ninguno" y con la cadencia de C.
  filas = [
    fila(ORIGEN, "1"), fila(DESTINO, "1"),
    fila(ORIGEN, "2", { cat: "CATEGORIA TIPO B" }),
  ];
  conCapacidad("2", 10);
  const nuevo = (await productosDe()).find((p) => p.codigo_item === "2");
  assert.equal(nuevo.clase, "B");
});

/* ─── Clase A/B/C para el monitor ─────────────────────────────────────────── */

test("clasesLlanoDeItems deriva la clase con la misma regla que el panel de armado", async () => {
  filas = [
    fila(DESTINO, "10", { cat: "CATEGORIA TIPO A" }),
    fila(DESTINO, "11", { cat: "categoria tipo b" }), // mayúsculas no importan
    fila(DESTINO, "12", { cat: "SIN CLASIFICACION" }),
  ];
  const clases = await clasesLlanoDeItems(DESTINO, ["10", "11", "12"]);
  assert.equal(clases.get("10"), "A");
  assert.equal(clases.get("11"), "B");
  assert.equal(clases.get("12"), "ninguno");
});

test("un ítem que no está en el snapshot queda FUERA del mapa (no 'ninguno')", async () => {
  // "No sé su clase" y "no tiene clase" son distintos: el monitor pinta un guion
  // para el primero y "Ninguno" para el segundo.
  filas = [fila(DESTINO, "10")];
  const clases = await clasesLlanoDeItems(DESTINO, ["10", "99"]);
  assert.equal(clases.get("10"), "A");
  assert.equal(clases.has("99"), false);
});
