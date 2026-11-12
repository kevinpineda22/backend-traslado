import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

/* =============================================================================
   API del portafolio extra y del catálogo (controladores + validación del body).

   Se llaman los controladores directo con un req/res de mentira y los modelos
   mockeados: lo que se certifica es la validación (destino, ítem inexistente o
   inactivo, duplicado) y la forma exacta de las respuestas, que es el contrato con
   el front.
   ============================================================================= */

let PortafolioCtrl;
let CatalogoCtrl;
let validators;

// Estado de los modelos simulados.
let catalogo = new Map();
let extras = [];
let existeAlQuitar = true;
let refreshImpl;
const llamadas = {};

const item = (codigo, extra = {}) => ({
  codigo_item: codigo,
  descripcion: `ITEM ${codigo}`,
  referencia: "REF",
  um: "UND",
  um_orden: "UND",
  estado: 1,
  grupo: "ABARROTES",
  subgrupo: "ARROZ",
  ...extra,
});

before(async () => {
  mock.module("../src/models/Catalogo.model.js", {
    exports: {
      MINIMO_BUSQUEDA: 2,
      normCodigoCatalogo: (c) => String(c ?? "").trim(),
      obtener: async (codigo) => catalogo.get(String(codigo).trim()) || null,
      buscar: async (q, limit) => {
        llamadas.buscar.push({ q, limit });
        return [...catalogo.values()];
      },
      porCodigos: async (codigos) => new Map(codigos.filter((c) => catalogo.has(c)).map((c) => [c, catalogo.get(c)])),
      estado: async () => ({ total: catalogo.size, sincronizado_at: llamadas.sincronizado_at }),
    },
  });
  mock.module("../src/models/PortafolioExtra.model.js", {
    exports: {
      listar: async (destino) => extras.filter((e) => e.destino === destino),
      agregar: async (datos) => {
        llamadas.agregar.push(datos);
        const previo = extras.find((e) => e.destino === datos.destino && e.codigo_item === datos.codigo_item);
        if (previo) return { creado: false, fila: previo };
        const fila = { ...datos, created_at: "2026-11-12T10:00:00.000Z" };
        extras.push(fila);
        return { creado: true, fila };
      },
      quitar: async () => existeAlQuitar,
    },
  });
  mock.module("../src/services/catalogo.service.js", {
    exports: {
      refrescarCatalogoUnico: async (d) => refreshImpl.inline(d),
      catalogoRefreshEnProgreso: async () => false,
      dispararRefreshCatalogoRemoto: async () => refreshImpl.remoto(),
      CatalogoRefreshEnCursoError: class CatalogoRefreshEnCursoError extends Error {},
      CatalogoIncompletoError: class CatalogoIncompletoError extends Error {},
    },
  });

  PortafolioCtrl = await import("../src/controllers/portafolioExtra.controller.js");
  CatalogoCtrl = await import("../src/controllers/catalogo.controller.js");
  ({ validators } = await import("../src/middleware/validators.js"));
});

beforeEach(() => {
  catalogo = new Map([
    ["100", item("100")],
    ["200", item("200", { estado: 0 })],
  ]);
  extras = [];
  existeAlQuitar = true;
  llamadas.buscar = [];
  llamadas.agregar = [];
  llamadas.sincronizado_at = null;
  refreshImpl = { remoto: async () => ({ disponible: false }), inline: async () => ({ total: 1 }) };
});

/** req/res de mentira: captura status, json y el error que va a `next`. */
function correr(handler, req) {
  return new Promise((resolve) => {
    const out = { status: 200, body: undefined, error: undefined };
    const res = {
      status(s) {
        out.status = s;
        return res;
      },
      json(b) {
        out.body = b;
        resolve(out);
        return res;
      },
    };
    handler({ query: {}, params: {}, body: {}, ...req }, res, (e) => {
      out.error = e;
      resolve(out);
    });
  });
}

test("POST: agrega un ítem activo a una sede válida → 201, creado:true y datos del catálogo", async () => {
  const r = await correr(PortafolioCtrl.agregar, {
    body: { destino: "00401", codigo_item: "100", agregado_por: "admin@merkahorro" },
  });

  assert.equal(r.error, undefined);
  assert.equal(r.status, 201);
  assert.deepEqual(r.body, {
    ok: true,
    creado: true,
    data: {
      destino: "00401",
      codigo_item: "100",
      agregado_por: "admin@merkahorro",
      created_at: "2026-11-12T10:00:00.000Z",
      descripcion: "ITEM 100",
      referencia: "REF",
      um: "UND",
      grupo: "ABARROTES",
      subgrupo: "ARROZ",
    },
  });
});

test("POST: cualquier sede de SEDES es válida, también las del flujo General y Machado", async () => {
  for (const destino of ["PV001", "00301", "00201", "00701", "00801", "00601", "00401", "01201"]) {
    const r = await correr(PortafolioCtrl.agregar, {
      body: { destino, codigo_item: "100", agregado_por: "a" },
    });
    assert.equal(r.error, undefined, destino);
    assert.equal(r.status, 201, destino);
  }
});

test("POST: destino inválido → 400 y no se escribe nada", async () => {
  const r = await correr(PortafolioCtrl.agregar, {
    body: { destino: "99999", codigo_item: "100", agregado_por: "a" },
  });

  assert.equal(r.error.statusCode, 400);
  assert.match(r.error.message, /99999/);
  assert.equal(llamadas.agregar.length, 0);
});

test("POST: ítem que no está en el catálogo → 404 y no se escribe nada", async () => {
  const r = await correr(PortafolioCtrl.agregar, {
    body: { destino: "00401", codigo_item: "777", agregado_por: "a" },
  });

  assert.equal(r.error.statusCode, 404);
  assert.match(r.error.message, /777/);
  assert.equal(llamadas.agregar.length, 0);
});

test("POST: ítem inactivo (estado distinto de 1) → 400 y no se escribe nada", async () => {
  const r = await correr(PortafolioCtrl.agregar, {
    body: { destino: "00401", codigo_item: "200", agregado_por: "a" },
  });

  assert.equal(r.error.statusCode, 400);
  assert.match(r.error.message, /no está activo/);
  assert.equal(llamadas.agregar.length, 0);
});

test("POST: agregar dos veces es idempotente → 200, creado:false, conserva quién lo agregó", async () => {
  await correr(PortafolioCtrl.agregar, {
    body: { destino: "00401", codigo_item: "100", agregado_por: "primero" },
  });
  const r = await correr(PortafolioCtrl.agregar, {
    body: { destino: "00401", codigo_item: "100", agregado_por: "segundo" },
  });

  assert.equal(r.error, undefined);
  assert.equal(r.status, 200);
  assert.equal(r.body.creado, false);
  assert.equal(r.body.data.agregado_por, "primero", "no pisa al que lo agregó");
  assert.equal(extras.length, 1);
});

test("POST: el código llega como número y se trata como texto", async () => {
  const r = await correr(PortafolioCtrl.agregar, {
    body: { destino: "00401", codigo_item: 100, agregado_por: "a" },
  });

  assert.equal(r.status, 201);
  assert.equal(llamadas.agregar[0].codigo_item, "100");
});

test("GET: destino faltante o inválido → 400", async () => {
  const sin = await correr(PortafolioCtrl.listar, { query: {} });
  assert.equal(sin.error.statusCode, 400);

  const malo = await correr(PortafolioCtrl.listar, { query: { destino: "XX" } });
  assert.equal(malo.error.statusCode, 400);
});

test("GET: lista solo los extras de esa sede", async () => {
  extras = [
    { destino: "00401", codigo_item: "100", agregado_por: "a", created_at: "t" },
    { destino: "01201", codigo_item: "100", agregado_por: "a", created_at: "t" },
  ];

  const r = await correr(PortafolioCtrl.listar, { query: { destino: "00401" } });

  assert.equal(r.body.ok, true);
  assert.deepEqual(r.body.data.map((e) => e.destino), ["00401"]);
});

test("DELETE: quita un extra existente → { ok, eliminado }", async () => {
  const r = await correr(PortafolioCtrl.eliminar, { params: { destino: "00401", codigo: "100" } });

  assert.deepEqual(r.body, { ok: true, eliminado: true });
});

test("DELETE: si no estaba agregado → 404; destino inválido → 400", async () => {
  existeAlQuitar = false;
  const noEsta = await correr(PortafolioCtrl.eliminar, { params: { destino: "00401", codigo: "100" } });
  assert.equal(noEsta.error.statusCode, 404);

  const malo = await correr(PortafolioCtrl.eliminar, { params: { destino: "ZZ", codigo: "100" } });
  assert.equal(malo.error.statusCode, 400);
});

/* ─── Validación del body (Zod) ─────────────────────────────────────── */

function validar(body) {
  const req = { body };
  const out = { status: 200, body: undefined, siguio: false };
  const res = {
    status(s) {
      out.status = s;
      return res;
    },
    json(b) {
      out.body = b;
      return res;
    },
  };
  validators.portafolioExtra(req, res, () => {
    out.siguio = true;
  });
  return { ...out, req };
}

test("validador: faltan campos → 400 con el detalle de cada campo", () => {
  const r = validar({ destino: "00401" });

  assert.equal(r.siguio, false);
  assert.equal(r.status, 400);
  assert.deepEqual(r.body.detalles.map((d) => d.campo).sort(), ["agregado_por", "codigo_item"]);
});

test("validador: recorta espacios y acepta el código numérico", () => {
  const r = validar({ destino: " 00401 ", codigo_item: 100, agregado_por: "  ana  ", basura: 1 });

  assert.equal(r.siguio, true);
  assert.deepEqual(r.req.body, { destino: "00401", codigo_item: "100", agregado_por: "ana" });
});

/* ─── Catálogo ──────────────────────────────────────────────────────── */

test("GET /catalogo: con menos de 2 caracteres → 400 y no se consulta", async () => {
  const r = await correr(CatalogoCtrl.buscar, { query: { q: "a" } });

  assert.equal(r.error.statusCode, 400);
  assert.equal(llamadas.buscar.length, 0);
});

test("GET /catalogo: devuelve { ok, data } y pasa q y limit al modelo", async () => {
  const r = await correr(CatalogoCtrl.buscar, { query: { q: " arroz ", limit: "20" } });

  assert.equal(r.body.ok, true);
  assert.equal(r.body.data.length, 2);
  assert.deepEqual(llamadas.buscar[0], { q: "arroz", limit: "20" });
});

test("GET /catalogo/estado: total, sincronizado_at y en_progreso", async () => {
  llamadas.sincronizado_at = "2026-11-12T07:30:00.000Z";
  const r = await correr(CatalogoCtrl.estado, {});

  assert.deepEqual(r.body, {
    ok: true,
    total: 2,
    sincronizado_at: "2026-11-12T07:30:00.000Z",
    en_progreso: false,
  });
});

test("POST /catalogo/refresh: con GitHub Actions configurado dispara el workflow y responde 202", async () => {
  refreshImpl.remoto = async () => ({ disponible: true });

  const r = await correr(CatalogoCtrl.refrescar, {});

  assert.equal(r.status, 202);
  assert.equal(r.body.disparado, true);
});

test("POST /catalogo/refresh: sin GitHub Actions corre inline y devuelve el resultado", async () => {
  refreshImpl.inline = async () => ({ total: 23071, crudas: 23071, totalDeclarado: 23071 });

  const r = await correr(CatalogoCtrl.refrescar, {});

  assert.equal(r.body.ok, true);
  assert.equal(r.body.total, 23071);
});

test("POST /catalogo/refresh: si se actualizó hace menos de un minuto → 429", async () => {
  llamadas.sincronizado_at = new Date().toISOString();

  const r = await correr(CatalogoCtrl.refrescar, {});

  assert.equal(r.status, 429);
});
