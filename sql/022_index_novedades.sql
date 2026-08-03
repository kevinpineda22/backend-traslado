-- =============================================================================
-- Migration 022: Índice para la API de novedades (/api/integraciones/v1/novedades)
-- Ejecutar en el SQL Editor de Supabase (una sola vez).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- La API de integraciones filtra SIEMPRE por `motivo IS NOT NULL` (una novedad es,
-- por definición, un renglón con motivo) y ordena por `created_at DESC, id DESC`.
--
-- Sin este índice, cada consulta del área de Inventarios hace un seq scan sobre
-- toda `traslados_items` — que crece con cada despacho y nunca se purga — y ordena
-- en memoria. Hoy no se nota; con un año de traslados encima es un timeout de la
-- función serverless, y el consumidor lo va a leer como "la API de Traslados no
-- sirve".
--
-- Es un índice PARCIAL (`WHERE motivo IS NOT NULL`) porque la enorme mayoría de
-- los renglones NO tienen novedad: indexar solo los que sí deja un índice chico,
-- que entra en cache y se mantiene barato en cada INSERT de los otros.
--
-- Las columnas de orden van DENTRO del índice para que Postgres resuelva el
-- ORDER BY leyéndolo, sin paso de sort. El desempate por `id` no es decorativo:
-- es lo que hace estable la paginación cuando dos renglones comparten `created_at`.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_items_novedades
  ON traslados_items (created_at DESC, id DESC)
  WHERE motivo IS NOT NULL;

-- Filtro por tipo de novedad puntual (el caso más pedido:
-- `?tipo=INVENTARIO_FANTASMA`). Va aparte del anterior y no como una columna más
-- del mismo índice porque el filtro por tipo es OPCIONAL — un índice que arranca
-- con `motivo` no lo puede usar la consulta que no filtra por motivo.
CREATE INDEX IF NOT EXISTS idx_items_novedades_motivo
  ON traslados_items (motivo, created_at DESC)
  WHERE motivo IS NOT NULL;

-- Filtro por producto a lo largo del tiempo ("¿este código cuántas veces vino con
-- novedad?"). `idx_items_codigo` (migración 001) ya cubre el código solo, pero no
-- el orden por fecha, así que la consulta paginada seguía ordenando en memoria.
CREATE INDEX IF NOT EXISTS idx_items_novedades_codigo
  ON traslados_items (codigo_item, created_at DESC)
  WHERE motivo IS NOT NULL;
