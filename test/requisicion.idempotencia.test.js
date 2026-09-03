import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

/* =============================================================================
   CERTIFICACIÓN: a SIESA se sube UNA sola vez.

   Prueba de forma determinista (sin tocar SIESA ni la BD reales) que el fix de
   idempotencia hace lo que promete. Se mockean los colaboradores de
   requisicion.service (SIESA, ajuste, BD, lock, modelo) y se cuentan las llamadas
   a `importarSalida` — cada llamada exitosa sería un movimiento de inventario en
   el ERP.

   Los mocks delegan en un objeto `impl` mutable y cuentan en `calls`, así el
   módulo se importa UNA vez y cada test configura el comportamiento. La "BD" es la
   fila `row`: `marcar()` escribe en ella y `findById()` la relee, de modo que el
   REINTENTO ve el estado persistido — que es donde vivía el bug.
   ============================================================================= */

let enviarRequisicion;

// "Fila" del despacho en la BD simulada. marcar() la muta; findById() la relee.
let row;
// Comportamiento configurable por test.
const impl = {};
// Contadores de llamadas al ERP.
const calls = { salida: 0, entrada: 0, ajuste: 0 };

// ── BD simulada: un query builder encadenable y a la vez "awaitable" ──
// `marcar` hace .update(patch).eq(...) y await → resuelve {error:null} y aplica el
// patch. `reservar` hace .update(...).eq().neq().select().maybeSingle() → aplica y
// devuelve la fila (o null si ya está 'enviado').
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
    exports: {
      // Copia fresca en cada lectura: las mutaciones en memoria de una pasada no
      // se filtran a la siguiente; lo que persiste es lo que marcar() escribió.
      findById: async () => ({ ...row, traslados_items: [] }),
    },
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
      importarAjuste: async (d, f) => {
        calls.ajuste += 1;
        return impl.importarAjuste(d, f);
      },
      detectarFaltantes: (siesaData) => impl.detectarFaltantes(siesaData),
      ajusteAutoHabilitado: () => impl.ajusteAuto,
    },
  });

  ({ enviarRequisicion } = await import("../src/services/requisicion.service.js"));
});

beforeEach(() => {
  calls.salida = 0;
  calls.entrada = 0;
  calls.ajuste = 0;
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
  // Camino feliz por defecto; cada test lo ajusta.
  impl.importarSalida = async () => ({ ok: true, docto: "S1", respuesta: {}, payload: { s: 1 } });
  impl.importarEntrada = async () => ({ ok: true, docto: "E1", respuesta: {}, payload: { e: 1 } });
  impl.ajusteAuto = false;
  impl.detectarFaltantes = () => [];
  impl.importarAjuste = async () => ({ ok: true, docto: "AJ1", payload: {} });
});

test("EL BUG: salida aceptada con consecutivo vacío NO se re-manda en el reintento", async () => {
  // Este test certifica la idempotencia de la SALIDA, no el guard de la entrada.
  // Sin esto, el guard frena antes de llegar a `importarEntrada` (no puede
  // verificar si la entrada ya existe) y la fase que se quiere ejercitar nunca
  // corre. El guard tiene su propia certificación en requisicion.entrada.test.js.
  process.env.SIESA_ENTRADA_VERIFICAR = "0";
  // SIESA acepta la salida (mueve inventario) pero no devuelve consecutivo legible.
  impl.importarSalida = async () => ({ ok: true, docto: "", respuesta: { codigo: 0 }, payload: { s: 1 } });
  // Sin consecutivo, la entrada no se puede armar.
  impl.importarEntrada = async () => {
    throw new Error("No hay consecutivo de salida para armar la entrada en tránsito.");
  };

  await enviarRequisicion("D1");
  assert.equal(calls.salida, 1, "la salida se mandó una vez");
  assert.equal(row.siesa_estado, "pendiente", "quedó pendiente porque la entrada falló");
  assert.ok(row.siesa_salida_at, "ancló la salida por HORA de aceptación, no por el consecutivo");

  // Reintento: acá el bug re-mandaba la salida. Ya no.
  await enviarRequisicion("D1");
  assert.equal(calls.salida, 1, "la salida NO se re-mandó — no se duplica el movimiento");
  assert.equal(calls.entrada, 2, "solo se reintenta la entrada");
});

test("MODO SOLO SALIDA: una subida, estado terminal, la entrada nunca corre", async () => {
  process.env.SIESA_SOLO_SALIDA = "1";
  impl.importarSalida = async () => ({ ok: true, docto: "", respuesta: { codigo: 0 }, payload: { s: 1 } });

  const r1 = await enviarRequisicion("D1");
  assert.equal(r1.estado, "enviado", "la salida aceptada es terminal");
  assert.equal(row.siesa_estado, "enviado");
  assert.equal(calls.salida, 1, "una única subida");
  assert.equal(calls.entrada, 0, "la entrada está pausada");

  const r2 = await enviarRequisicion("D1");
  assert.equal(r2.estado, "omitido", "'enviado' es terminal — no reintenta");
  assert.equal(calls.salida, 1, "sigue en una sola subida");
});

test("FALTANTE 470: ajusta una vez y sube una vez; no re-ajusta ni re-sube", async () => {
  process.env.SIESA_SOLO_SALIDA = "1";
  impl.ajusteAuto = true;
  impl.detectarFaltantes = () => [{ item: "0003851", bodega: "PV001", cantidad: 48 }];

  let n = 0;
  impl.importarSalida = async () => {
    n += 1;
    if (n === 1) {
      // Primer intento: rechazo por faltante (NO crea documento en el ERP).
      const e = new Error("SIESA rechazó la salida [HTTP 400]: sin cantidad disponible");
      e.siesaData = [{ f_tipo_reg: "470" }];
      e.httpStatus = 400;
      throw e;
    }
    // Tras el ajuste: la salida entra (un único documento real).
    return { ok: true, docto: "S1", respuesta: { codigo: 0 }, payload: { s: 1 } };
  };

  const r1 = await enviarRequisicion("D1");
  assert.equal(r1.estado, "enviado");
  assert.equal(calls.ajuste, 1, "un solo ajuste de inventario");
  assert.equal(calls.salida, 2, "1 rechazo + 1 subida exitosa = un único documento real");
  assert.equal(row.siesa_ajuste_estado, "hecho");

  const r2 = await enviarRequisicion("D1");
  assert.equal(r2.estado, "omitido", "ya está enviado");
  assert.equal(calls.ajuste, 1, "NO re-ajusta — no infla inventario");
  assert.equal(calls.salida, 2, "NO re-sube");
});

test("HISTORIAL: se guarda una entrada por cada intento (no solo el último)", async () => {
  impl.importarSalida = async () => ({ ok: true, docto: "", respuesta: {}, payload: {} });
  impl.importarEntrada = async () => {
    throw new Error("No hay consecutivo de salida para armar la entrada en tránsito.");
  };

  await enviarRequisicion("D1");
  await enviarRequisicion("D1");

  assert.equal(row.siesa_intentos_log.length, 2, "un registro por intento");
  assert.ok(
    row.siesa_intentos_log.every((e) => e.at && e.estado),
    "cada intento guarda cuándo y cómo terminó",
  );
});
