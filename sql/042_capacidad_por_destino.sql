-- ---------------------------------------------------------------------------
-- 042 — Capacidad por DESTINO: cada flujo A/B/C tiene su propia góndola
-- ---------------------------------------------------------------------------
--
-- QUÉ RESUELVE
-- `traslados_capacidad` tenía clave primaria (codigo_item, unidad), sin sede. Eso
-- funcionaba mientras había UN solo flujo A/B/C (Llano). Con Machado (01201) el
-- mismo ítem tiene una capacidad distinta en cada tienda, y con esa clave la carga
-- de una sede PISABA la de la otra en silencio: subir el Excel de Machado
-- reescribía la capacidad de Llano, y el sugerido de Llano cambiaba sin que nadie
-- tocara nada.
--
-- QUÉ HACE
--   1. Agrega `destino` (bodega SIESA de la tienda dueña de la capacidad).
--   2. Las filas que ya existen quedan como Llano ('00401'): hasta hoy todas lo eran.
--   3. Cambia la clave primaria a (destino, codigo_item, unidad).
--
-- POR QUÉ DEFAULT '00401' Y NO SIN DEFAULT
-- Con el DEFAULT, un backend viejo que todavía no manda `destino` sigue insertando
-- como Llano y nada se rompe durante el despliegue. Es el mismo contrato que tiene
-- la API (si no llega `destino`, es Llano).
--
-- ORDEN DE DESPLIEGUE
-- Correr esta migración ANTES de desplegar el backend nuevo: el código nuevo hace
-- `upsert ... onConflict: "destino,codigo_item,unidad"` y sin esta clave Postgres
-- responde "no unique or exclusion constraint matching the ON CONFLICT
-- specification". El backend VIEJO sigue funcionando con la clave nueva solo para
-- lecturas; sus upserts (onConflict "codigo_item,unidad") fallarían, así que no hay
-- que dejar mucho tiempo entre la migración y el despliegue.
--
-- IDEMPOTENTE: se puede correr dos veces. El bloque de la clave primaria solo actúa
-- si la clave actual NO es ya la de tres columnas.
--
-- Correr en el SQL Editor de Supabase.
-- ---------------------------------------------------------------------------

ALTER TABLE traslados_capacidad
  ADD COLUMN IF NOT EXISTS destino text NOT NULL DEFAULT '00401';

COMMENT ON COLUMN traslados_capacidad.destino IS
  'Bodega SIESA de la tienda a la que pertenece esta capacidad (00401 = Girardota '
  'Llano, 01201 = Machado). Parte de la clave primaria: el mismo ítem tiene una '
  'capacidad por tienda. Las filas anteriores a la 042 quedaron en 00401.';

DO $$
DECLARE
  v_cols text;
BEGIN
  -- Columnas de la clave primaria actual, en orden.
  SELECT string_agg(a.attname, ',' ORDER BY k.ord)
    INTO v_cols
    FROM pg_index i
    JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
   WHERE i.indrelid = 'public.traslados_capacidad'::regclass
     AND i.indisprimary;

  IF v_cols IS DISTINCT FROM 'destino,codigo_item,unidad' THEN
    -- El nombre por defecto es traslados_capacidad_pkey (ver la 007).
    ALTER TABLE traslados_capacidad DROP CONSTRAINT IF EXISTS traslados_capacidad_pkey;
    ALTER TABLE traslados_capacidad ADD PRIMARY KEY (destino, codigo_item, unidad);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Verificación:
--
--   -- Debe devolver 'destino,codigo_item,unidad'
--   SELECT string_agg(a.attname, ',' ORDER BY k.ord)
--     FROM pg_index i
--     JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
--     JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
--    WHERE i.indrelid = 'public.traslados_capacidad'::regclass AND i.indisprimary;
--
--   -- Todas las filas previas deben estar en Llano:
--   SELECT destino, count(*) FROM traslados_capacidad GROUP BY destino;
-- ---------------------------------------------------------------------------
