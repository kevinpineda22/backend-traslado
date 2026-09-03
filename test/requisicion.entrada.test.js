import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

/* =============================================================================
   CERTIFICACIÓN: la ENTRADA en tránsito se crea UNA vez, o ninguna.

   Contexto de por qué existe este archivo. Hasta el 03/09/2026 el backend corría
   en modo SOLO SALIDA y las entradas las creaba una persona a mano en el ERP
   (35 de 35 despachos, apareo 1:1 verificado contra SIESA). Al automatizarlas,
   el riesgo deja de ser la salida duplicada y pasa a ser la ENTRADA duplicada:
   mercancía que entra dos veces a la tienda destino.

   Se prueba, sin tocar SIESA ni la BD reales, que:
     - si la entrada ya existe en SIESA, NO se crea otra (se adopta);
     - si no se puede verificar, se FRENA en vez de mandar a ciegas;
     - el consecutivo de la salida se recupera de SIESA cuando el conector no
       lo devolvió — que es lo que dejaba el par abierto para siempre.

   Mismo andamiaje que requisicion.idempotencia.test.js: `impl` configura el
   comportamiento, `calls` cuenta los writes al ERP y `row` es la BD.
   ============================================================================= */

let enviarRequisicion;

let row;
const impl = {};
const calls = { salida: 0, entrada: 0, buscarSalida: 0, buscarEntrada: 0 };

function builder() {
  let patch = null;
  const b = {
    update(p) {
      patch = p;
      return b;
    },
    eq: () => b,
    neq: () => b,
    select: () => b,
    maybeSingle() {
      Object.assign(row, patch);
      return Promise.resolve({
        data: row.siesa_estado === "enviado" ? null : { id: row.id },
        error: null,
      });
    },
    then(resolve) {
      Object.assign(row, patch);
      resolve({ error: null });
    },
  };
  return b;
}

before(async () => {
  mock.module("../src/config/supabase.js", {
    exports: { supabase: { from: () => builder() } },
  });

  mock.module("../src/models/Despacho.model.js", {
    exports: { findById: async () => ({ ...row, traslados_items: [] }) },
  });

  mock.module("../src/services/lock.service.js", {
    exports: { tomarLock: async () => true, liberarLock: async () => {} },
  });

  mock.module("../src/services/siesaRequisicion.service.js", {
    exports: {
      importarSalida: async (d) => {
        calls.salida += 1;
        return impl.importarSalida(d);
      },
      importarEntrada: async (d, doc) => {
        calls.entrada += 1;
        return impl.importarEntrada(d, doc);
      },
      configFaltante: () => [],
      ConfigSiesaError: class ConfigSiesaError extends Error {},
    },
  });

  mock.module("../src/services/siesaAjuste.service.js", {
    exports: {
      importarAjuste: async () => ({ ok: true, docto: "AJ1", payload: {} }),
      detectarFaltantes: () => [],
      ajusteAutoHabilitado: () => false,
    },
  });

  mock.module("../src/services/siesaTransito.consulta.js", {
    exports: {
      consultaConfigurada: () => impl.consultaConfigurada,
      buscarSalida: async (id, o) => {
        calls.buscarSalida += 1;
        return impl.buscarSalida(id, o);
      },
      buscarEntrada: async (id, o) => {
        calls.buscarEntrada += 1;
        return impl.buscarEntrada(id, o);
      },
    },
  });

  ({ enviarRequisicion } = await import("../src/services/requisicion.service.js"));
});

beforeEach(() => {
  calls.salida = 0;
  calls.entrada = 0;
  calls.buscarSalida = 0;
  calls.buscarEntrada = 0;
  row = {
    id: "D1",
    origen: "PV001",
    destino: "PV002",
    siesa_estado: null,
    siesa_intentos: 0,
    siesa_intentos_log: [],
    siesa_salida_at: null,
    siesa_salida_docto: null,
    siesa_ajuste_estado: null,
  };
  delete process.env.SIESA_SOLO_SALIDA;
  delete process.env.SIESA_ENTRADA_VERIFICAR;

  // Camino feliz: conector devuelve consecutivo, consulta disponible, sin entrada previa.
  impl.importarSalida = async () => ({ ok: true, docto: "S1", respuesta: {}, payload: { s: 1 } });
  impl.importarEntrada = async () => ({ ok: true, docto: "E1", respuesta: {}, payload: { e: 1 } });
  impl.consultaConfigurada = true;
  impl.buscarSalida = async () => null;
  impl.buscarEntrada = async () => null;
});

test("camino feliz: salida y entrada, una vez cada una", async () => {
  const r = await enviarRequisicion("D1");

  assert.equal(r.estado, "enviado");
  assert.equal(calls.salida, 1);
  assert.equal(calls.entrada, 1);
  assert.equal(row.siesa_docto, "E1", "siesa_docto guarda el docto de la ENTRADA");
  assert.equal(row.siesa_entrada_externa, false, "la creó este backend");
  assert.equal(calls.buscarEntrada, 1, "igual se verificó antes de crearla");
});

test("EL RIESGO: si la entrada ya existe en SIESA, NO se crea otra", async () => {
  // Alguien la hizo a mano en el ERP mientras el sistema arrancaba.
  impl.buscarEntrada = async () => ({ nro: "1416", co: "004", fecha: "2026-09-01T00:00:00" });

  const r = await enviarRequisicion("D1");

  assert.equal(calls.entrada, 0, "NO se importó una segunda entrada — no se duplica inventario");
  assert.equal(r.estado, "enviado");
  assert.equal(r.entradaExterna, true);
  assert.equal(row.siesa_docto, "1416", "se adoptó el consecutivo de la entrada que ya existía");
  assert.equal(row.siesa_entrada_externa, true);
  assert.equal(calls.salida, 1, "la salida sí se mandó, es la que faltaba");
});

test("sin poder verificar, se FRENA: no manda la entrada a ciegas", async () => {
  impl.consultaConfigurada = false;

  const r = await enviarRequisicion("D1");

  assert.equal(calls.entrada, 0, "no se creó la entrada sin poder verificar");
  assert.equal(r.estado, "pendiente");
  assert.match(row.siesa_error, /no se puede verificar/i);
  assert.ok(row.siesa_salida_at, "la salida quedó anclada y no se va a re-mandar");
});

test("si la consulta se cae, tampoco manda la entrada", async () => {
  impl.buscarEntrada = async () => {
    throw new Error("Connekta falló [HTTP 401]");
  };

  const r = await enviarRequisicion("D1");

  assert.equal(calls.entrada, 0);
  assert.equal(r.estado, "pendiente");
  assert.match(row.siesa_error, /401/);
});

test("consecutivo vacío: se recupera de SIESA y la entrada sale con ese número", async () => {
  // El bug histórico: SIESA acepta la salida pero no devuelve consecutivo legible.
  impl.importarSalida = async () => ({ ok: true, docto: "", respuesta: { codigo: 0 }, payload: { s: 1 } });
  impl.buscarSalida = async () => ({ nro: "1754", co: "003", fecha: "2026-09-01T00:00:00" });

  let consecutivoUsado = null;
  impl.importarEntrada = async (_d, doc) => {
    consecutivoUsado = doc;
    return { ok: true, docto: "E1", respuesta: {}, payload: { e: 1 } };
  };

  const r = await enviarRequisicion("D1");

  assert.equal(calls.buscarSalida, 1, "se fue a buscar el consecutivo a SIESA");
  assert.equal(consecutivoUsado, "1754", "la entrada referencia el consecutivo recuperado");
  assert.equal(row.siesa_salida_docto, "1754", "y quedó persistido");
  assert.equal(r.estado, "enviado");
  assert.equal(calls.salida, 1, "la salida NO se re-mandó");
});

test("si el consecutivo no aparece por ningún lado, no se re-manda la salida", async () => {
  impl.importarSalida = async () => ({ ok: true, docto: "", respuesta: { codigo: 0 }, payload: { s: 1 } });
  impl.buscarSalida = async () => null;
  impl.importarEntrada = async () => {
    throw new Error("No hay consecutivo de salida para armar la entrada en tránsito.");
  };

  await enviarRequisicion("D1");
  assert.equal(row.siesa_estado, "pendiente");

  await enviarRequisicion("D1");
  assert.equal(calls.salida, 1, "la salida se mandó UNA vez en los dos intentos");
  assert.equal(calls.entrada, 2, "solo se reintenta la entrada");
});

test("SIESA_ENTRADA_VERIFICAR=0 apaga el guard (para cuando ya nadie las hace a mano)", async () => {
  process.env.SIESA_ENTRADA_VERIFICAR = "0";
  impl.consultaConfigurada = false;

  const r = await enviarRequisicion("D1");

  assert.equal(r.estado, "enviado");
  assert.equal(calls.entrada, 1, "manda la entrada sin consultar");
  assert.equal(calls.buscarEntrada, 0, "no consultó nada");
});

test("modo SOLO SALIDA sigue funcionando como freno de emergencia", async () => {
  process.env.SIESA_SOLO_SALIDA = "1";

  const r = await enviarRequisicion("D1");

  assert.equal(r.soloSalida, true);
  assert.equal(calls.entrada, 0);
  assert.equal(calls.buscarEntrada, 0, "ni siquiera consulta: la entrada está pausada");
  assert.equal(row.siesa_estado, "enviado", "terminal, no se reintenta");
});
