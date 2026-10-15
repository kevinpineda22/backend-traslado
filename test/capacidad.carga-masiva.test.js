import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { crearBD } from "./helpers/fakeSupabase.js";

/* =============================================================================
   Carga masiva de capacidades: no puede tocar un ítem protegido.

   CONTEXTO (2026-10-15)
   Alguien usó "eliminar todo" y después subió un Excel en la pantalla de
   Capacidad · Llano. La tabla quedó reemplazada: se perdieron 157 filas
   protegidas —huevos, café en tiras, frijol a granel— y las 63 filas por unidad
   de medida. Se recuperaron desde un backup del día.

   `fijo` marca los ítems cuya capacidad NO sale de una fuente automática: alguien
   la midió y la cargó a mano. Ninguna escritura a granel debe poder reescribirla,
   venga de un Excel, de SRI o de un script.

   Estos tests existen porque cuando se agregó la guarda, ni `upsertBulk` ni
   `eliminarTodos` tenían una sola prueba: se pudo borrar una función entera y
   cambiarle el tipo de retorno a otra sin que la suite se enterara.
   ============================================================================= */

let upsertBulk;
let Modelo;
let bd;

before(async () => {
  bd = crearBD({ traslados_capacidad: [] });
  mock.module("../src/config/supabase.js", { exports: { supabase: bd.supabase } });
  Modelo = await import("../src/models/Capacidad.model.js");
  ({ upsertBulk } = Modelo);
});

const fila = (codigo_item, unidad, capacidad, fijo = false) => ({
  codigo_item,
  unidad,
  capacidad,
  factor: unidad ? 1 : null,
  fijo,
  descripcion: `D${codigo_item}`,
  updated_at: "viejo",
});

beforeEach(() => {
  bd.tablas.traslados_capacidad = [
    fila("1455", "", 200, true), // protegido: CHOCORAMO cargado a mano
    fila("0000019", "", 15, true), // protegido y con ceros a la izquierda
    fila("600", "", 12, false), // normal
    fila("601", "", 20, false), // normal
  ];
  bd.log.length = 0;
  bd.hooks.antesDe = null;
});

test("una carga masiva NO pisa la capacidad de un ítem protegido", async () => {
  const r = await upsertBulk([
    { item: "1455", capacidad: 999 },
    { item: "600", capacidad: 30 },
  ]);

  assert.deepEqual(r.saltadas, ["1455"]);
  assert.equal(r.guardadas, 1);

  const t = bd.tablas.traslados_capacidad;
  assert.equal(t.find((f) => f.codigo_item === "1455").capacidad, 200, "el protegido quedó intacto");
  assert.equal(t.find((f) => f.codigo_item === "600").capacidad, 30, "el normal sí se actualizó");
});

test("el ítem protegido se reconoce aunque el Excel traiga el código sin ceros", async () => {
  // En la tabla está como "0000019" y el Excel manda "19". Sin normalizar las dos
  // puntas, la guarda no lo reconocería y lo pisaría.
  const r = await upsertBulk([{ item: "19", capacidad: 78 }]);

  assert.deepEqual(r.saltadas, ["19"]);
  assert.equal(r.guardadas, 0);
  assert.equal(
    bd.tablas.traslados_capacidad.find((f) => f.codigo_item === "0000019").capacidad,
    15,
    "el frijol a granel conservó su capacidad cargada a mano",
  );
});

test("un ítem protegido bloquea TODAS sus filas, no solo la que coincide de UM", async () => {
  // `fijo` es propiedad del ÍTEM (ver sql/040 y sql/026). Si la guarda mirara la
  // fila y no el ítem, una carga con otra UM entraría por el costado.
  const r = await upsertBulk([{ item: "1455", um: "P5", capacidad: 180, factor: 5 }]);

  assert.deepEqual(r.saltadas, ["1455"]);
  assert.equal(r.guardadas, 0);
  assert.equal(bd.tablas.traslados_capacidad.length, 4, "no se creó una fila P5");
});

test("sin ítems protegidos en el lote, la carga escribe todo y no reporta saltadas", async () => {
  const r = await upsertBulk([
    { item: "600", capacidad: 30 },
    { item: "601", capacidad: 40 },
  ]);

  assert.deepEqual(r.saltadas, []);
  assert.equal(r.guardadas, 2);
});

test("un mismo ítem protegido repetido en el Excel se informa una sola vez", async () => {
  const r = await upsertBulk([
    { item: "1455", capacidad: 1 },
    { item: "1455", um: "P5", capacidad: 2 },
    { item: "0001455", capacidad: 3 },
  ]);

  assert.deepEqual(r.saltadas, ["1455"]);
  assert.equal(r.guardadas, 0);
});

test("ya no existe `eliminarTodos`: vaciar la tabla no es una operación disponible", () => {
  // Fue la mitad destructiva del incidente. Si alguien la reintroduce, este test
  // falla y lo manda a leer el porqué antes de seguir.
  assert.equal(
    Modelo.eliminarTodos,
    undefined,
    "para borrar una fila puntual está `eliminar(codigoItem, unidad)`",
  );
});
