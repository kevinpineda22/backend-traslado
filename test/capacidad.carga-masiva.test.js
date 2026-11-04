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

const fila = (codigo_item, unidad, capacidad, fijo = false, destino = "00401") => ({
  destino,
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

/* ─── Capacidad por destino (migración 042): Llano y Machado no se pisan ─── */

test("subir capacidad para Machado (01201) NO toca ninguna fila de Llano (00401)", async () => {
  const llanoAntes = structuredClone(bd.tablas.traslados_capacidad);

  // El MISMO ítem 600 existe en Llano con 12; en Machado se carga con 77.
  const r = await upsertBulk(
    [
      { item: "600", capacidad: 77 },
      { item: "999", capacidad: 5 },
    ],
    "01201",
  );

  assert.equal(r.guardadas, 2);
  const t = bd.tablas.traslados_capacidad;
  assert.deepEqual(
    t.filter((f) => f.destino === "00401"),
    llanoAntes,
    "las filas de Llano quedaron idénticas",
  );
  const machado = t.filter((f) => f.destino === "01201");
  assert.equal(machado.length, 2);
  assert.equal(machado.find((f) => f.codigo_item === "600").capacidad, 77);
  assert.equal(t.find((f) => f.destino === "00401" && f.codigo_item === "600").capacidad, 12);
});

test("sin destino, la carga va a Llano (compatibilidad con el front anterior)", async () => {
  await upsertBulk([{ item: "999", capacidad: 5 }]);

  const nueva = bd.tablas.traslados_capacidad.find((f) => f.codigo_item === "999");
  assert.equal(nueva.destino, "00401");
});

test("un ítem protegido en Llano NO queda protegido en Machado, y viceversa", async () => {
  // `fijo` es una decisión por tienda: lo medido a mano en Llano no dice nada de Machado.
  const r = await upsertBulk([{ item: "1455", capacidad: 321 }], "01201");

  assert.deepEqual(r.saltadas, []);
  assert.equal(r.guardadas, 1);
  assert.equal(
    bd.tablas.traslados_capacidad.find((f) => f.destino === "00401" && f.codigo_item === "1455").capacidad,
    200,
  );
  assert.equal(
    bd.tablas.traslados_capacidad.find((f) => f.destino === "01201" && f.codigo_item === "1455").capacidad,
    321,
  );
});

test("listar, mapaCapacidades y eliminar trabajan solo sobre el destino pedido", async () => {
  await upsertBulk([{ item: "600", capacidad: 77 }], "01201");

  assert.equal((await Modelo.listar("01201")).length, 1);
  assert.equal((await Modelo.listar()).length, 4, "sin destino = Llano");
  assert.equal((await Modelo.mapaCapacidades("01201")).get("600")[0].capacidad, 77);
  assert.equal((await Modelo.mapaCapacidades("00401")).get("600")[0].capacidad, 12);

  await Modelo.eliminar("600", "", "01201");

  assert.equal((await Modelo.listar("01201")).length, 0);
  assert.equal((await Modelo.listar("00401")).length, 4, "borrar en Machado no toca Llano");
});

test("actualizar (alta manual) escribe en el destino indicado sin pisar al otro", async () => {
  await Modelo.actualizar("600", 55, "X", "", null, "01201");

  const t = bd.tablas.traslados_capacidad;
  assert.equal(t.find((f) => f.destino === "01201" && f.codigo_item === "600").capacidad, 55);
  assert.equal(t.find((f) => f.destino === "00401" && f.codigo_item === "600").capacidad, 12);
});
