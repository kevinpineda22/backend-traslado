import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

/* =============================================================================
   Comparativo del recibo, por SEDE ORIGEN.

   El líder de cada bodega pidió ver el comparativo de los recibos que SALEN de
   su bodega, sin suscribirse a los de las demás sedes ni a las alertas técnicas
   de SIESA (que es lo que pasaría si se lo sumara a la lista de inventarios).

   Se prueba el parseo del mapa `TRASLADOS_MAIL_COMPARATIVO_POR_SEDE` y la
   resolución por sede. Lo que importa que NO se rompa:
     - inventarios sigue recibiendo todo, con o sin mapa configurado;
     - una sede sin nadie configurado no cambia de destinatarios;
     - un typo en la variable no tumba el arranque ni deja a inventarios afuera.

   El módulo lee el entorno UNA vez al importarse, así que cada caso reimporta
   con un query distinto para forzar una instancia nueva.
   ============================================================================= */

const ENV = "TRASLADOS_MAIL_COMPARATIVO_POR_SEDE";
const original = process.env[ENV];
let n = 0;

/** Importa email.service con el valor de entorno dado (instancia fresca). */
async function cargar(valor) {
  if (valor === undefined) delete process.env[ENV];
  else process.env[ENV] = valor;
  return import(`../src/services/email.service.js?caso=${++n}`);
}

beforeEach(() => {
  delete process.env[ENV];
});

afterEach(() => {
  if (original === undefined) delete process.env[ENV];
  else process.env[ENV] = original;
});

test("por defecto, Plaza (PV001) tiene al líder de bodega", async () => {
  const { destinatariosComparativoDeSede } = await cargar(undefined);
  assert.deepEqual(destinatariosComparativoDeSede("PV001"), [
    "Liderbodegaplaza@merkahorrosas.com",
  ]);
});

test("una sede sin configurar devuelve lista vacía", async () => {
  const { destinatariosComparativoDeSede } = await cargar(undefined);
  // Girardota Parque es origen del flujo Llano y no tiene líder cargado: su
  // comparativo tiene que seguir yendo solo a inventarios.
  assert.deepEqual(destinatariosComparativoDeSede("00301"), []);
});

test("varias sedes separadas por ; y varios correos por sede", async () => {
  const { destinatariosComparativoDeSede } = await cargar(
    "PV001:a@x.com,b@x.com;00601:c@x.com",
  );
  assert.deepEqual(destinatariosComparativoDeSede("PV001"), ["a@x.com", "b@x.com"]);
  assert.deepEqual(destinatariosComparativoDeSede("00601"), ["c@x.com"]);
});

test("la sede se compara sin espacios sobrantes", async () => {
  const { destinatariosComparativoDeSede } = await cargar(" PV001 : a@x.com ");
  assert.deepEqual(destinatariosComparativoDeSede("PV001"), ["a@x.com"]);
  // Y el código que llega del despacho también se normaliza.
  assert.deepEqual(destinatariosComparativoDeSede(" PV001 "), ["a@x.com"]);
});

test("una entrada mal escrita se ignora sin tumbar el resto", async () => {
  const { destinatariosComparativoDeSede } = await cargar(
    "basura-sin-dos-puntos;PV001:a@x.com;00601:",
  );
  assert.deepEqual(destinatariosComparativoDeSede("PV001"), ["a@x.com"]);
  assert.deepEqual(destinatariosComparativoDeSede("00601"), []);
});

test("la misma sede repetida acumula correos, no los pisa", async () => {
  const { destinatariosComparativoDeSede } = await cargar("PV001:a@x.com;PV001:b@x.com");
  assert.deepEqual(destinatariosComparativoDeSede("PV001"), ["a@x.com", "b@x.com"]);
});

test("unirDestinatarios deduplica sin distinguir mayúsculas", async () => {
  const { unirDestinatarios } = await cargar(undefined);
  // El caso real: el líder de la sede también está en la lista de inventarios.
  // Sin dedupe le llegaría el mismo correo dos veces.
  assert.deepEqual(
    unirDestinatarios(["Inventarios@merkahorrosas.com"], ["inventarios@MERKAHORROSAS.com"]),
    ["Inventarios@merkahorrosas.com"],
  );
  assert.deepEqual(unirDestinatarios(["a@x.com"], [], ["b@x.com"]), ["a@x.com", "b@x.com"]);
  assert.deepEqual(unirDestinatarios(["a@x.com"], [null, "", "  "]), ["a@x.com"]);
});
