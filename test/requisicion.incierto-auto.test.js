import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

/* =============================================================================
   CERTIFICACIÓN: el barrido de INCIERTOS destraba solo lo que puede COMPROBAR.

   El 09/09/2026 el despacho 5f4ed946 (Copacabana → Girardota Parque) dio timeout
   a las 07:24 en la fase SALIDA. La salida SÍ había entrado (CTS 4808) y nuestra
   base no se enteró. Nadie recibió correo, el cron no levanta inciertos, y el
   traslado estuvo parado 1 h 40 hasta que una persona entró al ERP y creó la
   entrada a mano. La respuesta estaba a UNA lectura de SIESA de distancia.

   Lo que se prueba acá es la línea que separa "destrabar" de "mandar a ciegas":

     · con la ENTRADA en el ERP  → cierra;
     · con solo la SALIDA        → la ancla y devuelve a la cola (anclar solo
                                   puede IMPEDIR envíos, nunca provocarlos);
     · sin NADA en el ERP        → no toca, porque ahí "no veo el documento"
                                   autorizaría un envío, y equivocarse en esa
                                   dirección duplica inventario;
     · con salidas DUPLICADAS    → tampoco toca: no se adivina un consecutivo.

   Y las dos protecciones de ruido: la gracia (SIESA sigue grabando después del
   timeout) y el aviso único (un correo cada 10 minutos se vuelve una regla de
   archivado en la bandeja de quien tiene que actuar).
   ============================================================================= */

let resolverInciertosAutomaticamente;

let rows;
const correos = [];
const impl = {};
const calls = { buscarEntrada: 0, existeSalida: 0, buscarSalida: 0, refrescos: 0 };

const HACE_30_MIN = () => new Date(Date.now() - 30 * 60_000).toISOString();

/** Fila de despacho incierto, con el log del envío que se cortó. */
function despachoIncierto(id, extra = {}) {
  return {
    id,
    origen: "PV001",
    destino: "00301",
    siesa_estado: "incierto",
    siesa_error: "timeout of 60000ms exceeded",
    siesa_intentos: 1,
    siesa_intentos_log: [
      {
        n: 1,
        at: HACE_30_MIN(),
        estado: "incierto",
        fase: "salida",
        error: "timeout of 60000ms exceeded",
      },
    ],
    siesa_salida_at: null,
    siesa_salida_docto: null,
    updated_at: HACE_30_MIN(),
    ...extra,
  };
}

function builder() {
  let modo = null;
  let patch = null;
  let id = null;
  const b = {
    select() {
      modo = "select";
      return b;
    },
    update(p) {
      modo = "update";
      patch = p;
      return b;
    },
    eq(col, val) {
      if (modo === "update" && col === "id") id = val;
      return b;
    },
    order: () => b,
    limit: () => b,
    neq: () => b,
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
    then(resolve) {
      if (modo === "select") return resolve({ data: rows, error: null });
      const fila = rows.find((r) => r.id === id);
      if (fila) Object.assign(fila, patch);
      return resolve({ error: null });
    },
  };
  return b;
}

before(async () => {
  mock.module("../src/config/supabase.js", {
    exports: { supabase: { from: () => builder() } },
  });

  mock.module("../src/models/Despacho.model.js", {
    exports: { findById: async (id) => rows.find((r) => r.id === id) },
  });

  mock.module("../src/services/lock.service.js", {
    exports: { tomarLock: async () => true, liberarLock: async () => {} },
  });

  // El barrido LEE el ERP; jamás escribe. Si alguna rama llamara a estas, es un bug.
  mock.module("../src/services/siesaRequisicion.service.js", {
    exports: {
      importarSalida: async () => {
        throw new Error("el barrido NUNCA debe escribir en el ERP");
      },
      importarEntrada: async () => {
        throw new Error("el barrido NUNCA debe escribir en el ERP");
      },
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
      buscarEntrada: async (id, o) => {
        calls.buscarEntrada += 1;
        if (o?.refrescar) calls.refrescos += 1;
        return impl.buscarEntrada(id);
      },
      existeSalida: async (id) => {
        calls.existeSalida += 1;
        return impl.existeSalida(id);
      },
      buscarSalida: async (id) => {
        calls.buscarSalida += 1;
        return impl.buscarSalida(id);
      },
    },
  });

  mock.module("../src/services/notificacionesTraslado.service.js", {
    exports: {
      enviarInciertoSiesa: async (despacho, p) => {
        correos.push({ id: despacho.id, ...p });
        return { success: true };
      },
    },
  });

  ({ resolverInciertosAutomaticamente } = await import("../src/services/requisicion.service.js"));
});

beforeEach(() => {
  calls.buscarEntrada = 0;
  calls.existeSalida = 0;
  calls.buscarSalida = 0;
  calls.refrescos = 0;
  correos.length = 0;
  rows = [despachoIncierto("D1")];

  delete process.env.SIESA_INCIERTO_AUTO_REINTENTO;
  delete process.env.SIESA_INCIERTO_GRACIA_MS;

  impl.consultaConfigurada = true;
  impl.buscarEntrada = async () => null;
  impl.existeSalida = async () => false;
  impl.buscarSalida = async () => null;
});

test("EL CASO DEL 09/09: la salida está en SIESA — se ancla y vuelve a la cola", async () => {
  impl.existeSalida = async () => true;
  impl.buscarSalida = async () => ({ nro: "4808", co: "001", fecha: "2026-09-08" });

  const r = await resolverInciertosAutomaticamente();

  assert.equal(r.encolados, 1);
  assert.equal(rows[0].siesa_estado, "pendiente", "vuelve a la cola para crear la entrada");
  assert.equal(rows[0].siesa_salida_docto, "4808");
  assert.ok(rows[0].siesa_salida_at, "la salida queda ANCLADA: es lo que impide que se re-mande");
  assert.equal(correos.at(-1).situacion, "continua");
});

test("el par ya estaba cerrado en el ERP: se marca enviado con el docto de la entrada", async () => {
  impl.buscarEntrada = async () => ({ nro: "1474", co: "003", fecha: "2026-09-08" });
  impl.existeSalida = async () => true;
  impl.buscarSalida = async () => ({ nro: "4808", co: "001" });

  const r = await resolverInciertosAutomaticamente();

  assert.equal(r.resueltos, 1);
  assert.equal(rows[0].siesa_estado, "enviado");
  assert.equal(rows[0].siesa_docto, "1474", "siesa_docto es el de la ENTRADA");
  assert.equal(
    rows[0].siesa_salida_docto,
    "4808",
    "también se ancla la salida: una fila que afirma una entrada sin salida miente en una auditoría",
  );
  assert.equal(correos.at(-1).situacion, "resuelto");
});

test("EL RIESGO: sin rastro en el ERP NO se reintenta solo — queda para una persona", async () => {
  // Ni salida ni entrada. Reencolar acá es la única rama donde "no veo el
  // documento" AUTORIZA un envío, y el apareo cuelga del uuid en las notas: si
  // alguien las edita, el documento existe pero queda invisible.
  const r = await resolverInciertosAutomaticamente();

  assert.equal(r.trabados, 1);
  assert.equal(rows[0].siesa_estado, "incierto", "sigue incierto: nadie lo mandó de nuevo");
  assert.equal(correos.at(-1).situacion, "trabado");
});

test("con SIESA_INCIERTO_AUTO_REINTENTO prendido, sin rastro SÍ vuelve a la cola", async () => {
  process.env.SIESA_INCIERTO_AUTO_REINTENTO = "1";

  const r = await resolverInciertosAutomaticamente();

  assert.equal(r.encolados, 1);
  assert.equal(rows[0].siesa_estado, "pendiente");
});

test("salida duplicada: no se elige ninguna y el despacho no se toca", async () => {
  impl.existeSalida = async () => true;
  impl.buscarSalida = async () => null; // así avisa `buscarSalida` que hay varias

  const r = await resolverInciertosAutomaticamente();

  assert.equal(r.trabados, 1);
  assert.equal(rows[0].siesa_estado, "incierto");
  assert.match(rows[0].siesa_error, /MÁS DE UNA salida/);
});

test("LA GRACIA: un incierto recién ocurrido no se mira — SIESA puede seguir grabando", async () => {
  rows = [
    despachoIncierto("D1", {
      siesa_intentos_log: [
        { n: 1, at: new Date().toISOString(), estado: "incierto", fase: "salida" },
      ],
    }),
  ];

  const r = await resolverInciertosAutomaticamente();

  assert.equal(r.resultados[0].accion, "en-gracia");
  assert.equal(calls.buscarEntrada, 0, "no se le preguntó nada al ERP todavía");
});

test("el aviso sale UNA vez por incierto, aunque el barrido pase muchas veces", async () => {
  await resolverInciertosAutomaticamente();
  await resolverInciertosAutomaticamente();
  await resolverInciertosAutomaticamente();

  assert.equal(
    correos.filter((c) => c.situacion === "trabado").length,
    1,
    "un correo cada 10 minutos es una regla de archivado en la bandeja de quien tiene que actuar",
  );
});

test("sin la consulta de tránsito no se toca nada: no hay con qué comprobar", async () => {
  impl.consultaConfigurada = false;

  const r = await resolverInciertosAutomaticamente();

  assert.equal(r.procesados, 0);
  assert.equal(calls.buscarEntrada, 0);
  assert.equal(rows[0].siesa_estado, "incierto");
});

test("una sola relectura del ERP para todo el barrido (Connekta tiene rate limit)", async () => {
  rows = [despachoIncierto("D1"), despachoIncierto("D2"), despachoIncierto("D3")];

  await resolverInciertosAutomaticamente();

  assert.equal(calls.refrescos, 1, "solo la primera relee; las demás usan ese cache");
  assert.equal(calls.buscarEntrada, 3, "pero a las tres se les preguntó");
});

test("si el ERP no se puede leer, se corta y no se toca ningún despacho", async () => {
  rows = [despachoIncierto("D1"), despachoIncierto("D2")];
  impl.buscarEntrada = async () => {
    throw new Error("Connekta no responde");
  };

  const r = await resolverInciertosAutomaticamente();

  assert.match(r.motivo, /no se pudo leer SIESA/);
  assert.equal(calls.buscarEntrada, 1, "no se insiste con los demás: el cache está frío igual");
  assert.equal(rows[0].siesa_estado, "incierto");
  assert.equal(rows[1].siesa_estado, "incierto");
  assert.equal(correos.length, 0, "tampoco se avisa: no se sabe nada todavía");
});
