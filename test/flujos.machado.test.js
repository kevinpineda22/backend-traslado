import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FLUJOS,
  SEDES,
  getFlujoPorDestino,
  bodegasInvolucradas,
  esFlujoAbc,
  esDestinoAbc,
  destinosAbc,
  centroOperacionDeSede,
  listarFlujos,
} from "../src/config/flujos.js";

/* Machado (PV001 → 01201) es un flujo A/B/C idéntico a Llano salvo origen/destino.
   PV001 pasa a ser origen de DOS flujos: todo lo que resuelva el flujo tiene que
   hacerlo por DESTINO, que sí es único. */

test("Machado está definido como flujo A/B/C con origen PV001 y destino 01201", () => {
  assert.equal(SEDES["01201"], "Machado");
  assert.deepEqual(FLUJOS.machado, {
    id: "machado",
    nombre: "Traslado Machado",
    origen: "PV001",
    destinos: ["01201"],
    logica: "abc",
  });
  assert.equal(centroOperacionDeSede("01201"), "012");
});

test("el flujo se resuelve por destino aunque PV001 sea origen de dos flujos", () => {
  assert.equal(getFlujoPorDestino("01201").id, "machado");
  assert.equal(getFlujoPorDestino("00401").id, "llano");
  assert.equal(getFlujoPorDestino("00201").id, "general");
});

test("bodegasInvolucradas incluye 01201 y no duplica PV001", () => {
  const b = bodegasInvolucradas();
  assert.ok(b.includes("01201"));
  assert.equal(b.filter((x) => x === "PV001").length, 1);
});

test("esFlujoAbc / esDestinoAbc preguntan por la lógica, no por el nombre", () => {
  assert.equal(esFlujoAbc("llano"), true);
  assert.equal(esFlujoAbc("machado"), true);
  assert.equal(esFlujoAbc("general"), false);
  assert.equal(esFlujoAbc(undefined), false);
  assert.equal(esDestinoAbc("01201"), true);
  assert.equal(esDestinoAbc("00201"), false);
  assert.deepEqual(destinosAbc().sort(), ["00401", "01201"]);
});

test("listarFlujos expone la lógica de Machado para que el front no la adivine", () => {
  const m = listarFlujos().find((f) => f.id === "machado");
  assert.equal(m.logica, "abc");
  assert.deepEqual(m.destinos, [{ codigo: "01201", nombre: "Machado" }]);
});
