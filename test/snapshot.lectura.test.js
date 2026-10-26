import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

/* =============================================================================
   Lectura paginada del snapshot (`leerBodegas`).

   CONTEXTO (26/10/2026)
   El equipo reportó productos que mostraban inventario y consumo en 0 —"sin
   rotación"— cuando el snapshot sí tenía sus datos: el café NESCAFE, el azúcar
   MANUELITA y el frutiño de mora. Una fila que no llega NO se nota: el ítem
   desaparece del panel o, si tiene capacidad cargada, se dibuja en cero, que se
   lee como "agotado y no rota" en vez de como "me faltó el dato".

   Esta función alimenta el panel entero y no tenía una sola prueba. Paginaba con
   `range` SIN `ORDER BY` —el único paginador del repo que no ordenaba— y cortaba
   en silencio ante una página corta, sin comparar contra el total real.

   Se prueba sin tocar Supabase: un doble registra cada consulta, así que los
   tests pueden afirmar sobre el ORDEN pedido, no solo sobre el resultado.
   ============================================================================= */

let leerBodegas;
let bd;

/** Doble de Supabase que registra las consultas y puede inyectar fallos. */
function crearBD({ filas = [], alConsultar = null } = {}) {
  const estado = { filas, llamadas: [], alConsultar, enVuelo: 0, maxEnVuelo: 0 };

  const ejecutar = async (q) => {
    const propias = estado.filas.filter((f) => !q.bodegas || q.bodegas.includes(f.bodega));
    estado.llamadas.push({ orden: [...q.orden], rango: q.rango, head: q.head });

    // Cuántas páginas hay pedidas a la vez: así los tests pueden afirmar que se
    // piden en paralelo y no una detrás de la otra.
    if (!q.head) {
      estado.enVuelo += 1;
      estado.maxEnVuelo = Math.max(estado.maxEnVuelo, estado.enVuelo);
      const demora = estado.demoraDe?.(q.rango?.[0]) ?? 0;
      if (demora) await new Promise((ok) => setTimeout(ok, demora));
      estado.enVuelo -= 1;
    }

    const inyectado = estado.alConsultar?.({ ...q, nro: estado.llamadas.length });
    if (inyectado) return { data: null, count: null, error: { message: inyectado } };

    if (q.head) return { data: null, count: propias.length, error: null };

    // Si la consulta no pide orden, el doble devuelve las filas ROTADAS distinto
    // en cada llamada. No es maldad del doble: es lo que PostgreSQL puede hacer
    // con un SELECT sin ORDER BY, y es exactamente lo que rompe paginar por
    // `range` — unas filas salen dos veces y otras no salen nunca.
    const ordenadas = q.orden.length
      ? [...propias].sort((a, b) =>
          q.orden.reduce((cmp, c) => cmp || String(a[c]).localeCompare(String(b[c])), 0),
        )
      : (() => {
          const corte = (estado.llamadas.length * 137) % Math.max(1, propias.length);
          return [...propias.slice(corte), ...propias.slice(0, corte)];
        })();

    const [desde, hasta] = q.rango ?? [0, ordenadas.length - 1];
    const pagina = ordenadas.slice(desde, hasta + 1);
    const recortada = estado.recortarPagina?.(pagina, desde);
    return { data: recortada ?? pagina, count: null, error: null };
  };

  const builder = () => {
    const q = { bodegas: null, orden: [], rango: null, head: false, count: false };
    const self = {
      select(_cols, opts = {}) {
        q.count = opts.count === "exact";
        q.head = opts.head === true;
        return self;
      },
      in(_col, valores) {
        q.bodegas = valores;
        return self;
      },
      order(col) {
        q.orden.push(col);
        return self;
      },
      range(desde, hasta) {
        q.rango = [desde, hasta];
        return self;
      },
      then(ok, mal) {
        return ejecutar(q).then(ok, mal);
      },
    };
    return self;
  };

  estado.supabase = { from: () => builder() };
  return estado;
}

/** `n` filas repartidas entre dos bodegas, con códigos que ordenan distinto. */
const generar = (nOrigen, nDestino) => {
  const filas = [];
  for (let i = 0; i < nOrigen; i++) filas.push({ bodega: "00301", codigo_item: `O${i}`, disponible: i });
  for (let i = 0; i < nDestino; i++) filas.push({ bodega: "00401", codigo_item: `D${i}`, disponible: i });
  return filas;
};

before(async () => {
  bd = crearBD();
  mock.module("../src/config/supabase.js", {
    exports: {
      supabase: { from: (...a) => bd.supabase.from(...a) },
    },
  });
  ({ leerBodegas } = await import("../src/services/snapshot.service.js"));
});

beforeEach(() => {
  bd.filas = [];
  bd.llamadas = [];
  bd.alConsultar = null;
  bd.recortarPagina = null;
  bd.demoraDe = null;
  bd.enVuelo = 0;
  bd.maxEnVuelo = 0;
});

test("trae TODAS las filas aunque haya que pedir varias páginas", async () => {
  bd.filas = generar(1300, 1000); // 2300 > PAGE (1000) → tres páginas
  const filas = await leerBodegas(["00301", "00401"]);

  assert.equal(filas.length, 2300);
  assert.equal(filas.filter((f) => f.bodega === "00401").length, 1000);
  assert.equal(new Set(filas.map((f) => `${f.bodega}|${f.codigo_item}`)).size, 2300, "sin repetidas");
});

test("pide cada página con un orden explícito: sin eso la paginación repite y saltea", async () => {
  // Es la causa raíz. Un SELECT sin ORDER BY no garantiza orden en PostgreSQL, y
  // paginar por `range` sobre un orden que cambia entre páginas pierde filas.
  bd.filas = generar(1300, 1000);
  await leerBodegas(["00301", "00401"]);

  const paginas = bd.llamadas.filter((l) => !l.head);
  assert.ok(paginas.length >= 3, "tiene que haber paginado");
  for (const p of paginas) {
    assert.deepEqual(p.orden, ["bodega", "codigo_item"], "cada página se pide ordenada por la llave");
  }
});

test("un 502 de Cloudflare se reintenta en vez de tumbar el panel", async () => {
  // Reproducido contra producción el 26/10/2026: 1 de cada 16 lecturas falla así.
  bd.filas = generar(10, 10);
  let fallosEmitidos = 0;
  bd.alConsultar = ({ head }) => {
    if (head || fallosEmitidos >= 1) return null;
    fallosEmitidos += 1;
    return "<html><head><title>502 Bad Gateway</title></head></html>";
  };

  const filas = await leerBodegas(["00301", "00401"]);
  assert.equal(filas.length, 20, "se recuperó y trajo todo");
  assert.equal(fallosEmitidos, 1);
});

test("un error que NO es transitorio no se reintenta: falla de una", async () => {
  // Reintentar un permiso denegado solo retrasa el error y multiplica la carga.
  bd.filas = generar(10, 10);
  bd.alConsultar = ({ head }) => (head ? null : 'permission denied for table "traslados_snapshot"');

  await assert.rejects(() => leerBodegas(["00301", "00401"]), /permission denied/);
  const paginas = bd.llamadas.filter((l) => !l.head);
  assert.equal(paginas.length, 1, "un solo intento");
});

test("si faltan filas contra el total real, LANZA en vez de devolver una lista corta", async () => {
  // El corazón del reporte: devolver menos filas en silencio hace que un producto
  // con inventario aparezca en 0 y "sin rotación". Mejor un error en pantalla.
  bd.filas = generar(1300, 1000);
  bd.recortarPagina = (pagina, desde) => (desde === 1000 ? pagina.slice(0, 400) : pagina);

  // Las tres páginas se piden igual (el conteo dice de antemano cuántas son), así
  // que llegan 1000 + 400 + 300: faltan 600 de las 2300 y el mensaje lo dice.
  await assert.rejects(
    () => leerBodegas(["00301", "00401"]),
    /Lectura incompleta del snapshot: 1700 de 2300 filas/,
  );
});

test("las páginas se piden EN PARALELO, no una esperando a la anterior", async () => {
  // Son 23 páginas en producción. De a una tardaba 10,9 s; de a 6, 2,0 s. El
  // conteo de arriba es lo que lo habilita: dice cuántas son de antemano, así
  // que no hay que esperar a que una página avise si hay otra atrás.
  bd.filas = generar(5000, 5000); // 10 páginas
  bd.demoraDe = () => 20;

  const filas = await leerBodegas(["00301", "00401"]);

  assert.equal(filas.length, 10000);
  assert.ok(bd.maxEnVuelo > 1, `se pidieron de a una (máximo en vuelo: ${bd.maxEnVuelo})`);
  assert.ok(bd.maxEnVuelo <= 6, `demasiadas a la vez: ${bd.maxEnVuelo}`);
});

test("el resultado respeta el orden de las páginas aunque lleguen desordenadas", async () => {
  // Cada página se guarda EN SU POSICIÓN, no en orden de llegada. Si se
  // acumularan según van volviendo, el listado saldría barajado y la tabla
  // ordenaría sobre un orden que no es el que se pidió.
  bd.filas = generar(1300, 1000);
  bd.demoraDe = (desde) => (desde === 0 ? 60 : 5); // la primera, la más lenta

  const filas = await leerBodegas(["00301", "00401"]);

  const esperado = [...bd.filas].sort(
    (a, b) =>
      a.bodega.localeCompare(b.bodega) || String(a.codigo_item).localeCompare(String(b.codigo_item)),
  );
  assert.deepEqual(
    filas.map((f) => `${f.bodega}|${f.codigo_item}`),
    esperado.map((f) => `${f.bodega}|${f.codigo_item}`),
  );
});

test("filas de MÁS no son un error: el cron puede insertar mientras leemos", async () => {
  // El conteo se pide antes de paginar y el refresh corre cada 15 min. Que
  // aparezcan filas nuevas en el medio es normal; lo que no se tolera es que falten.
  bd.filas = generar(500, 500);
  bd.alConsultar = ({ head }) => {
    if (head) bd.filas.push({ bodega: "00401", codigo_item: "RECIEN", disponible: 1 });
    return null;
  };

  const filas = await leerBodegas(["00301", "00401"]);
  assert.equal(filas.length, 1001);
});
