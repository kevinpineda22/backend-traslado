import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

/* =============================================================================
   CERTIFICACIÓN: cómo se leen los documentos de tránsito de SIESA.

   El caso que da origen a este archivo es real. En SIESA hay despachos con TRES
   salidas (CTS 4773, 4775 y 4777, todas del despacho afe067d3-…): son los
   duplicados que dejó el bug del 19/08 y siguen ahí. Un índice plano se quedaba
   con "la primera" — y como la consulta no lleva ORDER BY, la primera es la que
   quiso el motor esa vez.

   Se prueba la asimetría deliberada entre las dos caras:
     - SALIDA duplicada  → no se elige ninguna (hay que referenciar UNA sola).
     - ENTRADA duplicada → se devuelve una igual (la pregunta es si EXISTE).
   ============================================================================= */

let mod;
let filas;

const nota = (uuid) => `Traslado salida 00301 -> 00401 (despacho ${uuid})`;
const A = "afe067d3-bc4a-4d36-8c10-532967b929c9";
const B = "e128e90c-ad47-4ea9-8e50-3a4c1a4b5da3";

before(async () => {
  mock.module("../src/config/connekta.js", {
    exports: {
      ejecutarConsultaCompleta: async () => ({
        datos: filas,
        total: filas.length,
        paginasObtenidas: 1,
        totalPaginas: 1,
      }),
    },
  });
  mod = await import("../src/services/siesaTransito.consulta.js");
});

beforeEach(() => {
  process.env.SIESA_CONSULTA_TRANSITO = "consulta_test";
  filas = [];
  mod.invalidarCache();
});

test("saca el uuid de las notas, y las notas de la ENTRADA también dicen 'salida'", () => {
  // SIESA hereda las notas del documento base al recibir el tránsito: el texto
  // NO dice qué cara es. Quien lo dice es el tipo de documento.
  assert.equal(mod.despachoIdDeNotas(nota(A)), A);
  assert.equal(mod.despachoIdDeNotas(`Traslado entrada X -> Y (despacho ${A})`), A);
  assert.equal(mod.despachoIdDeNotas("TRASLADO MAIZ NASARA"), null, "documento manual: no es nuestro");
  assert.equal(mod.despachoIdDeNotas(""), null);
  assert.equal(mod.despachoIdDeNotas(null), null);
});

test("EL CASO REAL: tres salidas del mismo despacho → no elige ninguna", async () => {
  filas = [
    { CO: "001", Tipo: "CTS", Nro: 4775, Fecha: "2026-08-19T00:00:00", Notas: nota(A) },
    { CO: "001", Tipo: "CTS", Nro: 4773, Fecha: "2026-08-19T00:00:00", Notas: nota(A) },
    { CO: "001", Tipo: "CTS", Nro: 4777, Fecha: "2026-08-19T00:00:00", Notas: nota(A) },
  ];

  assert.equal(await mod.buscarSalida(A), null, "con duplicados no se adivina el consecutivo");
});

test("una sola salida: la devuelve", async () => {
  filas = [{ CO: "003", Tipo: "CTS", Nro: 1754, Fecha: "2026-09-01T00:00:00", Notas: nota(A) }];

  const doc = await mod.buscarSalida(A);
  assert.equal(doc.nro, "1754");
  assert.equal(doc.co, "003");
});

test("entrada duplicada: SÍ devuelve una — si no, el sistema crearía una tercera", async () => {
  filas = [
    { CO: "004", Tipo: "CTE", Nro: 1416, Fecha: "2026-09-01T00:00:00", Notas: nota(A) },
    { CO: "004", Tipo: "CTE", Nro: 1417, Fecha: "2026-09-01T00:00:00", Notas: nota(A) },
  ];

  const doc = await mod.buscarEntrada(A);
  assert.ok(doc, "la respuesta a '¿ya existe?' sigue siendo sí");
  assert.equal(doc.nro, "1416", "la más baja, por orden estable");
});

test("no confunde las caras ni los despachos", async () => {
  filas = [
    { CO: "003", Tipo: "CTS", Nro: 1754, Fecha: null, Notas: nota(A) },
    { CO: "004", Tipo: "CTE", Nro: 1416, Fecha: null, Notas: nota(A) },
    { CO: "003", Tipo: "CTS", Nro: 1755, Fecha: null, Notas: nota(B) },
  ];

  assert.equal((await mod.buscarSalida(A)).nro, "1754");
  assert.equal((await mod.buscarEntrada(A)).nro, "1416");
  assert.equal((await mod.buscarSalida(B)).nro, "1755");
  assert.equal(await mod.buscarEntrada(B), null, "B no tiene entrada todavía");
});

test("ignora documentos manuales, consecutivos en 0 y tipos ajenos", async () => {
  filas = [
    { CO: "001", Tipo: "CTS", Nro: 4804, Fecha: null, Notas: "" },
    { CO: "001", Tipo: "CTS", Nro: 4783, Fecha: null, Notas: "TRASLADO MAIZ NASARO" },
    { CO: "001", Tipo: "CTS", Nro: 0, Fecha: null, Notas: nota(A) },
    { CO: "001", Tipo: "FAC", Nro: 99, Fecha: null, Notas: nota(A) },
  ];

  assert.equal(await mod.buscarSalida(A), null, "nada de eso cuenta como salida del despacho");
});

test("sin SIESA_CONSULTA_TRANSITO no inventa: lanza", async () => {
  delete process.env.SIESA_CONSULTA_TRANSITO;
  await assert.rejects(() => mod.buscarEntrada(A), /SIESA_CONSULTA_TRANSITO/);
});

test("el uuid se compara sin importar mayúsculas", async () => {
  filas = [{ CO: "003", Tipo: "CTS", Nro: 1754, Fecha: null, Notas: nota(A.toUpperCase()) }];
  assert.equal((await mod.buscarSalida(A)).nro, "1754");
});
