import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

/* =============================================================================
   Bitácora de refrescos (`traslados_snapshot_log`, migración 041).

   CONTEXTO (26/10/2026)
   El equipo reportó productos en cero que sí tenían datos. Cuando se investigó,
   el cron ya había corrido de nuevo y los números estaban bien. No hubo forma de
   saber qué había pasado: `traslados_snapshot` guarda el estado ACTUAL y cada
   refresco pisa al anterior.

   La bitácora deja una línea por refresco. Lo que se prueba acá:
     - el conteo POR BODEGA queda guardado (el total puede verse sano mientras
       una sede se vacía, que es justo lo que no se pudo descartar);
     - los refrescos ABORTADOS también se registran: son el evento interesante;
     - si la bitácora falla, el refresco NO se cae. Perder el registro es
       molesto; perder el refresco es dejar el panel sin datos.
   ============================================================================= */

const TABLA = "traslados_snapshot";
const TABLA_LOG = "traslados_snapshot_log";

let refrescarSnapshot;
let PullIncompletoError;
let esc; // escenario mutable del doble

/** Una fila cruda de Connekta, con lo mínimo que lee `agregarPorBodegaItem`. */
const filaCruda = (bodega, item) => ({
  IdBodega: bodega,
  CodigoItem: item,
  DescItem: `ITEM ${item}`,
  CantidadDisponible: 5,
  CantidadInventario: 5,
  CantidadComprometida: 0,
  ConsumoPromedio: 1,
  UnidadMedida: "UND",
  UnidadOrden: "UND",
  Factor: 1,
  Volumen: null,
  IdInstalacion: "001",
  PeriodoCubrimiento: 0,
  CostoProm: 0,
});

before(async () => {
  esc = {};

  mock.module("../src/config/flujos.js", {
    exports: {
      bodegasInvolucradas: () => ["00301", "00401"],
      SEDES: {},
      nombreSede: (b) => b,
      getFlujoPorDestino: () => null,
    },
  });

  mock.module("../src/config/connekta.js", {
    exports: {
      ejecutarConsulta: async () => {
        if (esc.fallaConnekta) throw new Error(esc.fallaConnekta);
        return { datos: esc.filas, totalPaginas: 1, total: esc.declarado ?? esc.filas.length };
      },
      QUERY_TRASLADOS: "x",
    },
  });

  mock.module("../src/services/lock.service.js", {
    exports: { tomarLock: async () => true, liberarLock: async () => {}, lockTomado: async () => false },
  });

  // Doble de Supabase: registra los insert a la bitácora y simula el resto.
  const builder = (tabla) => {
    const st = { tabla, accion: "select", head: false, filas: null };
    const self = {
      select(_c, opts = {}) {
        st.head = opts.head === true;
        return self;
      },
      insert(filas) {
        st.accion = "insert";
        st.filas = filas;
        return self;
      },
      upsert() {
        st.accion = "upsert";
        return self;
      },
      delete() {
        st.accion = "delete";
        return self;
      },
      in() {
        return self;
      },
      lt() {
        return self;
      },
      then(ok, mal) {
        return ejecutar(st).then(ok, mal);
      },
    };
    return self;
  };

  const ejecutar = async (st) => {
    if (st.tabla === TABLA_LOG) {
      if (esc.fallaBitacora) return { data: null, error: { message: esc.fallaBitacora } };
      esc.registradas.push(Array.isArray(st.filas) ? st.filas[0] : st.filas);
      return { data: null, error: null };
    }
    if (st.accion === "delete") return { data: null, count: esc.borradas ?? 0, error: null };
    if (st.head) return { data: null, count: esc.previos ?? 0, error: null };
    return { data: [], count: null, error: null };
  };

  mock.module("../src/config/supabase.js", {
    exports: { supabase: { from: (t) => builder(t) } },
  });

  ({ refrescarSnapshot, PullIncompletoError } = await import("../src/services/snapshot.service.js"));
});

beforeEach(() => {
  esc.registradas = [];
  esc.filas = [
    ...Array.from({ length: 6 }, (_, i) => filaCruda("00301", `O${i}`)),
    ...Array.from({ length: 4 }, (_, i) => filaCruda("00401", `D${i}`)),
  ];
  esc.declarado = null;
  esc.previos = 0;
  esc.borradas = 0;
  esc.fallaBitacora = null;
  esc.fallaConnekta = null;
});

test("un refresco exitoso deja una línea con el conteo POR BODEGA", async () => {
  // El total general puede verse sano mientras una sede se vacía. Sin este
  // desglose no se puede contestar "cuántos ítems tenía Llano a tal hora".
  await refrescarSnapshot();

  assert.equal(esc.registradas.length, 1);
  const log = esc.registradas[0];
  assert.equal(log.resultado, "ok");
  assert.equal(log.items, 10);
  assert.deepEqual(log.por_bodega, { "00301": 6, "00401": 4 });
  assert.equal(log.detalle, undefined, "sin detalle cuando salió bien");
  assert.ok(typeof log.duracion_ms === "number");
});

test("deja registrado cuántas filas se llevó el prune", async () => {
  esc.borradas = 37;
  await refrescarSnapshot();

  assert.equal(esc.registradas[0].borradas, 37);
});

test("un refresco ABORTADO por las guardas también queda registrado", async () => {
  // Es el evento más interesante: significa que Connekta devolvió un pull
  // parcial. Hoy eso solo vive en los logs de GitHub Actions, que caducan.
  esc.declarado = 1000; // Connekta declara 1000 filas y trajimos 10

  await assert.rejects(() => refrescarSnapshot(), PullIncompletoError);

  assert.equal(esc.registradas.length, 1);
  const log = esc.registradas[0];
  assert.equal(log.resultado, "abortado");
  assert.match(log.detalle, /Pull incompleto: 10\/1000/);
  assert.equal(log.filas_declaradas, 1000);
});

test("una regresión brusca se registra como abortada, con lo que ya se sabía", async () => {
  esc.previos = 500; // había 500 ítems y el pull trae 10

  await assert.rejects(() => refrescarSnapshot(), PullIncompletoError);

  const log = esc.registradas[0];
  assert.equal(log.resultado, "abortado");
  assert.match(log.detalle, /Regresión sospechosa/);
  assert.deepEqual(log.por_bodega, { "00301": 6, "00401": 4 }, "guarda lo averiguado antes de abortar");
});

test("un error inesperado se distingue de un abort", async () => {
  esc.fallaConnekta = "connekta no responde";

  await assert.rejects(() => refrescarSnapshot(), /connekta no responde/);

  assert.equal(esc.registradas[0].resultado, "error");
});

test("si la bitácora falla, el refresco NO se cae", async () => {
  // La migración 041 se corre a mano. Hasta que alguien la corra, la tabla no
  // existe: eso no puede dejar al panel sin datos.
  esc.fallaBitacora = 'relation "traslados_snapshot_log" does not exist';

  const r = await refrescarSnapshot();

  assert.equal(r.total, 10, "el refresco terminó bien igual");
  assert.equal(esc.registradas.length, 0);
});
