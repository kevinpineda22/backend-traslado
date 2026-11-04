import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

/* =============================================================================
   Sede NUEVA (Machado, 01201) sin filas en el snapshot de SIESA.

   Una bodega recién creada no tiene filas en t400 hasta que se mueve su primer
   ítem. Antes, `getProductosLlano` devolvía "Sin datos de inventario" ANTES de
   mirar la capacidad cargada, así que la sede nueva nunca mostraba productos aunque
   el admin ya hubiera subido su Excel de capacidad.

   Acá NO se mockea `sugerido.service`: lo que se verifica es el sugerido REAL de un
   destino sin inventario ni consumo (sugerido = capacidad: "llenar la góndola").
   ============================================================================= */

const ORIGEN = "PV001";
const DESTINO = "01201";

let getProductosLlano;
let getDisponibilidadItem;
let filas = [];
let capacidades = new Map();

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

  ({ getProductosLlano, getDisponibilidadItem } = await import("../src/services/siesa.service.js"));
});

beforeEach(() => {
  filas = [];
  capacidades = new Map();
});

test("sede nueva sin filas en el snapshot + capacidad cargada: el ítem del origen aparece", async () => {
  filas = [fila(ORIGEN, "7", { disponible: 30 }), fila(ORIGEN, "8", { disponible: 5 })];
  conCapacidad("7", 50);

  const { data, error } = await getProductosLlano({ origen: ORIGEN, destino: DESTINO });

  assert.equal(error, undefined);
  assert.deepEqual(data.map((p) => p.codigo_item), ["7"], "el 8 no tiene capacidad: no entra");
  const p = data[0];
  assert.equal(p.inventario_destino, 0);
  assert.equal(p.consumo_destino, 0);
  assert.equal(p.sin_registro_destino, true, "se marca: ese 0 no es un agotado medido");
  assert.equal(p.sugerido, 50, "sugerido = capacidad (llenar la góndola)");
  assert.equal(p.necesidad, 50);
  assert.equal(p.disponible_origen, 30);
  assert.equal(p.faltante, 20, "lo que el origen no alcanza a cubrir");
  assert.equal(p.clase, "A", "la clase sale del CAT del origen (es del ítem)");
  assert.equal(p.dias_capacidad, null);
  assert.equal(p.dias_inventario, null);
  assert.equal(p.descripcion, "ITEM 7");
});

test("la forma de la respuesta es la misma que con filas del destino", async () => {
  filas = [fila(ORIGEN, "7", { disponible: 30 }), fila(ORIGEN, "9"), fila(DESTINO, "9", { consumo: 2 })];
  conCapacidad("7", 50);
  conCapacidad("9", 20);

  const { data } = await getProductosLlano({ origen: ORIGEN, destino: DESTINO });

  const sinRegistro = data.find((p) => p.codigo_item === "7");
  const conRegistro = data.find((p) => p.codigo_item === "9");
  assert.deepEqual(Object.keys(sinRegistro).sort(), Object.keys(conRegistro).sort());
});

test("sin filas del destino y sin capacidad: sigue el error, y explica cómo salir", async () => {
  filas = [fila(ORIGEN, "7")];

  const { data, error } = await getProductosLlano({ origen: ORIGEN, destino: DESTINO });

  assert.equal(data, undefined);
  assert.match(error, /Sin datos de inventario para la bodega 01201 en el snapshot/);
  assert.match(error, /Connekta/);
  assert.match(error, /módulo Capacidad/);
});

test("capacidad en 0, o de un ítem que no está en el origen, no alcanza para evitar el error", async () => {
  filas = [fila(ORIGEN, "7")];
  conCapacidad("7", 0); // sin utilidad: el sugerido daría 0
  conCapacidad("99", 40); // el origen no lo tiene: no hay de dónde leer descripción ni stock

  const { error } = await getProductosLlano({ origen: ORIGEN, destino: DESTINO });

  assert.match(error, /Sin datos de inventario para la bodega 01201/);
});

test("Llano con filas del destino se comporta como siempre (sin capacidad no agrega ítems del origen)", async () => {
  filas = [fila("00301", "1"), fila("00401", "1", { consumo: 1 }), fila("00301", "2")];

  const { data, error } = await getProductosLlano({ origen: "00301", destino: "00401" });

  assert.equal(error, undefined);
  assert.deepEqual(data.map((p) => p.codigo_item), ["1"]);
  assert.equal(data[0].sin_registro_destino, false);
});

test("Llano sin filas y sin capacidad sigue dando el error", async () => {
  filas = [fila("00301", "1")];

  const { error } = await getProductosLlano({ origen: "00301", destino: "00401" });

  assert.match(error, /Sin datos de inventario para la bodega 00401/);
});

test("getDisponibilidadItem con un destino sin fila: inventario 0 y necesidad = capacidad", async () => {
  filas = [fila(ORIGEN, "7", { disponible: 30 })];
  conCapacidad("7", 50);

  const { data, error } = await getDisponibilidadItem({ codigo: "7", destino: DESTINO });

  assert.equal(error, undefined);
  assert.equal(data.inventario_destino, 0);
  assert.equal(data.necesidad, 50);
  assert.equal(data.flujo, "machado");
  const plaza = data.sedes.find((s) => s.codigo === ORIGEN);
  assert.equal(plaza.sugerido, 30, "tope por lo disponible en esa sede");
});
