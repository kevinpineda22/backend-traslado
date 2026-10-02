import { test, mock, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

/* =============================================================================
   "Enviar primera parte" deshabilitado (02/10/2026).

   El corte está en el controlador (la puerta HTTP), no en el servicio ni en el
   modelo: la lógica de dividir sigue intacta para poder volver a prenderla con
   `TRASLADOS_ENVIO_POR_PARTES`. Lo que tiene que valer:
     · apagado (default): 409 y NO se toca el servicio — nada se parte.
     · prendido: pasa al servicio como antes.
   ============================================================================= */

const ENV = "TRASLADOS_ENVIO_POR_PARTES";
const original = process.env[ENV];

let DespachoController;
let llamadas = 0;

function mockModulo(ruta, { exports: exportaciones }) {
  const mayor = Number(process.versions.node.split(".")[0]);
  mock.module(ruta, mayor >= 24 ? { exports: exportaciones } : { namedExports: exportaciones });
}

before(async () => {
  mockModulo("../src/services/despacho.service.js", {
    exports: {
      dividirEnPartes: async (id) => {
        llamadas += 1;
        return { despacho: { id }, parte2: { id: "p2" }, movidos: 3 };
      },
    },
  });
  mockModulo("../src/models/Despachador.model.js", { exports: {} });
  DespachoController = await import("../src/controllers/despacho.controller.js");
});

beforeEach(() => {
  llamadas = 0;
  delete process.env[ENV];
});

afterEach(() => {
  if (original === undefined) delete process.env[ENV];
  else process.env[ENV] = original;
});

/** Llama al handler como Express y devuelve lo que pasó. */
async function pedirDividir() {
  const out = { status: null, body: null, error: null };
  const res = {
    status(c) { out.status = c; return this; },
    json(b) { out.body = b; return this; },
  };
  await DespachoController.dividir({ params: { id: "d1" } }, res, (e) => { out.error = e; });
  return out;
}

test("por defecto está deshabilitado: 409 y el servicio ni se llama", async () => {
  const r = await pedirDividir();
  assert.equal(r.error?.statusCode, 409);
  assert.match(r.error.message, /deshabilitado/);
  assert.equal(llamadas, 0, "no se partió nada");
});

test("un valor que no es 'prendido' sigue deshabilitado", async () => {
  process.env[ENV] = "false";
  const r = await pedirDividir();
  assert.equal(r.error?.statusCode, 409);
  assert.equal(llamadas, 0);
});

test("prendido con la variable, pasa al servicio como antes", async () => {
  process.env[ENV] = "true";
  const r = await pedirDividir();
  assert.equal(r.error, null);
  assert.equal(r.status, 201);
  assert.equal(llamadas, 1);
});
