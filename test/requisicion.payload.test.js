import { test } from "node:test";
import assert from "node:assert/strict";

import { armarSalida, armarEntrada } from "../src/services/siesaRequisicion.service.js";

/* =============================================================================
   CERTIFICACIÓN: un ítem = UN movimiento en el plano de SIESA.

   El caso que da origen a este archivo es real (2026-09-04). El despacho tenía
   el mismo producto contado en dos unidades de medida — dos renglones en
   `traslados_items`, como manda el modelo multi-UM — y al plano bajaban como dos
   movimientos con TODO igual salvo la cantidad: mismo ITEM, misma BODEGA, misma
   UNIDAD_MEDIDA ("UND"), mismo MOTIVO.

   La SALIDA (CTS) los aceptó. La ENTRADA (CTE) no:

     [HTTP 400] f_tipo_reg 470 — "Movto Inventario: Existen varios movimientos
     con las mismas características en el documento base"

   Y no rechaza el renglón: rechaza el documento entero. La mercancía se quedó
   en tránsito, fuera de las dos bodegas.

   Se prueba en las DOS caras a propósito. Si una consolidara y la otra no, el
   plano quedaría descuadrado (salió N líneas, entró N-1) — el mismo tipo de
   desalineación que ya obliga a `itemsRecolectados` a vivir en un solo helper.
   ============================================================================= */

process.env.SIESA_IMPORTAR_CO_POR_SEDE = JSON.stringify({ "00301": "003", "00401": "004" });

/** Despacho mínimo: el mismo ítem en dos UM + un ítem suelto. */
const despacho = {
  id: "fe00ff35-490c-4d09-ac27-000000000001",
  origen: "00301",
  destino: "00401",
  updated_at: "2026-09-04T12:00:00.000Z",
  traslados_items: [
    // 0010255 en UND: 10 × 1 = 10 UND
    { codigo_item: "0010255", cantidad_despachador: 10, factor: 1 },
    // 0010255 en CAJA: 3 × 12 = 36 UND  → mismo ítem, otro renglón
    { codigo_item: "0010255", cantidad_despachador: 3, factor: 12 },
    { codigo_item: "0016262", cantidad_despachador: 19, factor: 1 },
  ],
};

test("la salida manda un solo movimiento por ítem, con las cantidades sumadas en UND", () => {
  const { Movimientos } = armarSalida(despacho);

  assert.equal(Movimientos.length, 2, "tres renglones, dos ítems: dos movimientos");

  const item = Movimientos.find((m) => m.ITEM === "0010255");
  assert.equal(item.CANTIDAD, "46", "10 UND + (3 × 12) = 46 UND");
  assert.equal(Movimientos.find((m) => m.ITEM === "0016262").CANTIDAD, "19");
});

test("la entrada consolida IGUAL que la salida — si no, el plano queda descuadrado", () => {
  const salida = armarSalida(despacho);
  const entrada = armarEntrada(despacho, "1757");

  assert.equal(entrada.Movimientos.length, salida.Movimientos.length);
  assert.deepEqual(
    entrada.Movimientos.map((m) => [m.ITEM, m.CANTIDAD]),
    salida.Movimientos.map((m) => [m.ITEM, m.CANTIDAD]),
  );
});

test("no quedan dos movimientos con las mismas características (lo que SIESA rechaza)", () => {
  for (const cara of [armarSalida(despacho), armarEntrada(despacho, "1757")]) {
    const firmas = cara.Movimientos.map(
      (m) => `${m.ITEM}|${m.BODEGA_MOVIMIENTO}|${m.UNIDAD_MEDIDA}|${m.MOTIVO}`,
    );
    assert.equal(new Set(firmas).size, firmas.length);
  }
});

test("el consecutivo de movimiento se renumera 1..N tras consolidar, sin huecos", () => {
  const { Movimientos } = armarSalida(despacho);
  assert.deepEqual(
    Movimientos.map((m) => m["NRO REGISTRO MOVIMIENTO"]),
    ["1", "2"],
  );
});

test("se conserva el orden de primera aparición del carrito", () => {
  const { Movimientos } = armarSalida(despacho);
  assert.deepEqual(
    Movimientos.map((m) => m.ITEM),
    ["0010255", "0016262"],
  );
});

test("la cantidad respeta los 4 decimales de f470_cant_base, sin basura de punto flotante", () => {
  // Un pesable repetido en dos renglones: 0.1 + 0.2 en punto flotante da
  // 0.30000000000000004, y String() escribe los dieciséis decimales. El campo
  // acepta cuatro.
  const pesable = {
    ...despacho,
    traslados_items: [
      { codigo_item: "0007777", cantidad_despachador: 0.1, factor: 1 },
      { codigo_item: "0007777", cantidad_despachador: 0.2, factor: 1 },
    ],
  };

  const [mov] = armarSalida(pesable).Movimientos;
  assert.equal(mov.CANTIDAD, "0.3");

  for (const cara of [armarSalida(pesable), armarEntrada(pesable, "1757")]) {
    for (const m of cara.Movimientos) {
      const decimales = (m.CANTIDAD.split(".")[1] || "").length;
      assert.ok(decimales <= 4, `"${m.CANTIDAD}" tiene ${decimales} decimales`);
    }
  }
});

test("se redondea al final, no renglón por renglón — el total no arrastra el error", () => {
  // Tres renglones de 0.00005: redondear cada uno a 4 decimales daría 0.0001 × 3
  // = 0.0003. Sumar primero da 0.00015 → 0.0002 (o 0.0001), pero NUNCA 0.0003.
  const finos = {
    ...despacho,
    traslados_items: Array.from({ length: 3 }, () => ({
      codigo_item: "0006666",
      cantidad_despachador: 0.00005,
      factor: 1,
    })),
  };

  const [mov] = armarSalida(finos).Movimientos;
  assert.notEqual(mov.CANTIDAD, "0.0003");
  assert.ok(Number(mov.CANTIDAD) <= 0.0002);
});

test("los ítems omitidos a mano y los no recolectados no llegan al plano", () => {
  const conRuido = {
    ...despacho,
    traslados_items: [
      ...despacho.traslados_items,
      { codigo_item: "0009999", cantidad_despachador: 5, factor: 1, siesa_omitido: true },
      { codigo_item: "0008888", cantidad_despachador: 0, factor: 1 },
    ],
  };

  const items = armarSalida(conRuido).Movimientos.map((m) => m.ITEM);
  assert.deepEqual(items, ["0010255", "0016262"]);
});
