import { test, mock, before } from "node:test";
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
    exports: { mapaCapacidades: async () => new Map(), factoresDeItem: async () => new Map() },
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

const codigosDe = async () => {
  const { data, error } = await getProductosLlano({ origen: ORIGEN, destino: DESTINO });
  assert.equal(error, undefined);
  return data.map((p) => p.codigo_item).sort();
};

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
