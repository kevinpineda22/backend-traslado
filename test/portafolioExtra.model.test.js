import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

/* =============================================================================
   Modelos del portafolio extra y del catálogo contra un Supabase simulado.

   El simulado NO filtra: responde lo que cada test le configura por tabla y anota la
   cadena de llamadas, que es lo que se verifica (a qué bodega y destino se pregunta,
   cómo se limpia el texto de búsqueda, qué pasa si la tabla no existe).
   ============================================================================= */

let PortafolioExtra;
let Catalogo;

// Respuesta por tabla: { data, error } o una función que la calcula.
let respuestas = {};
let consultas = [];

function builder(tabla) {
  const q = { tabla, pasos: [] };
  consultas.push(q);
  const b = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") {
          return (resolve) => {
            const r = respuestas[tabla];
            resolve(typeof r === "function" ? r(q) : (r ?? { data: [], error: null }));
          };
        }
        return (...args) => {
          q.pasos.push([prop, ...args]);
          return b;
        };
      },
    },
  );
  return b;
}

const paso = (q, nombre) => q.pasos.find((p) => p[0] === nombre);

before(async () => {
  mock.module("../src/config/supabase.js", { exports: { supabase: { from: (t) => builder(t) } } });
  PortafolioExtra = await import("../src/models/PortafolioExtra.model.js");
  Catalogo = await import("../src/models/Catalogo.model.js");
  mock.method(console, "warn", () => {});
});

beforeEach(() => {
  respuestas = {};
  consultas = [];
});

test("codigosDe: devuelve los códigos de la sede como Set de texto", async () => {
  respuestas.traslados_portafolio_extra = { data: [{ codigo_item: "10" }, { codigo_item: " 20 " }], error: null };

  const set = await PortafolioExtra.codigosDe("00401");

  assert.deepEqual([...set], ["10", "20"]);
  assert.deepEqual(paso(consultas[0], "eq"), ["eq", "destino", "00401"]);
});

test("codigosDe: sin la tabla (migración 043 pendiente) devuelve vacío en vez de romper", async () => {
  respuestas.traslados_portafolio_extra = {
    data: null,
    error: { code: "42P01", message: 'relation "traslados_portafolio_extra" does not exist' },
  };

  assert.equal((await PortafolioExtra.codigosDe("00401")).size, 0);
});

test("codigosDe: cualquier otro error SÍ se propaga (un extra no desaparece en silencio)", async () => {
  respuestas.traslados_portafolio_extra = { data: null, error: { code: "08006", message: "connection failure" } };

  await assert.rejects(PortafolioExtra.codigosDe("00401"), /connection failure/);
});

test("extrasSinOrigen: devuelve los extras de la sede que NO tienen fila en el snapshot del origen", async () => {
  respuestas.traslados_portafolio_extra = { data: [{ codigo_item: "500" }, { codigo_item: "600" }], error: null };
  respuestas.traslados_snapshot = { data: [{ codigo_item: "600" }], error: null };

  const r = await PortafolioExtra.extrasSinOrigen("00401", "00301", ["500", "600", "700"]);

  assert.deepEqual(r, ["500"], "600 tiene fila en el origen; 700 no es extra");
  const extra = consultas.find((q) => q.tabla === "traslados_portafolio_extra");
  const snap = consultas.find((q) => q.tabla === "traslados_snapshot");
  assert.deepEqual(paso(extra, "eq"), ["eq", "destino", "00401"], "los extras son del DESTINO");
  assert.deepEqual(paso(snap, "eq"), ["eq", "bodega", "00301"], "la existencia se mira en el ORIGEN");
  assert.deepEqual(paso(snap, "in"), ["in", "codigo_item", ["500", "600"]], "solo se pregunta por los extras");
});

test("extrasSinOrigen: si ninguno es extra no toca el snapshot", async () => {
  respuestas.traslados_portafolio_extra = { data: [], error: null };

  const r = await PortafolioExtra.extrasSinOrigen("00401", "00301", ["1", "2"]);

  assert.deepEqual(r, []);
  assert.equal(consultas.some((q) => q.tabla === "traslados_snapshot"), false);
});

test("extrasSinOrigen: sin la tabla devuelve [] (no hay extras); otro error se propaga", async () => {
  respuestas.traslados_portafolio_extra = { data: null, error: { code: "PGRST205", message: "Could not find the table" } };
  assert.deepEqual(await PortafolioExtra.extrasSinOrigen("00401", "00301", ["1"]), []);

  respuestas.traslados_portafolio_extra = { data: null, error: { code: "57014", message: "statement timeout" } };
  await assert.rejects(PortafolioExtra.extrasSinOrigen("00401", "00301", ["1"]), /statement timeout/);
});

test("extrasSinOrigen: un error leyendo el snapshot del origen se propaga (el guardia falla cerrado)", async () => {
  respuestas.traslados_portafolio_extra = { data: [{ codigo_item: "500" }], error: null };
  respuestas.traslados_snapshot = { data: null, error: { message: "boom" } };

  await assert.rejects(PortafolioExtra.extrasSinOrigen("00401", "00301", ["500"]), /boom/);
});

test("agregar: si el ítem ya estaba devuelve creado:false y no inserta", async () => {
  respuestas.traslados_portafolio_extra = (q) =>
    q.pasos.some((p) => p[0] === "maybeSingle")
      ? { data: { destino: "00401", codigo_item: "100", agregado_por: "ana", created_at: "t" }, error: null }
      : { data: null, error: { message: "no debería insertar" } };

  const r = await PortafolioExtra.agregar({ destino: "00401", codigo_item: "100", agregado_por: "bea" });

  assert.equal(r.creado, false);
  assert.equal(r.fila.agregado_por, "ana");
  assert.equal(consultas.some((q) => paso(q, "insert")), false);
});

test("agregar: carrera entre dos administradores (23505) se resuelve como duplicado, no como error", async () => {
  let lecturas = 0;
  respuestas.traslados_portafolio_extra = (q) => {
    if (paso(q, "insert")) return { data: null, error: { code: "23505", message: "duplicate key" } };
    lecturas += 1;
    // La primera lectura (antes de insertar) no lo ve; la segunda (después del 23505) sí.
    return lecturas === 1
      ? { data: null, error: null }
      : { data: { destino: "00401", codigo_item: "100", agregado_por: "ana", created_at: "t" }, error: null };
  };

  const r = await PortafolioExtra.agregar({ destino: "00401", codigo_item: "100", agregado_por: "bea" });

  assert.equal(r.creado, false);
  assert.equal(r.fila.agregado_por, "ana");
});

test("quitar: true si existía, false si no", async () => {
  respuestas.traslados_portafolio_extra = { data: null, error: null, count: 1 };
  assert.equal(await PortafolioExtra.quitar("00401", "100"), true);
  respuestas.traslados_portafolio_extra = { data: null, error: null, count: 0 };
  assert.equal(await PortafolioExtra.quitar("00401", "100"), false);
});

/* ─── Catálogo: búsqueda ────────────────────────────────────────────── */

test("buscar: con menos de 2 caracteres no consulta", async () => {
  assert.deepEqual(await Catalogo.buscar("a"), []);
  assert.deepEqual(await Catalogo.buscar("  "), []);
  assert.equal(consultas.length, 0);
});

test("buscar: el match de código exacto va primero y no se repite", async () => {
  respuestas.traslados_catalogo = (q) =>
    paso(q, "eq")
      ? { data: [{ codigo_item: "19", descripcion: "ZZZ" }], error: null }
      : {
          data: [
            { codigo_item: "40", descripcion: "AAA 19" },
            { codigo_item: "19", descripcion: "ZZZ" },
          ],
          error: null,
        };

  const r = await Catalogo.buscar("19");

  assert.deepEqual(r.map((f) => f.codigo_item), ["19", "40"]);
});

test("buscar: limpia del texto lo que rompería el filtro .or() y respeta el tope", async () => {
  respuestas.traslados_catalogo = { data: [], error: null };

  await Catalogo.buscar("LECHE, (ENTERA) 100%_*", 5000);

  const parcial = consultas.find((q) => paso(q, "or"));
  const [, filtro] = paso(parcial, "or");
  assert.equal(filtro, "descripcion.ilike.%LECHE ENTERA 100%,referencia.ilike.%LECHE ENTERA 100%");
  assert.deepEqual(paso(parcial, "limit"), ["limit", 100], "tope de 100 aunque pidan más");
});

test("porCodigos: trocea los códigos para no exceder la URL", async () => {
  respuestas.traslados_catalogo = { data: [], error: null };
  const codigos = Array.from({ length: 650 }, (_, i) => String(i + 1));

  await Catalogo.porCodigos(codigos);

  const lotes = consultas.map((q) => paso(q, "in")[2].length);
  assert.deepEqual(lotes, [300, 300, 50]);
});
