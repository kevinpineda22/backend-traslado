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

before(async () => {
  mock.module("../src/config/supabase.js", { exports: { supabase: {} } });
  mock.module("../src/models/Item.model.js", {
    exports: { despachadoEnUnd: () => 0, MOTIVOS_FALTANTE: [] },
  });
  ({ calcularEtapas, contarSiesa } = await import("../src/services/analitica.service.js"));
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
