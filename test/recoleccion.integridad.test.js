import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { crearBD } from "./helpers/fakeSupabase.js";

/* =============================================================================
   INTEGRIDAD DE LA RECOLECCIÓN Y LA RECEPCIÓN — nada se pierde, nada se cruza.

   Cada test reproduce una carrera o un reintento que en producción deja datos
   mal, contra una base en memoria que filtra de verdad (ver helpers/fakeSupabase).
   "Otro celular" se mete en el medio con `bd.hooks.antesDe`, así la carrera es
   determinista y el test falla siempre con el código viejo, no de a ratos.

   El caso que dio origen a esto: 27/09/2026, traslado ad75f5e5 → parte 2
   818290c6. Un cierre (POST /recolectar con TODOS los renglones) seguía
   escribiendo mientras otro celular enviaba la primera parte; los renglones
   mudados a la parte 2 recibieron cantidad 0 y dueño, y el traslado nuevo nació
   "contado en cero".
   ============================================================================= */

let bd;
let DespachoModel;
let DespachoService;
let validators;

const D = "d0000000-0000-4000-8000-000000000001";
const OTRO = "d0000000-0000-4000-8000-000000000002";
const PARQUE = "trasladoparque@merkahorrosas.com";

const itemId = (n, pref = "a") => `${pref}0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function despacho(over = {}) {
  return {
    id: D,
    estado: "En_recoleccion",
    flujo: "llano",
    origen: "00301",
    destino: "00401",
    inactivo: false,
    despachador_id: PARQUE,
    criterios: [],
    admin_id: null,
    parte_num: null,
    ...over,
  };
}

function item(n, over = {}) {
  return {
    id: itemId(n),
    despacho_id: D,
    codigo_item: String(1000 + n),
    descripcion: `Producto ${n}`,
    unidad_medida: "UND",
    factor: 1,
    cantidad_admin: 10,
    cantidad_despachador: null,
    cantidad_auditor: null,
    agotado: false,
    motivo: null,
    recolectado_por: null,
    no_recibido: false,
    ...over,
  };
}

// `mock.module` cambió de forma entre versiones de Node: hasta la 22 las
// exportaciones van en `namedExports`; las versiones nuevas las piden en
// `exports`. Con la clave equivocada no falla el mock sino el import ("does not
// provide an export named ..."), que se lee como un bug del código.
function mockModulo(ruta, { exports: exportaciones }) {
  const mayor = Number(process.versions.node.split(".")[0]);
  mock.module(ruta, mayor >= 24 ? { exports: exportaciones } : { namedExports: exportaciones });
}

const itemsDe = (id) => bd.tablas.traslados_items.filter((it) => it.despacho_id === id);
const escriturasDeItems = () =>
  bd.log.filter((l) => l.tabla === "traslados_items" && l.op !== "select");

before(async () => {
  // El proxy deja cambiar la base en cada test sin re-importar los módulos.
  mockModulo("../src/config/supabase.js", {
    exports: { supabase: { from: (t) => bd.supabase.from(t) } },
  });
  mockModulo("../src/services/notificacionesTraslado.service.js", {
    exports: {
      notificarRecoleccionCerrada: async () => {},
      enviarComparativoAuditoria: async () => {},
      enviarErrorSiesa: async () => {},
      enviarInciertoSiesa: async () => {},
      enviarManifiestoCarga: async () => {},
    },
  });
  mockModulo("../src/services/requisicion.service.js", {
    exports: { enviarRequisicion: async () => ({ estado: "enviado" }) },
  });
  mockModulo("../src/services/siesaTransito.consulta.js", {
    exports: { consultaConfigurada: () => false },
  });
  mockModulo("../src/services/siesaStock.service.js", {
    exports: { getStockLote: async () => ({}) },
  });
  mockModulo("../src/services/siesa.service.js", {
    // La ficha devuelve el código tal cual: el test controla qué matchea.
    exports: {
      fichaDeItem: async (codigo) => ({ codigo_item: codigo, descripcion: `Ficha ${codigo}` }),
    },
  });
  mockModulo("../src/services/analitica.service.js", {
    exports: { analitica: async () => ({}) },
  });

  DespachoModel = await import("../src/models/Despacho.model.js");
  DespachoService = await import("../src/services/despacho.service.js");
  ({ validators } = await import("../src/middleware/validators.js"));
});

beforeEach(() => {
  bd = crearBD({ traslados_despachos: [], traslados_items: [], traslados_firmas: [] });
});

/* ── RECOLECCIÓN ───────────────────────────────────────────────────────────── */

test("EL CASO REAL (27/09): un cierre en curso NO escribe sobre los renglones que se mudaron a la parte 2", async () => {
  // 20 renglones: 5 contados, 15 sin tocar.
  bd.tablas.traslados_despachos.push(despacho());
  for (let n = 0; n < 20; n++) {
    bd.tablas.traslados_items.push(
      item(n, n < 5 ? { cantidad_despachador: 5, recolectado_por: PARQUE } : {}),
    );
  }

  // El cierre del front manda TODOS los renglones: los no tocados viajan en 0.
  const loteCierre = Array.from({ length: 20 }, (_, n) => ({
    id: itemId(n),
    cantidad: n < 5 ? 5 : 0,
    agotado: false,
  }));

  // Otro celular aprieta "Enviar primera parte" justo cuando termina la primera
  // tanda del cierre (en la cerca de la segunda).
  let escritos = 0;
  let dividido = false;
  bd.hooks.antesDe = async (tabla, op) => {
    if (tabla === "traslados_items" && op === "update") escritos += 1;
    if (!dividido && tabla === "traslados_despachos" && op === "select" && escritos >= 8) {
      dividido = true;
      await DespachoModel.dividirEnPartes(D);
    }
  };

  const r = await DespachoService.registrarLoteRecoleccion(D, loteCierre, PARQUE);

  const parte2 = bd.tablas.traslados_despachos.find((d) => d.parte_de === D);
  assert.ok(parte2, "se creó la parte 2");

  // La parte 2 tiene los 15 no tocados y NINGUNO quedó "contado en cero" ni con dueño.
  const enParte2 = itemsDe(parte2.id);
  assert.equal(enParte2.length, 15);
  for (const it of enParte2) {
    assert.equal(it.cantidad_despachador, null, `${it.id} tiene que llegar sin contar`);
    assert.equal(it.recolectado_por, null, `${it.id} no puede tener dueño`);
  }

  // Los 12 que el cierre intentó escribir después de la mudanza vuelven aparte.
  assert.equal(r.fuera_de_despacho.length, 12);
  assert.equal(r.resultados.length, 8);

  // La primera parte conserva intactos los 5 contados.
  const enParte1 = itemsDe(D);
  assert.equal(enParte1.length, 5);
  assert.ok(enParte1.every((it) => it.cantidad_despachador === 5 && it.recolectado_por === PARQUE));
});

test("dividir NO se lleva un producto que alguien contó entre la lectura y la mudanza", async () => {
  bd.tablas.traslados_despachos.push(despacho());
  bd.tablas.traslados_items.push(item(0, { cantidad_despachador: 5, recolectado_por: PARQUE }));
  for (let n = 1; n < 6; n++) bd.tablas.traslados_items.push(item(n));

  // Justo antes de mudar, otra persona registra el producto 3.
  bd.hooks.antesDe = (tabla, op, c) => {
    if (tabla === "traslados_items" && op === "update" && c.patch?.despacho_id) {
      const it = bd.tablas.traslados_items.find((x) => x.id === itemId(3));
      if (it.cantidad_despachador == null) {
        it.cantidad_despachador = 4;
        it.recolectado_por = "otra@merkahorrosas.com";
      }
    }
  };

  const { parte2, movidos } = await DespachoModel.dividirEnPartes(D);

  assert.equal(movidos, 4, "se mudan solo los 4 que seguían sin tocar");
  const contado = bd.tablas.traslados_items.find((x) => x.id === itemId(3));
  assert.equal(contado.despacho_id, D, "el recién contado se queda en la primera parte");
  assert.equal(contado.cantidad_despachador, 4);
  assert.equal(itemsDe(parte2.id).length, 4);
});

test("dividir normaliza a null los 0 sin motivo que se mudan (la parte 2 nace por recorrer)", async () => {
  bd.tablas.traslados_despachos.push(despacho());
  bd.tablas.traslados_items.push(item(0, { cantidad_despachador: 5, recolectado_por: PARQUE }));
  bd.tablas.traslados_items.push(item(1, { cantidad_despachador: 0, recolectado_por: PARQUE }));
  bd.tablas.traslados_items.push(item(2, { cantidad_despachador: 0, motivo: "sin_stock", agotado: true }));

  const { parte2, movidos } = await DespachoModel.dividirEnPartes(D);

  assert.equal(movidos, 1);
  const [mudado] = itemsDe(parte2.id);
  assert.equal(mudado.id, itemId(1));
  assert.equal(mudado.cantidad_despachador, null);
  assert.equal(mudado.recolectado_por, null);
  // El agotado con motivo es un dato real de hoy: se queda.
  assert.equal(bd.tablas.traslados_items.find((x) => x.id === itemId(2)).despacho_id, D);
});

test("dividir no parte un traslado que otro celular cerró en el medio", async () => {
  bd.tablas.traslados_despachos.push(despacho());
  bd.tablas.traslados_items.push(item(0, { cantidad_despachador: 5, recolectado_por: PARQUE }));
  bd.tablas.traslados_items.push(item(1));

  // Entre la lectura y la cerca, el traslado pasa a Pendiente_carga.
  bd.hooks.antesDe = (tabla, op, c) => {
    if (tabla === "traslados_despachos" && op === "update" && c.patch?.updated_at && !c.patch.estado) {
      bd.tablas.traslados_despachos[0].estado = "Pendiente_carga";
    }
  };

  await assert.rejects(DespachoModel.dividirEnPartes(D), (e) => e.statusCode === 409);
  assert.equal(bd.tablas.traslados_despachos.length, 1, "no quedó ninguna parte 2");
  assert.equal(itemsDe(D).length, 2, "no se mudó nada");
});

test("dividir no deja la primera parte vacía si en el medio se des-contó lo único registrado", async () => {
  bd.tablas.traslados_despachos.push(despacho());
  bd.tablas.traslados_items.push(item(0, { cantidad_despachador: 5, recolectado_por: PARQUE }));
  bd.tablas.traslados_items.push(item(1));

  // Justo antes de mudar, la persona corrige su único conteo a 0.
  bd.hooks.antesDe = (tabla, op, c) => {
    if (tabla === "traslados_items" && op === "update" && c.patch?.despacho_id && c.patch.recolectado_por === null) {
      bd.tablas.traslados_items[0].cantidad_despachador = 0;
    }
  };

  await assert.rejects(DespachoModel.dividirEnPartes(D), (e) => e.statusCode === 409);
  assert.equal(bd.tablas.traslados_despachos.length, 1, "se borró la parte 2");
  assert.equal(itemsDe(D).length, 2, "los renglones volvieron a la primera parte");
});

test("la cerca entre tandas: si el traslado deja de estar en recolección, el lote se corta", async () => {
  bd.tablas.traslados_despachos.push(despacho());
  for (let n = 0; n < 20; n++) bd.tablas.traslados_items.push(item(n));
  const lote = Array.from({ length: 20 }, (_, n) => ({ id: itemId(n), cantidad: 3 }));

  // Otro celular cierra la recolección después de la primera tanda.
  let escritos = 0;
  bd.hooks.antesDe = (tabla, op) => {
    if (tabla === "traslados_items" && op === "update") escritos += 1;
    if (tabla === "traslados_despachos" && op === "select" && escritos >= 8) {
      bd.tablas.traslados_despachos[0].estado = "Pendiente_carga";
    }
  };

  await assert.rejects(
    DespachoService.registrarLoteRecoleccion(D, lote, PARQUE),
    (e) => e.statusCode === 409,
  );
  const escritosDeVerdad = itemsDe(D).filter((it) => it.cantidad_despachador === 3);
  assert.equal(escritosDeVerdad.length, 8, "solo la primera tanda, nada después del cierre");
});

test("candado por renglón: si otra persona lo toma entre la lectura y la escritura, NO se pisa su conteo", async () => {
  bd.tablas.traslados_despachos.push(despacho());
  bd.tablas.traslados_items.push(item(0));

  // Entre el SELECT y el UPDATE de Ana, Beto registra el mismo producto.
  let metido = false;
  bd.hooks.antesDe = (tabla, op) => {
    if (!metido && tabla === "traslados_items" && op === "update") {
      metido = true;
      Object.assign(bd.tablas.traslados_items[0], {
        cantidad_despachador: 7,
        recolectado_por: "beto@merkahorrosas.com",
      });
    }
  };

  const r = await DespachoService.registrarLoteRecoleccion(
    D,
    [{ id: itemId(0), cantidad: 2 }],
    "ana@merkahorrosas.com",
  );

  assert.equal(r.conflictos.length, 1);
  assert.equal(r.conflictos[0].dueno, "beto@merkahorrosas.com");
  assert.equal(bd.tablas.traslados_items[0].cantidad_despachador, 7, "el conteo de Beto queda");
});

test("un renglón de OTRO traslado nunca se escribe desde este", async () => {
  bd.tablas.traslados_despachos.push(despacho(), despacho({ id: OTRO }));
  bd.tablas.traslados_items.push(item(0), item(1, { despacho_id: OTRO }));

  const r = await DespachoService.registrarLoteRecoleccion(
    D,
    [
      { id: itemId(0), cantidad: 1 },
      { id: itemId(1), cantidad: 9 },
    ],
    PARQUE,
  );

  assert.equal(r.resultados.length, 1);
  assert.deepEqual(r.fuera_de_despacho.map((f) => f.item_id), [itemId(1)]);
  const ajeno = bd.tablas.traslados_items.find((x) => x.id === itemId(1));
  assert.equal(ajeno.cantidad_despachador, null);
  assert.equal(ajeno.recolectado_por, null);
});

test("el mismo renglón repetido en el lote se escribe una vez, con el último valor", async () => {
  bd.tablas.traslados_despachos.push(despacho());
  bd.tablas.traslados_items.push(item(0));

  const r = await DespachoService.registrarLoteRecoleccion(
    D,
    [
      { id: itemId(0), cantidad: 1 },
      { id: itemId(0), cantidad: 6 },
    ],
    PARQUE,
  );

  assert.equal(r.resultados.length, 1);
  assert.equal(bd.tablas.traslados_items[0].cantidad_despachador, 6);
});

test("la auto-clasificación del llano sigue escribiendo al cerrar (sistema, sin dueño)", async () => {
  bd.tablas.traslados_despachos.push(despacho());
  bd.tablas.traslados_items.push(
    item(0, { cantidad_despachador: 4, recolectado_por: PARQUE }), // parcial
    item(1), // pendiente
  );

  await DespachoService.cambiarEstado(D, "Pendiente_carga");

  const [parcial, pendiente] = itemsDe(D);
  assert.equal(parcial.motivo, "surtido_parcial");
  assert.equal(parcial.cantidad_despachador, 4);
  // Sin dato de stock (el mock no devuelve nada) no se inventa un motivo.
  assert.equal(pendiente.motivo, null);
});

/* ── RECEPCIÓN (AUDITOR) ───────────────────────────────────────────────────── */

function despachoRecibible() {
  bd.tablas.traslados_despachos.push(despacho({ estado: "Recolectado" }));
  bd.tablas.traslados_items.push(
    item(0, { codigo_item: "189202", cantidad_despachador: 5, recolectado_por: PARQUE }),
    item(1, { cantidad_despachador: 3, recolectado_por: PARQUE }),
  );
}

const payloadConfirmar = () => ({
  decision: "inconsistencia",
  auditorId: "auditor@merkahorrosas.com",
  firmaData: "data:image/png;base64,AAA",
  items: [
    { id: itemId(0), cantidad_auditor: 5 },
    { id: itemId(1), cantidad_auditor: 0, no_recibido: true },
    // Sobrante que ES el producto 0 (llega con el relleno de ceros de SIESA).
    { nuevo: true, codigo_item: "0189202", cantidad_auditor: 1 },
    // Sobrante que no estaba en la lista.
    { nuevo: true, codigo_item: "777", cantidad_auditor: 2 },
  ],
});

test("validador: la marca 'no recibido' del auditor ya no se descarta", () => {
  const req = { body: { decision: "aprobado", firma_data: "x", items: [{ id: itemId(1), cantidad_auditor: 0, no_recibido: true }] } };
  let paso = false;
  validators.confirmar(req, { status: () => ({ json: () => {} }) }, () => {
    paso = true;
  });
  assert.ok(paso);
  assert.equal(req.body.items[0].no_recibido, true);
});

test("confirmar guarda el no-recibido y suma el sobrante al renglón existente", async () => {
  despachoRecibible();

  await DespachoService.confirmarAuditoria(D, payloadConfirmar());

  const [p0, p1] = [itemId(0), itemId(1)].map((id) => bd.tablas.traslados_items.find((x) => x.id === id));
  assert.equal(p0.cantidad_auditor, 6, "5 contados + 1 sobrante del mismo código");
  assert.equal(p1.no_recibido, true);
  assert.equal(p1.cantidad_auditor, 0);
  const extra = itemsDe(D).filter((x) => x.agregado_por_auditor);
  assert.equal(extra.length, 1);
  assert.equal(extra[0].cantidad_auditor, 2);
  assert.equal(bd.tablas.traslados_despachos[0].estado, "Recibido_con_inconsistencia");
});

test("REINTENTO de confirmar tras una falla a mitad de camino: no duplica ni dobla nada", async () => {
  despachoRecibible();

  // Primer intento: escribe los conteos y se cae al cambiar el estado.
  bd.hooks.antesDe = (tabla, op, c) => {
    if (tabla === "traslados_despachos" && op === "update" && c.patch?.estado) {
      return { error: { message: "timeout de red" } };
    }
  };
  await assert.rejects(DespachoService.confirmarAuditoria(D, payloadConfirmar()));
  assert.equal(bd.tablas.traslados_despachos[0].estado, "Recolectado");

  // Reintento con el mismo conteo.
  bd.hooks.antesDe = null;
  await DespachoService.confirmarAuditoria(D, payloadConfirmar());

  assert.equal(bd.tablas.traslados_items.find((x) => x.id === itemId(0)).cantidad_auditor, 6, "no 7");
  const extras = itemsDe(D).filter((x) => x.agregado_por_auditor);
  assert.equal(extras.length, 1, "el sobrante no se duplica");
  assert.equal(extras[0].cantidad_auditor, 2, "ni se dobla");
});

test("confirmar un traslado YA cerrado rebota ANTES de tocar nada", async () => {
  despachoRecibible();
  bd.tablas.traslados_despachos[0].estado = "Auditado";
  bd.tablas.traslados_items[0].cantidad_auditor = 5;

  await assert.rejects(
    DespachoService.confirmarAuditoria(D, payloadConfirmar()),
    (e) => e.statusCode === 409,
  );
  assert.equal(escriturasDeItems().length, 0, "ninguna escritura sobre los renglones");
  assert.equal(bd.tablas.traslados_items[0].cantidad_auditor, 5);
});

test("confirmar con un producto de otro traslado rebota sin escribir nada", async () => {
  despachoRecibible();
  bd.tablas.traslados_items.push(item(9, { despacho_id: OTRO }));
  const p = payloadConfirmar();
  p.items.push({ id: itemId(9), cantidad_auditor: 4 });

  await assert.rejects(DespachoService.confirmarAuditoria(D, p), (e) => e.statusCode === 422);
  assert.equal(escriturasDeItems().length, 0);
});

/* ── ELIMINAR / EDITAR / CREAR / INACTIVAR ─────────────────────────────────── */

test("eliminar: un traslado con recolección en curso NO se borra", async () => {
  bd.tablas.traslados_despachos.push(despacho());
  bd.tablas.traslados_items.push(item(0, { cantidad_despachador: 5, recolectado_por: PARQUE }));

  await assert.rejects(DespachoModel.eliminar(D), (e) => e.statusCode === 409);
  assert.equal(bd.tablas.traslados_despachos.length, 1);
  assert.equal(bd.tablas.traslados_items.length, 1);
});

test("eliminar: un traslado en Creado sí se borra, con sus renglones", async () => {
  bd.tablas.traslados_despachos.push(despacho({ estado: "Creado" }));
  bd.tablas.traslados_items.push(item(0));

  await DespachoModel.eliminar(D);
  assert.equal(bd.tablas.traslados_despachos.length, 0);
  assert.equal(bd.tablas.traslados_items.length, 0);
});

test("editar: una lista vacía no vacía el traslado", async () => {
  bd.tablas.traslados_despachos.push(despacho({ estado: "Creado" }));
  bd.tablas.traslados_items.push(item(0), item(1));

  await assert.rejects(DespachoModel.editarItems(D, []), (e) => e.statusCode === 422);
  assert.equal(itemsDe(D).length, 2);
});

test("editar: un id de otro traslado no cambia el renglón ajeno ni cuenta como 'queda'", async () => {
  bd.tablas.traslados_despachos.push(despacho({ estado: "Creado" }), despacho({ id: OTRO, estado: "En_recoleccion" }));
  bd.tablas.traslados_items.push(item(0), item(1, { despacho_id: OTRO, cantidad_admin: 10 }));

  // Solo ids ajenos: equivale a vaciar este traslado → se rechaza.
  await assert.rejects(
    DespachoModel.editarItems(D, [{ id: itemId(1), cantidad: 99 }]),
    (e) => e.statusCode === 422,
  );
  // Mezclado con uno propio: el propio se edita, el ajeno no se toca.
  await DespachoModel.editarItems(D, [
    { id: itemId(0), cantidad: 3 },
    { id: itemId(1), cantidad: 99 },
  ]);
  assert.equal(bd.tablas.traslados_items.find((x) => x.id === itemId(0)).cantidad_admin, 3);
  assert.equal(bd.tablas.traslados_items.find((x) => x.id === itemId(1)).cantidad_admin, 10);
});

test("crear: si fallan los renglones no queda una cabecera fantasma", async () => {
  bd.hooks.antesDe = (tabla, op) => {
    if (tabla === "traslados_items" && op === "insert") return { error: { message: "constraint" } };
  };
  await assert.rejects(
    DespachoModel.create({ destino: "00401", items: [{ codigo_item: "1", cantidad: 2 }] }),
  );
  assert.equal(bd.tablas.traslados_despachos.length, 0);
});

test("inactivar desde el barrido: si alguien lo tomó en el medio, no se congela", async () => {
  bd.tablas.traslados_despachos.push(despacho({ estado: "En_recoleccion" }));

  const r = await DespachoModel.setActivo(D, false, "barrido", { soloSiEstado: "Creado" });
  assert.equal(r, null);
  assert.equal(bd.tablas.traslados_despachos[0].inactivo, false);
});

test("findById de un id que no existe es null (404), no un error de base (500)", async () => {
  assert.equal(await DespachoModel.findById(D), null);
});
