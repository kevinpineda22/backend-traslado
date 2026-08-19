-- =============================================================================
-- Migration 030: modo SOLO SALIDA + historial de intentos + prueba de la subida
-- Ejecutar en el SQL Editor de Supabase (una sola vez).
-- =============================================================================
--
-- CONTEXTO — por qué esta migración
-- ---------------------------------------------------------------------------
-- Se detectaron transferencias DUPLICADAS en SIESA (la misma salida clase 65
-- subida 3+ veces), moviendo inventario real de los supermercados. Causa raíz:
-- la salida SÍ entraba a SIESA, pero el código no lograba LEER el consecutivo
-- que SIESA le asignaba (doctoDe → ""). Con el consecutivo vacío:
--
--   1. `siesa_salida_docto` quedaba "" (falsy).
--   2. La entrada no se podía armar (necesita el consecutivo) → el despacho
--      quedaba 'pendiente'.
--   3. En el reintento, el guard `if (!salidaDocto)` creía que la salida nunca
--      entró → la RE-MANDABA. Otra salida. Otro movimiento de inventario.
--
-- El fix de idempotencia (requisicion.service) ancla el "ya se envió" en la HORA
-- de aceptación (`siesa_salida_at`), no en el consecutivo. Estas columnas
-- acompañan ese fix:
--
--   siesa_salida_respuesta:
--     JSONB → respuesta CRUDA de SIESA a la salida. Es la CONSTANCIA de que la
--             salida se subió (una sola vez) y de qué devolvió el ERP — incluido
--             el lugar donde viene el consecutivo, para poder recuperarlo a mano.
--
--   siesa_intentos_log:
--     JSONB → historial APPEND-ONLY, una entrada por intento. Antes `siesa_error`
--             guardaba SOLO el último intento y el anterior se perdía; para
--             certificar que a SIESA se sube una única vez hay que poder ver
--             CADA intento (qué pasó, cuándo, en qué fase, si hubo ajuste), no
--             solo el último. El backend lo topea a los últimos 50.
-- ---------------------------------------------------------------------------

ALTER TABLE traslados_despachos
  ADD COLUMN IF NOT EXISTS siesa_salida_respuesta JSONB,
  ADD COLUMN IF NOT EXISTS siesa_intentos_log     JSONB DEFAULT '[]'::jsonb;

-- Backfill: las filas viejas arrancan con historial vacío en vez de NULL, para
-- que el front pueda iterar sin chequear null.
UPDATE traslados_despachos
   SET siesa_intentos_log = '[]'::jsonb
 WHERE siesa_intentos_log IS NULL;
