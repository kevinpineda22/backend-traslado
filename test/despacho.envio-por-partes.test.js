import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { crearBD } from "./helpers/fakeSupabase.js";

/* =============================================================================
   GENERAR LA SEGUNDA PARTE — el número que ve el admin es el que se mueve.

   HISTORIA DE ESTE ARCHIVO
   Antes probaba un interruptor de entorno (`TRASLADOS_ENVIO_POR_PARTES`) que
   apagaba "Enviar primera parte" en la puerta HTTP. Ese interruptor se fue: la
   decisión de negocio cambió y partir pasó a ser una acción del ADMIN desde el
   monitor, no del despachador desde el celular. El test cambió con ella, porque
   lo que hay que proteger ahora es otra cosa.

   QUÉ PROTEGE AHORA
   El despachador partía mirando su lista renglón por renglón: veía exactamente
   qué quedaba sin tocar. El admin parte mirando UN NÚMERO en la tarjeta del
   monitor. Si ese número y la cantidad que de verdad se muda no son el mismo,
   decide sobre un dato falso — y la primera vez que lo note deja de confiar en
   el panel.

   El predicado vive dos veces y no se pueden unificar:
     · `esMovibleAParte2(item)`, en JS, que alimenta el contador `movibles`;
     · el filtro PostgREST del UPDATE que hace la mudanza, que lo evalúa la base.

   Estos tests los atan. `fakeSupabase` evalúa los filtros fila por fila (no es
   un mock que devuelve siempre lo mismo), así que si alguien cambia uno de los
   dos y no el otro, acá se separa el conteo del movimiento y falla.
   ============================================================================= */

let bd;
let DespachoModel;

const D = "d0000000-0000-4000-8000-000000000001";
const PARQUE = "trasladoparque@merkahorrosas.com";

const itemId = (n) => `a0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

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
    cantidad_suelta: null,
    cantidad_auditor: null,
    agotado: false,
    motivo: null,
    recolectado_por: null,
    no_recibido: false,
    siesa_omitido: false,
    ...over,
  };
}

function mockModulo(ruta, { exports: exportaciones }) {
  const mayor = Number(process.versions.node.split(".")[0]);
  mock.module(ruta, mayor >= 24 ? { exports: exportaciones } : { namedExports: exportaciones });
}

before(async () => {
  mockModulo("../src/config/supabase.js", {
    exports: { supabase: { from: (t) => bd.supabase.from(t) } },
  });
  DespachoModel = await import("../src/models/Despacho.model.js");
});

beforeEach(() => {
  bd = crearBD({ traslados_despachos: [], traslados_items: [], traslados_firmas: [] });
});

const itemsDe = (id) => bd.tablas.traslados_items.filter((it) => it.despacho_id === id);

/* ── El predicado, caso por caso ───────────────────────────────────────────── */

test("esMovibleAParte2: se muda solo lo que nadie atendió", () => {
  const { esMovibleAParte2 } = DespachoModel;

  // Sin tocar: nadie pasó por el producto.
  assert.equal(esMovibleAParte2(item(1)), true, "cantidad null se muda");
  assert.equal(
    esMovibleAParte2(item(2, { cantidad_despachador: 0 })),
    true,
    "cantidad 0 SIN motivo se muda: es un renglón que nadie caminó, no un faltante",
  );

  // Atendido: alguien fue al pasillo y decidió algo.
  assert.equal(
    esMovibleAParte2(item(3, { cantidad_despachador: 4 })),
    false,
    "contado se queda con su conteo",
  );
  assert.equal(
    esMovibleAParte2(item(4, { agotado: true })),
    false,
    "agotado es una decisión tomada",
  );
  assert.equal(
    esMovibleAParte2(item(5, { motivo: "Inventario fantasma" })),
    false,
    "con motivo se queda: la persona ya decidió por qué faltó",
  );
  assert.equal(
    esMovibleAParte2(item(6, { motivo: "Corta fecha", cantidad_despachador: 0 })),
    false,
    "motivo gana sobre la cantidad en 0",
  );
});

/* ── El contador y la mudanza dicen lo mismo ───────────────────────────────── */

test("`movibles` del monitor == lo que `dividirEnPartes` mueve de verdad", async () => {
  bd.tablas.traslados_despachos.push(despacho());
  bd.tablas.traslados_items.push(
    // Atendidos (se quedan): contado, agotado, con motivo, y con motivo + cero.
    item(1, { cantidad_despachador: 10 }),
    item(2, { cantidad_despachador: 3 }),
    item(3, { agotado: true }),
    item(4, { motivo: "Inventario fantasma" }),
    item(5, { motivo: "Corta fecha", cantidad_despachador: 0 }),
    // Sin tocar (se mudan): null y cero sin motivo.
    item(6),
    item(7),
    item(8, { cantidad_despachador: 0 }),
  );

  const [cab] = await DespachoModel.findAllWithResumen({});
  assert.equal(cab.resumen.movibles, 3, "el monitor anuncia 3 renglones movibles");

  const { movidos } = await DespachoModel.dividirEnPartes(D);
  assert.equal(
    movidos,
    cab.resumen.movibles,
    "lo que se movió tiene que ser EXACTAMENTE lo que el admin vio anunciado",
  );
});

test("`movibles` NO es `pendientes`: son dos preguntas distintas", async () => {
  bd.tablas.traslados_despachos.push(despacho());
  bd.tablas.traslados_items.push(
    // `pendientes` lo cuenta (no tiene cantidad) pero NO se muda (tiene motivo).
    item(1, { motivo: "Inventario fantasma" }),
    // `incompletos` lo cuenta (0 < 10) pero SÍ se muda (cero sin motivo).
    item(2, { cantidad_despachador: 0 }),
    // Sin tocar de verdad: lo cuentan los dos.
    item(3),
    // Contado completo: ninguno de los dos.
    item(4, { cantidad_despachador: 10 }),
  );

  const [cab] = await DespachoModel.findAllWithResumen({});

  // Las dos cuentas valen 2, pero sobre renglones DISTINTOS. Que el total
  // coincida es casualidad de este armado; lo que importa es qué se mueve.
  assert.equal(cab.resumen.pendientes, 2, "pendientes: el del motivo y el sin tocar");
  assert.equal(cab.resumen.incompletos, 1, "incompletos: el que quedó en 0");
  assert.equal(cab.resumen.movibles, 2, "movibles: el que quedó en 0 y el sin tocar");

  const { parte2, movidos } = await DespachoModel.dividirEnPartes(D);
  assert.equal(movidos, 2);

  // La prueba de que son otros renglones: el del motivo se QUEDÓ y el del cero SE FUE.
  const enParte1 = itemsDe(D).map((it) => it.id);
  const enParte2 = itemsDe(parte2.id).map((it) => it.id);
  assert.ok(enParte1.includes(itemId(1)), "el renglón con motivo se queda en la parte 1");
  assert.ok(enParte2.includes(itemId(2)), "el renglón en cero sin motivo se va a la parte 2");
  assert.ok(enParte2.includes(itemId(3)), "el renglón sin tocar se va a la parte 2");
});

/* ── Las canastillas abiertas ya no bloquean (y la red está en el cierre) ──── */

test("movibles en 0 cuando no queda nada por caminar: el monitor no ofrece partir", async () => {
  bd.tablas.traslados_despachos.push(despacho());
  bd.tablas.traslados_items.push(
    item(1, { cantidad_despachador: 10 }),
    item(2, { agotado: true }),
    item(3, { motivo: "Inventario fantasma" }),
  );

  const [cab] = await DespachoModel.findAllWithResumen({});
  assert.equal(cab.resumen.movibles, 0);

  // Y el backend lo rechaza igual, por si el botón se mostró con datos viejos:
  // esconderlo en el front no es la cerca.
  await assert.rejects(
    DespachoModel.dividirEnPartes(D),
    (e) => e.statusCode === 409,
    "sin renglones movibles no se puede partir",
  );
});

/* =============================================================================
   PARTIR DESPUÉS DEL CIERRE

   Pedido del negocio (09/10/2026): poder generar la segunda parte en cualquier
   momento, aunque el traslado ya esté finalizado, con todo lo que no salió.

   POR QUÉ SE PUEDE AHORA Y ANTES NO
   Al cerrar, la auto-clasificación del Llano le pone motivo a todo lo que quedó:
   Agotado si no hay stock, Inventario Fantasma si lo hay. Esa regla asume que la
   persona FUE al pasillo. Cuando lo que pasó es que se quedó sin turno, la
   conclusión es falsa — es el error que la segunda parte vino a evitar (sql/032).
   Partir después del cierre RETRACTA esos motivos automáticos.

   Lo que no viajó no contradice ningún documento ya emitido: la requisición de
   SIESA solo lleva `cantidad_despachador > 0`, el manifiesto lista lo que salió, y
   `ocultoParaAuditor` esconde del auditor los renglones en 0.
   ============================================================================= */

const CERRADO = "Pendiente_carga";

test("cerrado: se mueve lo que no viajó, aunque la auto-clasificación le haya puesto motivo", async () => {
  bd.tablas.traslados_despachos.push(despacho({ estado: CERRADO }));
  bd.tablas.traslados_items.push(
    // Viajaron: se quedan. El de surtido parcial TAMBIÉN (salió mercancía real).
    item(1, { cantidad_despachador: 10 }),
    item(2, { cantidad_despachador: 4, motivo: "surtido_parcial" }),
    // No viajaron: los marcó el sistema al cerrar, no una persona.
    item(3, { cantidad_despachador: 0, motivo: "inventario_inflado" }),
    item(4, { cantidad_despachador: 0, agotado: true, motivo: "sin_stock" }),
    // No viajó y quedó sin clasificar (falló la consulta de stock a SIESA).
    item(5, { cantidad_despachador: 0 }),
  );

  const { parte2, movidos } = await DespachoModel.dividirEnPartes(D);
  assert.equal(movidos, 3);

  const quedan = itemsDe(D).map((it) => it.id);
  assert.deepEqual(quedan.sort(), [itemId(1), itemId(2)].sort(), "lo que salió se queda");

  const enParte2 = itemsDe(parte2.id);
  assert.equal(enParte2.length, 3);
});

test("la parte 2 nace EN BLANCO: sin motivo, sin agotado, sin cantidad", async () => {
  bd.tablas.traslados_despachos.push(despacho({ estado: CERRADO }));
  bd.tablas.traslados_items.push(
    item(1, { cantidad_despachador: 10 }),
    item(2, { cantidad_despachador: 0, agotado: true, motivo: "sin_stock", recolectado_por: PARQUE }),
    item(3, { cantidad_despachador: 0, motivo: "inventario_inflado" }),
  );

  const { parte2 } = await DespachoModel.dividirEnPartes(D);

  for (const it of itemsDe(parte2.id)) {
    assert.equal(it.motivo, null, `${it.id} tiene que llegar sin motivo`);
    assert.equal(it.agotado, false, `${it.id} no puede llegar agotado`);
    assert.equal(it.cantidad_despachador, null);
    assert.equal(it.recolectado_por, null);
  }
});

test("en recolección NO cambió nada: un motivo puesto a mano sigue siendo una decisión", async () => {
  bd.tablas.traslados_despachos.push(despacho()); // En_recoleccion
  bd.tablas.traslados_items.push(
    item(1, { cantidad_despachador: 10 }),
    item(2, { cantidad_despachador: 0, motivo: "inventario_inflado" }), // lo decidió alguien
    item(3),
  );

  const { parte2, movidos } = await DespachoModel.dividirEnPartes(D);
  assert.equal(movidos, 1, "solo el que nadie tocó");
  assert.deepEqual(
    itemsDe(parte2.id).map((it) => it.id),
    [itemId(3)],
  );
});

test("`movibles` del monitor usa el criterio del ESTADO de cada traslado", async () => {
  const items = [
    { cantidad_despachador: 10 },
    { cantidad_despachador: 0, motivo: "inventario_inflado" },
    { cantidad_despachador: 0, agotado: true, motivo: "sin_stock" },
    {},
  ];

  // Mismo armado, dos estados, dos respuestas.
  bd.tablas.traslados_despachos.push(despacho());
  items.forEach((o, i) => bd.tablas.traslados_items.push(item(i + 1, o)));
  const [enCurso] = await DespachoModel.findAllWithResumen({});
  assert.equal(enCurso.resumen.movibles, 1, "en recolección: solo el sin tocar");

  bd = crearBD({ traslados_despachos: [], traslados_items: [], traslados_firmas: [] });
  bd.tablas.traslados_despachos.push(despacho({ estado: CERRADO }));
  items.forEach((o, i) => bd.tablas.traslados_items.push(item(i + 1, o)));
  const [cerrado] = await DespachoModel.findAllWithResumen({});
  assert.equal(cerrado.resumen.movibles, 3, "cerrado: todo lo que no viajó");
});

test("si TODO salió no hay nada que partir, esté cerrado o no", async () => {
  bd.tablas.traslados_despachos.push(despacho({ estado: CERRADO }));
  bd.tablas.traslados_items.push(item(1, { cantidad_despachador: 10 }), item(2, { cantidad_despachador: 3 }));

  await assert.rejects(DespachoModel.dividirEnPartes(D), (e) => e.statusCode === 409);
});

test("si NO salió nada, partir dejaría la parte 1 vacía: se rechaza", async () => {
  bd.tablas.traslados_despachos.push(despacho({ estado: CERRADO }));
  bd.tablas.traslados_items.push(
    item(1, { cantidad_despachador: 0, motivo: "sin_stock", agotado: true }),
    item(2, { cantidad_despachador: 0, motivo: "inventario_inflado" }),
  );

  await assert.rejects(DespachoModel.dividirEnPartes(D), (e) => e.statusCode === 409);
  assert.equal(bd.tablas.traslados_despachos.length, 1, "no queda una parte 2 fantasma");
});

test("Borrador y Creado siguen bloqueados: no hay primera parte que dejar atrás", async () => {
  for (const estado of ["Borrador", "Creado"]) {
    bd = crearBD({ traslados_despachos: [], traslados_items: [], traslados_firmas: [] });
    bd.tablas.traslados_despachos.push(despacho({ estado }));
    bd.tablas.traslados_items.push(item(1, { cantidad_despachador: 5 }), item(2));
    await assert.rejects(
      DespachoModel.dividirEnPartes(D),
      (e) => e.statusCode === 409 && new RegExp(estado).test(e.message),
      `${estado} tiene que rechazarse`,
    );
  }
});

test("se puede partir incluso con el traslado ya recibido", async () => {
  bd.tablas.traslados_despachos.push(despacho({ estado: "Auditado" }));
  bd.tablas.traslados_items.push(
    item(1, { cantidad_despachador: 10 }),
    item(2, { cantidad_despachador: 0, motivo: "inventario_inflado" }),
  );

  const { movidos, parte2 } = await DespachoModel.dividirEnPartes(D);
  assert.equal(movidos, 1);
  assert.equal(parte2.estado, "Creado", "la parte 2 siempre nace en el pool");
});
