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
// Páginas que dice tener la consulta. 1 = el caso real; >1 se usa para probar
// que una lectura partida NO se devuelve como si fuera completa.
let paginas;

const nota = (uuid) => `Traslado salida 00301 -> 00401 (despacho ${uuid})`;
const A = "afe067d3-bc4a-4d36-8c10-532967b929c9";
const B = "e128e90c-ad47-4ea9-8e50-3a4c1a4b5da3";

before(async () => {
  mock.module("../src/config/connekta.js", {
    exports: {
      // Una sola página, como en producción: la consulta de tránsito NO pagina.
      // `paginas` deja que un test simule el caso partido (ver el test del final).
      ejecutarConsulta: async () => ({
        datos: filas,
        total: filas.length,
        pagina: 1,
        totalPaginas: paginas,
      }),
    },
  });
  mod = await import("../src/services/siesaTransito.consulta.js");
});

beforeEach(() => {
  process.env.SIESA_CONSULTA_TRANSITO = "consulta_test";
  filas = [];
  paginas = 1;
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

test("existeSalida SÍ contesta con duplicados: la pregunta es otra", async () => {
  filas = [
    { CO: "001", Tipo: "CTS", Nro: 4775, Fecha: null, Notas: nota(A) },
    { CO: "001", Tipo: "CTS", Nro: 4773, Fecha: null, Notas: nota(A) },
  ];

  assert.equal(await mod.existeSalida(A), true, "¿ya se mandó? sí, dos veces");
  assert.equal(await mod.buscarSalida(A), null, "¿cuál referencio? no se puede saber");
  assert.equal(await mod.existeSalida(B), false);
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

/* -----------------------------------------------------------------------------
   FILA REPETIDA ≠ DOCUMENTO REPETIDO (2026-09-04)

   El verificador informaba "CTS 1757, 1757" y "CTE 1419, 1419" como duplicados
   y pedía borrar las sobrantes — sobre traslados sanos. Pero (C.O., tipo,
   consecutivo) es la LLAVE del documento en SIESA: dos filas con el mismo número
   son la misma fila devuelta dos veces por la consulta.

   Los duplicados de verdad (los del 19/08) se distinguen solos: llevan números
   DISTINTOS.
   -------------------------------------------------------------------------- */

test("el mismo documento repetido en la consulta cuenta UNA vez", async () => {
  filas = [
    { CO: "003", Tipo: "CTS", Nro: 1757, Fecha: "2026-09-04T00:00:00", Notas: nota(A) },
    { CO: "003", Tipo: "CTS", Nro: 1757, Fecha: "2026-09-04T00:00:00", Notas: nota(A) },
  ];

  const salida = await mod.buscarSalida(A);
  assert.ok(salida, "una fila repetida no puede dejar al despacho sin consecutivo");
  assert.equal(salida.nro, "1757");
});

test("pero dos documentos DISTINTOS siguen siendo duplicados", async () => {
  filas = [
    { CO: "001", Tipo: "CTS", Nro: 4773, Fecha: null, Notas: nota(A) },
    { CO: "001", Tipo: "CTS", Nro: 4773, Fecha: null, Notas: nota(A) },
    { CO: "001", Tipo: "CTS", Nro: 4775, Fecha: null, Notas: nota(A) },
  ];

  assert.equal(await mod.buscarSalida(A), null, "4773 y 4775 son dos documentos de verdad");
});

test("el mismo número en OTRO C.O. sí son dos documentos", async () => {
  // El consecutivo es por centro de operación: 003-CTS-1757 y 001-CTS-1757 son
  // dos documentos, no uno repetido. La llave incluye el C.O.
  filas = [
    { CO: "003", Tipo: "CTS", Nro: 1757, Fecha: null, Notas: nota(A) },
    { CO: "001", Tipo: "CTS", Nro: 1757, Fecha: null, Notas: nota(A) },
  ];

  assert.equal(await mod.buscarSalida(A), null);
});

test("la deduplicación no cruza las caras: una CTS y una CTE con el mismo nro conviven", async () => {
  filas = [
    { CO: "003", Tipo: "CTS", Nro: 1757, Fecha: null, Notas: nota(A) },
    { CO: "003", Tipo: "CTE", Nro: 1757, Fecha: null, Notas: nota(A) },
  ];

  assert.equal((await mod.buscarSalida(A)).nro, "1757");
  assert.equal((await mod.buscarEntrada(A)).nro, "1757");
});

/* -----------------------------------------------------------------------------
   UNA LECTURA PARCIAL NO SE DEVUELVE COMO COMPLETA (2026-09-04)

   La consulta no puede llevar ORDER BY (Connekta lo rechaza), y sin ORDER BY el
   motor no garantiza el orden entre páginas: pedir la 1 y después la 2 repite
   filas y SALTEA otras.

   Pasó de verdad, con 113 filas en 2 páginas: las CTE 1412, 1413 y 1415 no
   volvieron en ninguna página, y el verificador reportó tres pares abiertos que
   estaban cerrados desde el 29 de agosto.

   La fila repetida la tapa `indexar`. La SALTEADA no la tapa nada: si la entrada
   de un despacho no llega, `verificarEntradaPrevia` dice "no existe" y el sistema
   crea una SEGUNDA. Por eso, ante más de una página, esto LANZA. Frenar la
   entrada automática es lo correcto; devolver media lectura no.
   -------------------------------------------------------------------------- */

test("si la consulta no entra en una página, LANZA en vez de devolver media lectura", async () => {
  paginas = 2;
  filas = [{ CO: "003", Tipo: "CTS", Nro: 1750, Fecha: null, Notas: nota(A) }];

  await assert.rejects(
    () => mod.buscarEntrada(A),
    (e) => {
      assert.match(e.message, /p[áa]ginas/i);
      assert.match(e.message, /ORDER BY/, "el mensaje tiene que decir POR QUÉ no se pagina");
      return true;
    },
  );
});

test("y no deja el resultado parcial en el cache", async () => {
  paginas = 2;
  filas = [{ CO: "003", Tipo: "CTS", Nro: 1750, Fecha: null, Notas: nota(A) }];
  await assert.rejects(() => mod.buscarSalida(A));

  // Una lectura incompleta cacheada seguiría contestando "no existe" durante todo
  // el TTL, y esa es justo la respuesta que autoriza a escribir en el ERP.
  paginas = 1;
  assert.equal((await mod.buscarSalida(A)).nro, "1750");
});
