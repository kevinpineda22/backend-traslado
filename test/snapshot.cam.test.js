import { test, mock, before } from "node:test";
import assert from "node:assert/strict";

/* El plan CAM ("PORTAFOLIO MACHADO") llega de Connekta como DescMayorCAM y tiene que
   quedar en `criterios.CAM` del snapshot: de ahí sale el portafolio del flujo Machado.
   El CAT sigue guardándose aparte (es de Llano). */

let agregarPorBodegaItem;
let aRegistro;

before(async () => {
  mock.module("../src/config/supabase.js", { exports: { supabase: {} } });
  ({ agregarPorBodegaItem, aRegistro } = await import("../src/services/snapshot.service.js"));
});

const cruda = (extra = {}) => ({
  IdBodega: "01201",
  CodigoItem: 16615,
  DescItem: " ARROZ ",
  UM: "UND",
  IdInstalacion: "001",
  CantidadInventario: 4,
  CantidadDisponible: 4,
  CantidadComprometida: 0,
  ConsumoPromedio: 1,
  PeriodoCubrimiento: 7,
  ...extra,
});

test("DescMayorCAM queda en criterios.CAM (sin espacios), junto al CAT", () => {
  const agg = agregarPorBodegaItem([
    cruda({ DescMayorCAM: " PORTAFOLIO ACTIVO MACHADO ", DescMayorCAT: "CATEGORIA TIPO A" }),
  ]);
  const [fila] = [...agg.values()].map((o) => aRegistro(o, "2026-11-04T00:00:00Z"));

  assert.equal(fila.criterios.CAM, "PORTAFOLIO ACTIVO MACHADO");
  assert.equal(fila.criterios.CAT, "CATEGORIA TIPO A");
});

test("ítem sin CAM (la consulta SÍ trae la columna, en null): queda '' y la clave existe", () => {
  const agg = agregarPorBodegaItem([cruda({ DescMayorCAM: null })]);
  const [fila] = [...agg.values()].map((o) => aRegistro(o, "2026-11-04T00:00:00Z"));

  assert.equal(fila.criterios.CAM, "");
  assert.ok(Object.hasOwn(fila.criterios, "CAM"));
});

test("la consulta NO trae DescMayorCAM: la clave se omite al serializar (no se guarda '')", () => {
  const agg = agregarPorBodegaItem([cruda()]);
  const [fila] = [...agg.values()].map((o) => aRegistro(o, "2026-11-04T00:00:00Z"));

  assert.equal(fila.criterios.CAM, undefined);
  assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(fila.criterios)), "CAM"), false);
});
