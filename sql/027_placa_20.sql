-- ---------------------------------------------------------------------------
-- 027 — La placa pasa de varchar(10) a varchar(20)
-- ---------------------------------------------------------------------------
--
-- QUÉ ROMPIÓ
-- "Camión cargado" devolvía 500 con este error de Postgres:
--
--   value too long for type character varying(10)
--
-- En `traslados_manifiestos` la ÚNICA columna varchar(10) es `placa`, así que el
-- texto que no entraba era ese. El camino que revienta es el del vehículo escrito
-- a mano (camión de refuerzo o alquilado, `vehiculo_id` en NULL): cuando el
-- vehículo sale del maestro la placa ya viene acotada, pero cuando la escribe el
-- despachador nadie la medía y llegaba entera hasta la base.
--
-- POR QUÉ 20 Y NO 10
-- 10 caracteres alcanzan justo para "GTX 302" (7) y nada más. Cualquier placa con
-- separador, sufijo de remolque o un dato pegado al lado se pasa. 20 deja aire sin
-- convertir la columna en un campo de texto libre: sigue siendo una placa.
--
-- Se amplían las DOS tablas a la vez. Si solo se ampliara el manifiesto, el
-- maestro seguiría rechazando placas que el manifiesto ya acepta, y el alta de un
-- vehículo fallaría con el mismo 500 en otra pantalla.
--
-- SEGURA Y REVERSIBLE HACIA ARRIBA: ampliar un varchar no reescribe la tabla ni
-- toca los datos existentes; los índices se reconstruyen solos. Correr en el SQL
-- Editor de Supabase.
-- ---------------------------------------------------------------------------

ALTER TABLE traslados_vehiculos
  ALTER COLUMN placa TYPE varchar(20);

ALTER TABLE traslados_manifiestos
  ALTER COLUMN placa TYPE varchar(20);

COMMENT ON COLUMN traslados_manifiestos.placa IS
  'Placa del vehículo, copiada del maestro o escrita a mano. Máximo 20: el mismo '
  'límite lo valida el backend (validators.js) para que un exceso salga como 422 '
  'y no como un 500 de Postgres.';

-- ---------------------------------------------------------------------------
-- Verificación:
--   SELECT table_name, character_maximum_length
--     FROM information_schema.columns
--    WHERE table_schema = 'public'
--      AND column_name = 'placa'
--      AND table_name IN ('traslados_vehiculos', 'traslados_manifiestos');
--
-- Se esperan las dos filas en 20.
-- ---------------------------------------------------------------------------
