import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

/* =============================================================================
   CERTIFICACIÓN: el botón "Resuelto a mano en SIESA" no cree, comprueba.

   EL CASO REAL (2026-09-04). Los despachos de las salidas CTS 1757 y 1758
   quedaron `siesa_estado = 'enviado'`, `siesa_docto = null`, sin error. Alguien
   apretó el botón después del intento 5. Esa vez había hecho el trabajo —las
   entradas CTE 1419 y 1420 existían— pero NADA lo obligaba a hacerlo.

   Y el estado `enviado` es TERMINAL: el cron no lo levanta, el panel no lo pinta
   en rojo, ningún tablero lo lista. Un cierre falso no se descubre nunca. La
   mercancía queda en tránsito: fuera de la bodega origen y fuera de la destino.

   La dirección contraria hace igual de mal: mandar a la cola un despacho cuyo
   documento SÍ existe lo sube por segunda vez. Es el desastre del 19/08 —tres
   salidas del mismo despacho— repetido a mano.

   Por eso las dos declaraciones se contrastan contra el ERP, y por eso `forzar`
   existe pero deja rastro.
   ============================================================================= */

let resolverIncierto;

let row;
const impl = {};
const calls = { buscarEntrada: 0, buscarSalida: 0, existeSalida: 0 };

/** "BD" de una fila: encadenable y awaitable, igual que en los otros tests. */
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
    maybeSingle: () => {
      if (patch) {
        Object.assign(row, patch);
        return Promise.resolve({ data: row, error: null });
      }
      return Promise.resolve({ data: row, error: null });
    },
    then(resolve) {
      if (patch) Object.assign(row, patch);
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
      importarSalida: async () => ({ ok: true, docto: "S1" }),
      importarEntrada: async () => ({ ok: true, docto: "E1" }),
      configFaltante: () => [],
      ConfigSiesaError: class ConfigSiesaError extends Error {},
    },
  });
  mock.module("../src/services/siesaAjuste.service.js", {
    exports: {
      importarAjuste: async () => ({ ok: true }),
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
      existeSalida: async (id, o) => {
        calls.existeSalida += 1;
        return impl.existeSalida(id, o);
      },
    },
  });

  ({ resolverIncierto } = await import("../src/services/requisicion.service.js"));
});

beforeEach(() => {
  calls.buscarEntrada = 0;
  calls.buscarSalida = 0;
  calls.existeSalida = 0;
  row = {
    id: "9b5935d7-bc44-46cb-a9ce-9c3a8ef9bbdf",
    siesa_estado: "fallido",
    siesa_intentos: 5,
    siesa_intentos_log: [],
    siesa_docto: null,
  };
  delete process.env.SIESA_SOLO_SALIDA;
  impl.consultaConfigurada = true;
  impl.buscarEntrada = async () => null;
  impl.buscarSalida = async () => null;
  impl.existeSalida = async () => false;
});

/** Último renglón del historial de intentos. */
const ultimoIntento = () => row.siesa_intentos_log.at(-1);

test('EL CASO REAL: "enviado" sin entrada en SIESA se RECHAZA', async () => {
  await assert.rejects(
    () => resolverIncierto(row.id, "enviado", "proyectos@merkahorrosas.com"),
    (e) => {
      assert.equal(e.statusCode, 409, "el panel tiene que poder mostrar el motivo");
      assert.match(e.message, /tránsito/i, "hay que decir DÓNDE queda la mercancía");
      return true;
    },
  );

  assert.equal(row.siesa_estado, "fallido", "sigue en rojo: nada se cerró");
});

test('"enviado" con la entrada en SIESA se acepta y GUARDA el consecutivo', async () => {
  impl.buscarEntrada = async () => ({ nro: "1419", co: "004", fecha: "2026-09-04" });

  const r = await resolverIncierto(row.id, "enviado", "proyectos@merkahorrosas.com");

  assert.equal(r.estado, "enviado");
  assert.equal(r.verificacion, "confirmada");
  assert.equal(row.siesa_estado, "enviado");
  assert.equal(row.siesa_docto, "1419", "antes quedaba en null y nadie sabía con qué se cerró");
  assert.match(ultimoIntento().error, /verificado en SIESA/i);
  assert.match(ultimoIntento().error, /proyectos@merkahorrosas\.com/);
});

test('LA OTRA DIRECCIÓN: "reintentar" con la entrada YA en SIESA se RECHAZA', async () => {
  // Devolverlo a la cola lo subiría por segunda vez. Es el 19/08 hecho a mano.
  impl.buscarEntrada = async () => ({ nro: "1419", co: "004", fecha: null });

  await assert.rejects(
    () => resolverIncierto(row.id, "reintentar", "alguien@merkahorrosas.com"),
    (e) => {
      assert.equal(e.statusCode, 409);
      assert.match(e.message, /duplicar/i);
      assert.match(e.message, /1419/, "hay que decir CUÁL documento ya está");
      return true;
    },
  );

  assert.equal(row.siesa_estado, "fallido");
});

test('"reintentar" sin nada en SIESA vuelve a la cola', async () => {
  const r = await resolverIncierto(row.id, "reintentar", null);

  assert.equal(r.estado, "pendiente");
  assert.equal(r.verificacion, "confirmada");
  assert.equal(row.siesa_estado, "pendiente");
  assert.equal(row.siesa_docto, null, "no se inventa un docto en el camino de vuelta");
});

test("forzar deja pasar, pero queda ESCRITO que no se verificó", async () => {
  const r = await resolverIncierto(row.id, "enviado", "maria@merkahorrosas.com", { forzar: true });

  assert.equal(row.siesa_estado, "enviado");
  assert.equal(r.verificacion, "forzada");
  assert.match(ultimoIntento().error, /FORZADO/, "el atajo existe; silencioso, no");
  assert.equal(row.siesa_docto, null, "forzar no inventa un consecutivo");
});

test("si NO se puede preguntar, se acepta y se deja dicho — 'no sé' no es 'no está'", async () => {
  // Frenar todos los cierres porque Connekta no responde deja a la gente sin
  // salida frente a un panel en rojo. Se acepta, pero el historial lo aclara.
  impl.consultaConfigurada = false;

  const r = await resolverIncierto(row.id, "enviado", null);

  assert.equal(row.siesa_estado, "enviado");
  assert.equal(r.verificacion, "no-verificable");
  assert.match(ultimoIntento().error, /SIN VERIFICAR/);
});

test("una consulta que falla tampoco frena el cierre, y también queda dicho", async () => {
  impl.buscarEntrada = async () => {
    throw new Error("Connekta 401");
  };

  const r = await resolverIncierto(row.id, "enviado", null);

  assert.equal(r.verificacion, "no-verificable");
  assert.match(ultimoIntento().error, /SIN VERIFICAR/);
  assert.match(ultimoIntento().error, /401/, "el motivo real tiene que llegar al historial");
});

test("con SIESA_SOLO_SALIDA la cara que cierra es la SALIDA, no la entrada", async () => {
  // En ese modo la entrada se hace a mano a propósito: exigirla sería exigir algo
  // que el sistema decidió no crear.
  process.env.SIESA_SOLO_SALIDA = "true";
  impl.existeSalida = async () => true;
  impl.buscarSalida = async () => ({ nro: "1758", co: "003", fecha: null });

  const r = await resolverIncierto(row.id, "enviado", null);

  assert.equal(r.estado, "enviado");
  assert.equal(row.siesa_docto, "1758");
  assert.equal(calls.buscarEntrada, 0, "no se pregunta por la entrada en este modo");
});

test("una salida DUPLICADA cuenta como existente: 'hay tres' no es 'no hay ninguna'", async () => {
  // buscarSalida devuelve null con duplicados (se niega a elegir). Tomar ese null
  // por ausencia bloquearía el cierre justo en los despachos más rotos.
  process.env.SIESA_SOLO_SALIDA = "true";
  impl.existeSalida = async () => true;
  impl.buscarSalida = async () => null;

  const r = await resolverIncierto(row.id, "enviado", null);

  assert.equal(r.estado, "enviado");
  assert.equal(r.verificacion, "confirmada");
  assert.equal(row.siesa_docto, null, "no hay UN consecutivo que anotar");
  assert.match(ultimoIntento().error, /duplicada/i);
});

test("no se resuelve a mano algo que no está esperando a un humano", async () => {
  row.siesa_estado = "enviado";

  await assert.rejects(
    () => resolverIncierto(row.id, "enviado", null),
    (e) => {
      assert.equal(e.statusCode, 409);
      return true;
    },
  );
  assert.equal(calls.buscarEntrada, 0, "ni se molesta en preguntarle a SIESA");
});

/* -----------------------------------------------------------------------------
   NO SE GASTA UNA LLAMADA A CONNEKTA SI NO CAMBIA LA DECISIÓN (2026-09-04)

   Medido en vivo: la primera resolución tardó >60 s con el rate limit de Connekta
   activo (~10 llamadas por ventana) y la siguiente 1 s. Esto cuelga de un click,
   y un botón que parece colgado se aprieta otra vez.

   La relectura solo aporta cuando el cache CONTRADICE lo declarado — ahí el
   documento puede haberse creado hace segundos. Si el cache ya coincide, releer
   no cambia nada.
   -------------------------------------------------------------------------- */

test("si el cache ya confirma lo declarado, NO se relee", async () => {
  impl.buscarEntrada = async () => ({ nro: "1419", co: "004", fecha: null });

  await resolverIncierto(row.id, "enviado", null);

  assert.equal(calls.buscarEntrada, 1, "una sola consulta: el cache ya decía que sí");
});

test("si el cache contradice, se relee ANTES de frenar a nadie", async () => {
  // El caso que justifica la relectura: la entrada se creó hace segundos y el
  // cache (TTL 30 s) todavía no la ve. Bloquear con datos viejos sería un falso
  // freno sobre alguien que hizo bien el trabajo.
  let llamada = 0;
  impl.buscarEntrada = async (_id, o) => {
    llamada += 1;
    return o?.refrescar ? { nro: "1419", co: "004", fecha: null } : null;
  };

  const r = await resolverIncierto(row.id, "enviado", null);

  assert.equal(llamada, 2, "cache primero, relectura después");
  assert.equal(r.estado, "enviado");
  assert.equal(row.siesa_docto, "1419");
});

test("y si tras releer sigue sin estar, ahí sí frena", async () => {
  await assert.rejects(
    () => resolverIncierto(row.id, "enviado", null),
    (e) => e.statusCode === 409,
  );
  assert.equal(calls.buscarEntrada, 2, "se le dio la chance de la relectura");
});
