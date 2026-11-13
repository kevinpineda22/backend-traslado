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
      { codigo_item: "0007777", unidad_medida: "KL", cantidad_despachador: 0.1, factor: 1 },
      { codigo_item: "0007777", unidad_medida: "KL", cantidad_despachador: 0.2, factor: 1 },
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
      unidad_medida: "KL",
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

/* ---------------------------------------------------------------------------
   Machado (PV001 → 01201): flujo A/B/C como Llano, pero motivo 02 y C.O. propios
   --------------------------------------------------------------------------- */

const despachoMachado = {
  ...despacho,
  origen: "PV001",
  destino: "01201",
};

test("Machado (PV001 → 01201): el motivo de salida es 02, NO 50", () => {
  // El 50 es solo del par Parque → Llano. Que Machado sea un flujo A/B/C como Llano
  // no cambia el motivo: lo confirmó el negocio.
  const { Movimientos } = armarSalida(despachoMachado);

  assert.ok(Movimientos.length > 0);
  assert.ok(Movimientos.every((m) => m.MOTIVO === "02"));
});

test("Parque → Llano conserva el motivo 50 (la regla de Machado no la altera)", () => {
  const { Movimientos } = armarSalida(despacho);

  assert.ok(Movimientos.every((m) => m.MOTIVO === "50"));
});

test("Machado: el C.O. resuelve 001 para el origen (PV001) y 012 para el destino (01201)", () => {
  const salida = armarSalida(despachoMachado);
  const entrada = armarEntrada(despachoMachado, "1757");

  assert.equal(salida.Documentos[0]["C.O DOCTO"], "001");
  assert.equal(entrada.Documentos[0]["C.O DOCTO"], "012");
  assert.equal(salida.Documentos[0].BODEGA_ENTRADA, "01201");
  assert.ok(entrada.Movimientos.every((m) => m.MOTIVO === "01" && m["C.O MOVIMIENTO"] === "012"));
});

/* =============================================================================
   CADA ÍTEM VIAJA EN SU UNIDAD DE SIESA (2026-11-13).

   Todo viajaba con UNIDAD_MEDIDA "UND" fijo. Los pesables existen en SIESA solo
   en KL, y el primero que se despachó con peso (70751 PECHUGA BUCANERO, PV001 →
   Machado) trabó el documento entero seis veces:

     [HTTP 400] f_tipo_reg 470 — "Movto Inventario: La unidad de medida en el
     registro no existe." (f_valor "UND")

   Regla: UND y empaques → UND, en enteros. Pesables → KL, con sus decimales.
   ============================================================================= */

import { PayloadSiesaError, unidadSiesa } from "../src/services/siesaRequisicion.service.js";

test("un pesable viaja en KL con los decimales que se pesaron, en las dos caras", () => {
  const conPesable = {
    ...despacho,
    traslados_items: [
      { codigo_item: "185704", unidad_medida: "UND", cantidad_despachador: 6, factor: 1 },
      { codigo_item: "70751", unidad_medida: "KL", cantidad_despachador: 1.234, factor: 1 },
    ],
  };

  for (const cara of [armarSalida(conPesable), armarEntrada(conPesable, "1757")]) {
    const pechuga = cara.Movimientos.find((m) => m.ITEM === "70751");
    assert.equal(pechuga.UNIDAD_MEDIDA, "KL");
    assert.equal(pechuga.CANTIDAD, "1.234");

    const patacon = cara.Movimientos.find((m) => m.ITEM === "185704");
    assert.equal(patacon.UNIDAD_MEDIDA, "UND");
    assert.equal(patacon.CANTIDAD, "6");
  }
});

test("un empaque sigue convirtiéndose a UND con su factor", () => {
  const conEmpaque = {
    ...despacho,
    traslados_items: [{ codigo_item: "25589", unidad_medida: "P30", cantidad_despachador: 7, factor: 30 }],
  };
  const [mov] = armarSalida(conEmpaque).Movimientos;
  assert.equal(mov.UNIDAD_MEDIDA, "UND");
  assert.equal(mov.CANTIDAD, "210");
});

test("unidadSiesa: UND, empaques y vacío van a UND; el resto se respeta", () => {
  assert.equal(unidadSiesa({ unidad_medida: "UND" }), "UND");
  assert.equal(unidadSiesa({ unidad_medida: "P6" }), "UND");
  assert.equal(unidadSiesa({ unidad_medida: "p84" }), "UND");
  assert.equal(unidadSiesa({}), "UND");
  assert.equal(unidadSiesa({ unidad_medida: "KL" }), "KL");
  assert.equal(unidadSiesa({ unidad_medida: " kl " }), "KL");
});

test("UND con decimales NO se manda: frena antes del POST nombrando el ítem", () => {
  const mal = {
    ...despacho,
    traslados_items: [
      { codigo_item: "182121", unidad_medida: "UND", cantidad_despachador: 6.9, factor: 1 },
      { codigo_item: "70751", unidad_medida: "KL", cantidad_despachador: 1.5, factor: 1 },
    ],
  };

  for (const armar of [() => armarSalida(mal), () => armarEntrada(mal, "1757")]) {
    assert.throws(armar, (err) => {
      assert.ok(err instanceof PayloadSiesaError);
      assert.equal(err.noReintentable, true);
      assert.match(err.message, /182121 \(6\.9 UND\)/);
      assert.doesNotMatch(err.message, /70751/, "el pesable con decimales es válido");
      return true;
    });
  }
});

test("el ruido de punto flotante al multiplicar por el factor no cuenta como decimal", () => {
  // 0.1 × 3 = 0.30000000000000004 en float; acá: 3 renglones que suman un entero.
  const ruido = {
    ...despacho,
    traslados_items: [
      { codigo_item: "0001", unidad_medida: "P3", cantidad_despachador: 1.1, factor: 3 },
      { codigo_item: "0001", unidad_medida: "P3", cantidad_despachador: 2.2, factor: 3 },
      { codigo_item: "0001", unidad_medida: "P3", cantidad_despachador: 0.7, factor: 3 },
    ],
  };
  const [mov] = armarSalida(ruido).Movimientos;
  assert.equal(mov.CANTIDAD, "12");
});
