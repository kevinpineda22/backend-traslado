import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

/* =============================================================================
   CERTIFICACIÓN: el mapa de costos no se arma con una lectura a medias.

   EL CASO QUE DA ORIGEN A ESTE ARCHIVO (2026-09-04) pasó en la consulta de
   tránsito, no acá — pero el patrón de código era el mismo, y por eso se auditó.
   Allá, con 113 filas en 2 páginas: la CTS 1757 y la CTE 1421 volvieron dos veces
   y las CTE 1412, 1413 y 1415 no volvieron nunca. La causa es que una consulta
   registrada sin ORDER BY … OFFSET 0 ROWS no tiene orden garantizado entre
   páginas, así que SQL Server puede mandar la misma fila dos veces y saltearse
   otra.

   Tránsito lo resolvió pidiendo UNA sola página. Acá no se puede: medido contra
   producción el 2026-09-04, son 79.982 filas en 80 páginas (Connekta topea tamPag
   en 1000), que se agregan a 21.942 ítems. Entonces se pagina, pero se MIDE.

   Esa misma medición dio 79.982 distintas de 79.982, cero repetidas: hoy la
   consulta ya viene ordenada. Estos tests no certifican un bug vivo, certifican
   que el día que deje de venirlo el sistema lo diga en vez de valuar mal.

   LO QUE HACE PELIGROSO EL AGUJERO ACÁ es qué cuelga del mapa: un ítem que no
   llega se valúa con SIESA_AJUSTE_COSTO_DEFAULT y entra al ERP dentro de un
   ajuste CONTABILIZADO, que es un documento que fabrica inventario. Y el mapa se
   cachea SEIS HORAS: un solo pull con agujeros envenena todos los ajustes de esa
   ventana sin levantar un solo error.

   Ojo con la aritmética, que es la parte contraintuitiva: las filas repetidas y
   las salteadas vienen JUNTAS y se compensan. Contar filas traídas contra el
   total declarado da exacto sobre un dataset agujereado. Hay que contar las
   DISTINTAS.
   ============================================================================= */

let mod;
/** Páginas que va a devolver Connekta, indexadas por (número de página menos 1). */
let paginas;
/** Lo que Connekta DECLARA que hay (total_registros). */
let totalDeclarado;
/** Páginas declaradas. Se separa de paginas.length para simular truncamiento. */
let totalPaginas;

/** Una fila de merkahorro_costo_promedio_dev: un ítem por instalación. */
const fila = (item, instalacion, costo) => ({
  IdItem: item,
  IdInstalacion: instalacion,
  CostoPromInst: costo,
});

before(async () => {
  mock.module("../src/config/connekta.js", {
    exports: {
      ejecutarConsulta: async (_descripcion, pagina) => ({
        datos: paginas[pagina - 1] || [],
        total: totalDeclarado,
        pagina,
        totalPaginas: totalPaginas ?? paginas.length,
      }),
    },
  });
  mod = await import("../src/services/siesaAjuste.service.js");
});

beforeEach(() => {
  process.env.SIESA_AJUSTE_CONSULTA_COSTO = "costo_test";
  delete process.env.SIESA_AJUSTE_COSTO_DEFAULT;
  delete process.env.SIESA_AJUSTE_COSTO_TOLERAR_PARCIAL;
  paginas = [];
  totalDeclarado = 0;
  totalPaginas = undefined;
  mod.invalidarCacheCostos();
});

test("pull completo: arma el mapa y cruza el ítem sacándole los ceros", async () => {
  // La consulta guarda el ítem sin ceros a la izquierda ("15312") y el faltante
  // que reporta SIESA viene con ellos ("0015312"). Se normalizan los dos lados.
  paginas = [
    [fila("15312", "001", 1200), fila("15312", "003", 1450)],
    [fila("16262", "001", 800)],
  ];
  totalDeclarado = 3;

  const datos = await mod.getDatosItems(["0015312", "0016262"]);
  assert.equal(datos["0015312"].costo, 1450, "entre instalaciones gana el costo MAYOR");
  assert.equal(datos["0016262"].costo, 800);
});

test("EL CASO REAL: la página 2 repite una fila y saltea otra, y no se arma el mapa", async () => {
  // Cuatro filas declaradas, dos páginas. La segunda devuelve otra vez la fila B
  // y nunca manda la cuarta. Es exactamente lo que pasó con la CTS 1757
  // (repetida) y las CTE 1412/1413/1415 (perdidas) en la consulta de tránsito.
  paginas = [
    [fila("A", "001", 10), fila("B", "001", 20)],
    [fila("B", "001", 20), fila("C", "001", 30)],
  ];
  totalDeclarado = 4;

  await assert.rejects(
    () => mod.getDatosItems(["A"]),
    /3 filas distintas de 4/,
    "tiene que decir cuántas faltan, no solo que algo falló",
  );
});

test("el conteo crudo NO alcanza: 4 filas traídas de 4 declaradas, y falta una", async () => {
  // La trampa aritmética, aislada. Si el guard mirara las filas traídas contra el
  // total, este pull pasaría limpio: trajo 4 de 4. Pero una de esas 4 es la misma
  // fila dos veces, así que hay un ítem que ninguna página mandó.
  paginas = [
    [fila("A", "001", 10), fila("B", "001", 20)],
    [fila("B", "001", 20), fila("C", "001", 30)],
  ];
  totalDeclarado = 4;

  await assert.rejects(() => mod.refrescarMapaCostos(), /4 traídas, 1 repetidas/);
});

test("con el mapa agujereado NO cae al costo por defecto: frena antes", async () => {
  // Esto es lo que se está protegiendo. Con SIESA_AJUSTE_COSTO_DEFAULT puesto, un
  // ítem ausente del mapa NO da error: se valúa con el costo de respaldo y el
  // ajuste entra igual al ERP, contabilizado. El guard tiene que morder antes de
  // llegar a ese else, o el respaldo se vuelve el camino silencioso.
  process.env.SIESA_AJUSTE_COSTO_DEFAULT = "999";
  paginas = [
    [fila("A", "001", 10), fila("B", "001", 20)],
    [fila("B", "001", 20), fila("C", "001", 30)],
  ];
  totalDeclarado = 4;

  await assert.rejects(() => mod.getDatosItems(["D"]), /Lectura incompleta del costo/);
});

test("el error de lectura incompleta no se disfraza de caída de Connekta", async () => {
  // getDatosItems envuelve los errores en "No se pudo consultar el costo (…)", que
  // manda a revisar la red o las credenciales. Acá Connekta respondió perfecto: el
  // problema es el orden de las páginas, y el mensaje tiene que llevar a la
  // consulta, no al cable.
  paginas = [[fila("A", "001", 10)], [fila("A", "001", 10)]];
  totalDeclarado = 2;

  await assert.rejects(
    () => mod.getDatosItems(["A"]),
    (e) => {
      assert.equal(e.name, "CostoIncompletoError");
      assert.match(e.message, /OFFSET 0 ROWS/);
      assert.doesNotMatch(e.message, /No se pudo consultar el costo/);
      return true;
    },
  );
});

test("más páginas que el tope: lanza en vez de truncar en silencio", async () => {
  // Antes había un Math.min(totalPaginas, COSTO_MAX_PAGINAS): si el universo
  // pasaba el tope, se armaba el mapa con lo que entrara y se cacheaba seis horas.
  // El síntoma no era un error sino un costo por defecto, que es justamente el que
  // no se ve.
  paginas = [[fila("A", "001", 10)]];
  totalDeclarado = 301000;
  totalPaginas = 301; // el default de COSTO_MAX_PAGINAS es 300

  await assert.rejects(() => mod.refrescarMapaCostos(), /declara 301 páginas/);
});

test("la válvula de escape deja pasar el pull parcial, y lo deja marcado", async () => {
  // Existe para no dejar el ajuste muerto si el guard resulta más estricto que la
  // consulta real (ver el test de abajo). Prenderla es aceptar que un ajuste se
  // valúe con el costo por defecto, y por eso el resultado queda con parcial=true.
  process.env.SIESA_AJUSTE_COSTO_TOLERAR_PARCIAL = "1";
  paginas = [[fila("A", "001", 10), fila("A", "001", 10)]];
  totalDeclarado = 3;

  const cache = await mod.refrescarMapaCostos();
  assert.equal(cache.parcial, true);
  assert.equal(cache.unicas, 1);
  assert.equal(cache.mapa.get("A"), 10, "lo que sí llegó sigue sirviendo");
});

test("EL FALSO POSITIVO CONOCIDO: filas idénticas de verdad también disparan el guard", async () => {
  // Dicho explícitamente para que nadie lo descubra en producción. La huella de
  // una fila son todas sus columnas: si la consulta devolviera dos filas IDÉNTICAS
  // de forma legítima, se cuentan como una sola y el guard grita sobre un pull
  // sano.
  //
  // Se aceptó ese riesgo a sabiendas. La fila de esta consulta es (ítem,
  // instalación, costo) y no debería repetirse; y si se repitiera, el costo de
  // equivocarse es asimétrico: un falso positivo deja el despacho pendiente y se
  // destraba en un minuto, un falso negativo escribe un documento contabilizado
  // mal valuado en el ERP.
  //
  // La salida no es aflojar el guard: es SIESA_AJUSTE_COSTO_TOLERAR_PARCIAL
  // mientras se le agrega el ORDER BY a la consulta.
  paginas = [[fila("A", "001", 10), fila("A", "001", 10)]];
  totalDeclarado = 2;

  await assert.rejects(() => mod.refrescarMapaCostos(), /1 filas distintas de 2/);
});

test("el probe muestra los números antes de que el guard muerda", async () => {
  // GET /siesa/ajuste/estado?probe=ITEM es read-only y no lanza: devuelve ok:false
  // con el mensaje. Es el lugar donde se mira la salud de la paginación sin tener
  // que esperar a que un despacho se trabe.
  paginas = [[fila("15312", "001", 1200)]];
  totalDeclarado = 1;

  const ok = await mod.probarConsultaCosto("0015312");
  assert.equal(ok.ok, true);
  assert.equal(ok.filasDistintas, 1);
  assert.equal(ok.filasRepetidas, 0);
  assert.equal(ok.lecturaParcial, false);
  assert.equal(ok.encontrado.costo, 1200);
});
