-- =============================================================================
-- Migration 007: estado del envío de la requisición a SIESA
-- Ejecutar en el SQL Editor de Supabase (una sola vez).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Al cerrar la recolección se importa una requisición a SIESA
-- (/conectoresimportar, DEV_REQUISICIONES). Ese POST escribe en el ERP y puede
-- fallar (SIESA tira 500 y deadlocks, ya lo vimos con el snapshot).
--
-- Decisión de negocio: el despacho se cierra IGUAL. La mercancía ya salió
-- físicamente del camión cuando el despachador firma — el despacho es un hecho
-- consumado, no una intención. Trabar la bodega porque el ERP no contesta sería
-- negar algo que ya pasó. Así que el envío se registra acá y se reintenta.
--
--   siesa_estado:
--     'pendiente' → hay que enviarla (o reintentarla)
--     'enviado'   → SIESA la aceptó. NUNCA se reenvía: sería una requisición
--                    duplicada = movimientos de inventario que no existieron.
--     'fallido'   → se agotaron los reintentos; necesita ojo humano.
--     NULL        → despacho viejo, anterior a esta integración.
-- ---------------------------------------------------------------------------
ALTER TABLE traslados_despachos
  ADD COLUMN IF NOT EXISTS siesa_estado      VARCHAR(12),
  ADD COLUMN IF NOT EXISTS siesa_intentos    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS siesa_error       TEXT,
  ADD COLUMN IF NOT EXISTS siesa_docto       TEXT,
  ADD COLUMN IF NOT EXISTS siesa_enviado_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS siesa_payload     JSONB;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_despachos_siesa_estado'
  ) THEN
    ALTER TABLE traslados_despachos
      ADD CONSTRAINT chk_despachos_siesa_estado
      CHECK (siesa_estado IS NULL OR siesa_estado IN ('pendiente', 'enviado', 'fallido'));
  END IF;
END;
$$;

-- El cron de reintentos busca exactamente esto: los que quedaron pendientes.
-- Índice parcial — 'enviado' es la mayoría y no nos interesa recorrerla.
CREATE INDEX IF NOT EXISTS idx_despachos_siesa_pendientes
  ON traslados_despachos(siesa_estado, siesa_intentos)
  WHERE siesa_estado IN ('pendiente', 'fallido');
