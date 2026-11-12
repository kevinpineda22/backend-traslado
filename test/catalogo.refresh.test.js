import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

/* =============================================================================
   Refresco del CATÁLOGO de ítems (catalogo.service.js).

   Lo que se certifica es la red de seguridad: un pull parcial NUNCA borra el
   catálogo bueno. Las guardas (completitud y regresión) se evalúan ANTES de la
   poda, así que en un pull malo no debe haber ni upsert ni borrado.

   Se mockean Connekta, el modelo (la BD) y el lock: no se toca nada real.
   ============================================================================= */

let refrescarCatalogo;
let refrescarCatalogoUnico;
let CatalogoIncompletoError;
let CatalogoRefreshEnCursoError;
let dedupePorCodigo;

// Lo que devuelve Connekta, página por página, y lo que declara tener.
let paginas = [];
let declarado = 0;
// Estado de la "BD".
let previos = 0;
const llamadas = {};
const impl = { lock: true, retrasoPagina: {} };

const fila = (codigo, extra = {}) => ({
  CodigoItem: codigo,
  RowidItemExt: Number(codigo) * 10,
  DescItem: `  ITEM ${codigo}  `,
  Referencia: "REF",
  UM: "UND",
  UMOrden: "UND",
  Estado: 1,
  IdGrupo: "01",
  Grupo: "ABARROTES",
  IdSubgrupo: "0101",
  Subgrupo: "ARROZ",
  ...extra,
});

/** n filas con códigos 1..n repartidas en páginas de `tam`. */
function pull(n, tam = 1000) {
  const filas = Array.from({ length: n }, (_, i) => fila(String(i + 1)));
  const pags = [];
  for (let i = 0; i < filas.length; i += tam) pags.push(filas.slice(i, i + tam));
  return pags.length ? pags : [[]];
}

before(async () => {
  mock.module("../src/config/connekta.js", {
    exports: {
      ejecutarConsulta: async (descripcion, pagina) => {
        llamadas.consultas.push({ descripcion, pagina });
        const espera = impl.retrasoPagina[pagina];
        if (espera) await new Promise((r) => setTimeout(r, espera));
        return {
          datos: paginas[pagina - 1] || [],
          total: declarado,
          pagina,
          totalPaginas: paginas.length,
        };
      },
    },
  });
  mock.module("../src/services/lock.service.js", {
    exports: {
      tomarLock: async () => {
        llamadas.lock += 1;
        return impl.lock;
      },
      liberarLock: async () => {
        llamadas.liberado += 1;
      },
      lockTomado: async () => false,
    },
  });
  mock.module("../src/services/snapshot.service.js", {
    exports: { dispararRefreshRemoto: async () => ({ disponible: false }) },
  });
  mock.module("../src/models/Catalogo.model.js", {
    exports: {
      contar: async () => previos,
      upsertar: async (filas) => {
        if (impl.upsertFalla) throw new Error("Error al guardar el catálogo: boom");
        llamadas.upserts.push(filas);
      },
      podarAnterioresA: async (inicio) => {
        llamadas.podas.push(inicio);
        return 7;
      },
      registrarLog: async (f) => llamadas.logs.push(f),
      buscar: async () => [],
      porCodigos: async () => new Map(),
      estado: async () => ({ total: 0, sincronizado_at: null }),
    },
  });

  ({
    refrescarCatalogo,
    refrescarCatalogoUnico,
    CatalogoIncompletoError,
    CatalogoRefreshEnCursoError,
    dedupePorCodigo,
  } = await import("../src/services/catalogo.service.js"));
});

beforeEach(() => {
  paginas = [];
  declarado = 0;
  previos = 0;
  impl.lock = true;
  impl.retrasoPagina = {};
  impl.upsertFalla = false;
  Object.assign(llamadas, {
    consultas: [],
    upserts: [],
    podas: [],
    logs: [],
    lock: 0,
    liberado: 0,
  });
});

test("pull completo: upsert en chunks, luego poda con el inicio del refresco, y bitácora ok", async () => {
  paginas = pull(2500); // 3 páginas
  declarado = 2500;
  previos = 2400;

  const r = await refrescarCatalogo();

  assert.equal(r.total, 2500);
  assert.equal(r.borradas, 7);
  assert.equal(llamadas.consultas.length, 3, "una consulta por página");
  assert.ok(llamadas.consultas.every((c) => c.descripcion === "merkahorro_catalogo_activo"));
  assert.deepEqual(llamadas.upserts.map((u) => u.length), [1000, 1000, 500], "upsert en chunks de 1000");
  assert.equal(llamadas.podas.length, 1);
  assert.equal(llamadas.podas[0], r.sincronizado_at, "poda lo anterior al inicio de ESTE refresco");
  assert.ok(llamadas.upserts.flat().every((f) => f.sincronizado_at === r.sincronizado_at));
  assert.equal(llamadas.logs.at(-1).resultado, "ok");
  assert.equal(llamadas.logs.at(-1).borradas, 7);
});

test("guarda de completitud: por debajo del 95% de lo declarado NO se escribe ni se borra nada", async () => {
  paginas = pull(900);
  declarado = 1000; // 90%
  previos = 900;

  await assert.rejects(refrescarCatalogo(), CatalogoIncompletoError);

  assert.equal(llamadas.upserts.length, 0, "sin upsert");
  assert.equal(llamadas.podas.length, 0, "sin poda");
  assert.equal(llamadas.logs.at(-1).resultado, "abortado");
});

test("justo en el 95% de completitud el pull pasa", async () => {
  paginas = pull(950);
  declarado = 1000;
  previos = 0;

  const r = await refrescarCatalogo();

  assert.equal(r.total, 950);
  assert.equal(llamadas.podas.length, 1);
});

test("guarda de regresión: menos del 80% de lo que ya hay NO borra nada", async () => {
  paginas = pull(700);
  declarado = 700; // completo según Connekta, pero la tabla tenía 1000
  previos = 1000;

  await assert.rejects(refrescarCatalogo(), (e) => {
    assert.ok(e instanceof CatalogoIncompletoError);
    assert.match(e.message, /Regresión sospechosa/);
    return true;
  });

  assert.equal(llamadas.upserts.length, 0);
  assert.equal(llamadas.podas.length, 0);
  assert.equal(llamadas.logs.at(-1).resultado, "abortado");
});

test("justo en el 80% de lo que ya hay pasa (el borde es inclusivo)", async () => {
  paginas = pull(800);
  declarado = 800;
  previos = 1000;

  await refrescarCatalogo();

  assert.equal(llamadas.podas.length, 1);
});

test("un pull sin ítems NUNCA es válido: no se vacía el catálogo", async () => {
  paginas = [[]];
  declarado = 0;
  previos = 500;

  await assert.rejects(refrescarCatalogo(), CatalogoIncompletoError);

  assert.equal(llamadas.podas.length, 0);
});

test("si el upsert falla la poda NO corre y la bitácora dice error", async () => {
  paginas = pull(10);
  declarado = 10;
  impl.upsertFalla = true;

  await assert.rejects(refrescarCatalogo(), /boom/);

  assert.equal(llamadas.podas.length, 0, "sin upsert completo no se borra nada");
  assert.equal(llamadas.logs.at(-1).resultado, "error");
});

test("dedupe: un código repetido (una fila por extensión) conserva la PRIMERA, y las filas sin código se descartan", () => {
  const registros = dedupePorCodigo(
    [
      fila("5", { DescItem: "PRIMERA", RowidItemExt: 50 }),
      fila("5", { DescItem: "SEGUNDA", RowidItemExt: 51 }),
      fila("6"),
      { ...fila("7"), CodigoItem: null },
      { ...fila("8"), CodigoItem: "  " },
    ],
    "2026-11-12T00:00:00.000Z",
  );

  assert.deepEqual(registros.map((r) => r.codigo_item), ["5", "6"]);
  assert.equal(registros[0].descripcion, "PRIMERA");
  assert.equal(registros[0].rowid_item_ext, 50);
});

test("el código se guarda como texto sin espacios y los campos se recortan", () => {
  const [r] = dedupePorCodigo([fila(" 19 ")], "ts");
  assert.equal(r.codigo_item, "19");
  assert.equal(r.descripcion, "ITEM  19", "se recorta el borde, no el interior");
  assert.equal(r.estado, 1);
  assert.equal(r.grupo, "ABARROTES");
  assert.equal(r.subgrupo, "ARROZ");
});

test("el 'primero' de un código repetido es el de la página menor, aunque conteste después", async () => {
  // La página 2 contesta ANTES que la 1... y la 1 trae el mismo código con otra descripción.
  paginas = [
    [fila("1", { DescItem: "DE LA PAGINA 1" }), fila("2")],
    [fila("1", { DescItem: "DE LA PAGINA 2" }), fila("3")],
  ];
  declarado = 4;
  previos = 0;
  impl.retrasoPagina = { 1: 30, 2: 0 };

  await refrescarCatalogo();

  const guardado = llamadas.upserts.flat().find((f) => f.codigo_item === "1");
  assert.equal(guardado.descripcion, "DE LA PAGINA 1");
});

test("con otro refresco en curso no se encola otro pull: lanza y no toca nada", async () => {
  impl.lock = false;
  paginas = pull(10);
  declarado = 10;

  await assert.rejects(refrescarCatalogoUnico("test"), CatalogoRefreshEnCursoError);

  assert.equal(llamadas.consultas.length, 0, "no se pidió nada a Connekta");
  assert.equal(llamadas.liberado, 0, "no libera un lock que no tomó");
});

test("el lock se libera aunque el refresco aborte por una guarda", async () => {
  paginas = pull(100);
  declarado = 1000;

  await assert.rejects(refrescarCatalogoUnico("test"), CatalogoIncompletoError);

  assert.equal(llamadas.lock, 1);
  assert.equal(llamadas.liberado, 1);
});
