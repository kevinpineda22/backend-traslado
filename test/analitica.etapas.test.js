import { test, mock, before } from "node:test";
import assert from "node:assert/strict";

/* =============================================================================
   Dashboard — "Dónde se traba el flujo" y salud de SIESA.

   Hasta la migración 039 la tarjeta medía mal 3 de sus 4 etapas porque usaba
   RELOJES como si fueran HITOS:
     - "Esperando despachador" arrancaba en `disponible_at` (reloj de alertas,
       re-sellado al pasar a Recolectado) → siempre "sin datos".
     - "Recibiendo" arrancaba en `auditoria_iniciada_at` (primer Comparar, con el
       conteo ya hecho) → 18 min, y el conteo se sumaba a "Esperando camión".

   Estos tests fijan qué columna usa cada etapa con casos armados como los reales,
   para que nadie vuelva a enchufar un reloj sin que se rompa algo.
   ============================================================================= */

let calcularEtapas;
let contarSiesa;
let tiemposPorPersona;
let inicioDelDia;
let finDelDia;
let mapaNombres;

before(async () => {
  mock.module("../src/config/supabase.js", { exports: { supabase: {} } });
  mock.module("../src/models/Item.model.js", {
    exports: { despachadoEnUnd: () => 0, MOTIVOS_FALTANTE: [] },
  });
  ({ calcularEtapas, contarSiesa, tiemposPorPersona, inicioDelDia, finDelDia, mapaNombres } = await import(
    "../src/services/analitica.service.js"
  ));
});

const H = 36e5;
const t0 = Date.parse("2026-09-28T08:00:00Z");
const en = (horas) => new Date(t0 + horas * H).toISOString();

/**
 * Un traslado de punta a punta, con los relojes pisados como en producción:
 *   0 h   publicado
 *   1 h   el despachador lo toma
 *   3 h   termina de contar (Pendiente_carga)
 *   5 h   camión cargado → Recolectado (y `disponible_at` se re-sella ACÁ)
 *   6 h   primer escaneo de quien recibe (entra a En_recepcion)
 *   7.5 h primer Comparar (`auditoria_iniciada_at`)
 *   8 h   firma
 */
const trasladoReal = () => ({
  created_at: en(0),
  publicado_at: en(0),
  disponible_at: en(5), // reloj: re-sellado en Recolectado
  recoleccion_iniciada_at: en(1),
  recoleccion_finalizada_at: en(3),
  recepcion_iniciada_at: en(6),
  auditoria_iniciada_at: en(7.5),
  auditoria_finalizada_at: en(8),
});

const etapa = (etapas, clave) => etapas.find((e) => e.clave === clave);

test("'Esperando despachador' se mide desde la publicación, no desde el reloj de alertas", () => {
  const e = etapa(calcularEtapas([trasladoReal()]), "espera_despachador");
  // Con `disponible_at` daba 1 − 5 = negativo → descartado → n=0 siempre.
  assert.equal(e.n, 1);
  assert.equal(e.mediana, 1);
});

test("'Recibiendo' incluye el conteo: arranca en el primer escaneo, no en el primer Comparar", () => {
  const e = etapa(calcularEtapas([trasladoReal()]), "recibo");
  // Con `auditoria_iniciada_at` daba 0.5 h (solo Comparar → firma).
  assert.equal(e.mediana, 2);
});

test("'Cargue y viaje' termina en el primer escaneo y ya no se come el conteo", () => {
  const etapas = calcularEtapas([trasladoReal()]);
  const e = etapa(etapas, "cargue_viaje");
  // Con `auditoria_iniciada_at` daba 4.5 h (3 → 7.5): conteo incluido.
  assert.equal(e.mediana, 3);
  assert.equal(e.label, "Cargue y viaje");
});

test("las etapas encadenan sin huecos ni solapes: suman el ciclo completo", () => {
  const etapas = calcularEtapas([trasladoReal()]);
  const suma = ["espera_despachador", "recoleccion", "cargue_viaje", "recibo"]
    .map((c) => etapa(etapas, c).mediana)
    .reduce((a, b) => a + b, 0);
  assert.equal(suma, etapa(etapas, "total").mediana);
});

test("un traslado viejo sin hitos nuevos no entra a esas etapas (no se mezclan definiciones)", () => {
  const viejo = { ...trasladoReal(), publicado_at: null, recepcion_iniciada_at: null };
  const etapas = calcularEtapas([viejo]);
  assert.equal(etapa(etapas, "espera_despachador").n, 0);
  assert.equal(etapa(etapas, "cargue_viaje").n, 0);
  assert.equal(etapa(etapas, "recibo").n, 0);
  // Las que no dependen de los hitos nuevos siguen midiendo.
  assert.equal(etapa(etapas, "recoleccion").n, 1);
  assert.equal(etapa(etapas, "total").n, 1);
});

test("SIESA: los 'incierto' se cuentan (antes se descartaban en silencio)", () => {
  const siesa = contarSiesa([
    { siesa_estado: "enviado" },
    { siesa_estado: "incierto" },
    { siesa_estado: "incierto" },
    { siesa_estado: "fallido" },
    { siesa_estado: null }, // nunca se intentó subir: no es ninguno de los cuatro
  ]);
  assert.deepEqual(siesa, { pendiente: 0, enviado: 1, fallido: 1, incierto: 2 });
});

/* ── Filtro de fechas en hora de Colombia ───────────────────────────────────── */

test("el rango de fechas se lee en hora de Colombia, no en UTC", () => {
  // Bug real: "del 12 al 12" iba del 11 a las 7 p.m. al 12 a las 6:59 p.m.
  const desde = Date.parse(inicioDelDia("2026-10-12"));
  const hasta = Date.parse(finDelDia("2026-10-12"));
  // Un traslado creado el 12 a las 8 p.m. hora Colombia = 13 a la 01:00 UTC.
  const nocheDel12 = Date.parse("2026-10-13T01:00:00Z");
  // Y uno del 11 a las 8 p.m. hora Colombia = 12 a la 01:00 UTC.
  const nocheDel11 = Date.parse("2026-10-12T01:00:00Z");
  assert.ok(nocheDel12 >= desde && nocheDel12 <= hasta, "lo del 12 a la noche ES del 12");
  assert.ok(nocheDel11 < desde, "lo del 11 a la noche NO se cuela en el 12");
});

test("sin fecha no hay borde, y un valor que no es fecha pasa tal cual", () => {
  assert.equal(inicioDelDia(""), null);
  assert.equal(finDelDia(undefined), null);
  assert.equal(finDelDia("2026-10-12T10:00:00Z"), "2026-10-12T10:00:00Z");
});

/* ── Desglose por persona ───────────────────────────────────────────────────── */

const conGente = (over) => ({ ...trasladoReal(), despachador_id: "ana@x.com", auditor_id: "beto@x.com", ...over });

test("por persona: recolectar se le anota al despachador y recibir al que firmó", () => {
  const pp = tiemposPorPersona([conGente()]);
  assert.equal(pp.recoleccion.personas[0].usuario, "ana@x.com");
  assert.equal(pp.recoleccion.personas[0].mediana, 2); // 1 h → 3 h
  assert.equal(pp.recibo.personas[0].usuario, "beto@x.com");
  assert.equal(pp.recibo.personas[0].mediana, 2); // 6 h → 8 h
});

test("por persona mide lo MISMO que la barra de la etapa", () => {
  const ds = [conGente(), conGente({ despachador_id: "otra@x.com" })];
  const pp = tiemposPorPersona(ds);
  const etapa = calcularEtapas(ds).find((e) => e.clave === "recoleccion");
  const n = pp.recoleccion.personas.reduce((s, p) => s + p.n, 0);
  assert.equal(n, etapa.n, "ningún traslado se pierde ni se cuenta dos veces");
});

test("el promedio va junto a la mediana y se separa cuando hay un caso olvidado", () => {
  const largo = conGente({ recoleccion_finalizada_at: en(1 + 50) }); // 50 h
  const pp = tiemposPorPersona([conGente(), conGente(), largo]);
  const ana = pp.recoleccion.personas[0];
  assert.equal(ana.n, 3);
  assert.equal(ana.mediana, 2);
  assert.equal(ana.promedio, 18); // (2 + 2 + 50) / 3
});

test("el mismo correo con distinta mayúscula es UNA persona", () => {
  const pp = tiemposPorPersona([conGente(), conGente({ despachador_id: "ANA@x.com " })]);
  assert.equal(pp.recoleccion.personas.length, 1);
  assert.equal(pp.recoleccion.personas[0].n, 2);
});

test("sin quién registrado sale aparte (usuario null), no se esconde", () => {
  const pp = tiemposPorPersona([conGente(), conGente({ despachador_id: null })]);
  assert.ok(pp.recoleccion.personas.some((p) => p.usuario === null && p.n === 1));
});

test("usa el nombre del maestro cuando lo hay", () => {
  const pp = tiemposPorPersona([conGente()], new Map([["ana@x.com", "Ana Pérez"]]));
  assert.equal(pp.recoleccion.personas[0].nombre, "Ana Pérez");
  assert.equal(pp.recibo.personas[0].nombre, null);
});

test("un traslado sin el hito de inicio de recepción no entra al desglose de recibir", () => {
  const pp = tiemposPorPersona([conGente({ recepcion_iniciada_at: null })]);
  assert.equal(pp.recibo.personas.length, 0);
});

/* ── Nombres desde el maestro de despachadores ─────────────────────────────── */

test("mapaNombres: correo con un nombre → ese nombre (sin importar mayúsculas)", () => {
  const m = mapaNombres([{ correo: " Ana@X.com ", nombre: "Ana Pérez", activo: true }]);
  assert.equal(m.get("ana@x.com"), "Ana Pérez");
});

test("mapaNombres: una fila inactiva vieja no vuelve 'compartida' la cuenta", () => {
  const m = mapaNombres([
    { correo: "ana@x.com", nombre: "Ana P.", activo: false },
    { correo: "ana@x.com", nombre: "Ana Pérez", activo: true },
  ]);
  assert.equal(m.get("ana@x.com"), "Ana Pérez");
});

test("mapaNombres: dos personas ACTIVAS con el mismo correo = cuenta compartida → null", () => {
  const m = mapaNombres([
    { correo: "despachoplaza@x.com", nombre: "Danilo", activo: true },
    { correo: "despachoplaza@x.com", nombre: "Luis", activo: true },
  ]);
  assert.equal(m.get("despachoplaza@x.com"), null);
});

test("mapaNombres: filas sin correo se ignoran", () => {
  assert.equal(mapaNombres([{ correo: "", nombre: "X" }, { nombre: "Y" }]).size, 0);
});
