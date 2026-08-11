-- ---------------------------------------------------------------------------
-- 000 — ¿Qué migraciones faltan correr?
-- ---------------------------------------------------------------------------
--
-- SOLO LEE. No modifica nada, se puede correr las veces que haga falta.
--
-- Este proyecto no lleva tabla de migraciones, así que el estado se deduce
-- mirando el esquema: si la columna que agrega una migración está, esa
-- migración ya corrió. Pegar en el SQL Editor de Supabase y ejecutar.
--
-- Las de BACKFILL (012 y 024) no se pueden deducir del esquema —no cambian la
-- estructura, solo rellenan datos— así que en vez de "corrió / no corrió"
-- informan cuántas filas quedarían por rellenar. Cero significa que no hay nada
-- pendiente, sea porque ya corrió o porque no había qué corregir.
-- ---------------------------------------------------------------------------

WITH col AS (
  SELECT table_name, column_name, is_nullable
    FROM information_schema.columns
   WHERE table_schema = 'public'
)
SELECT * FROM (
  -- 019 — quita la columna muerta `volumen` de los ítems
  SELECT
    '019_drop_volumen_items' AS migracion,
    CASE WHEN EXISTS (SELECT 1 FROM col WHERE table_name='traslados_items' AND column_name='volumen')
         THEN '❌ FALTA' ELSE '✅ ok' END AS estado,
    'traslados_items.volumen ya no debe existir' AS que_verifica,
    1 AS orden

  UNION ALL
  -- 021 — cédula opcional, correo obligatorio. La 025 DEPENDE de esta.
  SELECT
    '021_despachador_correo_obligatorio',
    CASE WHEN EXISTS (
      SELECT 1 FROM col
       WHERE table_name='traslados_despachadores' AND column_name='documento' AND is_nullable='NO'
    ) THEN '❌ FALTA' ELSE '✅ ok' END,
    'traslados_despachadores.documento debe aceptar NULL',
    2

  UNION ALL
  -- 023 — recolección multiusuario. LA MÁS URGENTE: el código ya escribe
  -- `recolectado_por` y sin la columna la recolección se rompe.
  SELECT
    '023_recoleccion_multiusuario',
    CASE WHEN NOT EXISTS (
      SELECT 1 FROM col WHERE table_name='traslados_items' AND column_name='recolectado_por'
    ) THEN '❌ FALTA — ROMPE LA RECOLECCIÓN' ELSE '✅ ok' END,
    'traslados_items.recolectado_por debe existir',
    3

  UNION ALL
  -- 025 — sede del despachador + las 7 cuentas de recibo
  SELECT
    '025_sede_despachador',
    CASE WHEN NOT EXISTS (
      SELECT 1 FROM col WHERE table_name='traslados_despachadores' AND column_name='sede'
    ) THEN '❌ FALTA' ELSE '✅ ok' END,
    'traslados_despachadores.sede debe existir',
    4

  UNION ALL
  -- 027 — placa a varchar(20). ROMPE "Camión cargado" con un 500 de Postgres
  -- ("value too long for type character varying(10)") en cuanto alguien escribe
  -- una placa a mano que pase de 10 caracteres.
  SELECT
    '027_placa_20',
    CASE WHEN EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND column_name='placa'
         AND table_name IN ('traslados_vehiculos','traslados_manifiestos')
         AND character_maximum_length < 20
    ) THEN '❌ FALTA — ROMPE CAMIÓN CARGADO' ELSE '✅ ok' END,
    'placa debe ser varchar(20) en vehículos y manifiestos',
    5

  UNION ALL
  -- 012 — recalcula `diferencia` en unidades base. La condición es la misma que
  -- usa la propia migración: no alcanza con buscar NULLs, porque el valor viejo
  -- podía estar escrito y mal (sin aplicar el factor de la UM).
  SELECT
    -- OJO: el archivo se llama `..._diferencia_und` pero la COLUMNA es
    -- `diferencia` a secas. El `_und` del nombre alude a que el valor queda en
    -- unidades base, no a que exista una columna con ese nombre.
    '012_backfill_diferencia_und',
    CASE WHEN (
      SELECT count(*) FROM traslados_items i
       WHERE i.cantidad_auditor IS NOT NULL
         AND i.diferencia IS DISTINCT FROM (
               i.cantidad_auditor
               - (COALESCE(i.cantidad_despachador, 0) * COALESCE(NULLIF(i.factor, 0), 1))
             )
    ) > 0 THEN '⚠️ ' || (
      SELECT count(*)::text FROM traslados_items i
       WHERE i.cantidad_auditor IS NOT NULL
         AND i.diferencia IS DISTINCT FROM (
               i.cantidad_auditor
               - (COALESCE(i.cantidad_despachador, 0) * COALESCE(NULLIF(i.factor, 0), 1))
             )
    ) || ' filas con la diferencia mal calculada' ELSE '✅ nada pendiente' END,
    'diferencia = cantidad_auditor − (despachador × factor)',
    6

  UNION ALL
  -- 024 — backfill del grupo de los ítems (ordena la lista del despachador)
  SELECT
    '024_backfill_grupo_items',
    CASE WHEN (SELECT count(*) FROM traslados_items WHERE grupo IS NULL) > 0
         THEN '⚠️ ' || (SELECT count(*)::text FROM traslados_items WHERE grupo IS NULL)
              || ' ítems sin grupo'
         ELSE '✅ nada pendiente' END,
    'ítems con grupo en NULL (salen al final de la lista)',
    7
) t
ORDER BY orden;

-- ---------------------------------------------------------------------------
-- Después de correr las que falten, verificar las cuentas de recibo:
--
--   SELECT nombre, correo, sede, activo
--     FROM traslados_despachadores
--    ORDER BY sede NULLS LAST, nombre;
--
-- Se esperan las 7 cuentas Recibo* con su sede, y los despachadores previos
-- con sede NULL (siguen viendo todas las bodegas, como hasta hoy).
-- ---------------------------------------------------------------------------
