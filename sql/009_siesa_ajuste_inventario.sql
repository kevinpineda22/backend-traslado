-- =============================================================================
-- Migration 009: ajuste de inventario automático cuando SIESA rechaza por
-- "Item sin cantidad disponible".
-- Ejecutar en el SQL Editor de Supabase (una sola vez).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Al importar la requisición de traslado (clase 67, conector DEV_REQUISICIONES),
-- SIESA valida que la BODEGA DE SALIDA tenga existencias del ítem. Si no las
-- tiene, rechaza con un registro tipo 470: "Item sin cantidad disponible
-- Faltante Inv.: -N".
--
-- Decisión de negocio (ambiente de desarrollo): cuando eso pasa, insertamos las
-- unidades faltantes con un AJUSTE DE ENTRADA (clase 61 / concepto 601, conector
-- AJUSTE_DESARROLLO_REQUISICIONES, idDocumento 250295) y reintentamos el traslado.
--
-- Ese ajuste es OTRO POST que ESCRIBE EN EL ERP. Vale exactamente el mismo
-- cuidado que la requisición: si se dispara dos veces, inserta stock fantasma
-- POR DUPLICADO. Por eso lleva su propio estado terminal, igual que siesa_estado:
--
--   siesa_ajuste_estado:
--     'hecho'   → el ajuste ya se importó. NUNCA se repite: sería inventario
--                  inventado dos veces. Es la defensa de idempotencia del ajuste.
--     'fallido' → el ajuste se intentó y SIESA lo rechazó; necesita ojo humano.
--     NULL      → nunca hizo falta ajustar este despacho (el caso normal).
-- ---------------------------------------------------------------------------
ALTER TABLE traslados_despachos
  ADD COLUMN IF NOT EXISTS siesa_ajuste_estado   VARCHAR(12),
  ADD COLUMN IF NOT EXISTS siesa_ajuste_docto     TEXT,
  ADD COLUMN IF NOT EXISTS siesa_ajuste_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS siesa_ajuste_error     TEXT,
  ADD COLUMN IF NOT EXISTS siesa_ajuste_payload   JSONB;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_despachos_siesa_ajuste_estado'
  ) THEN
    ALTER TABLE traslados_despachos
      ADD CONSTRAINT chk_despachos_siesa_ajuste_estado
      CHECK (siesa_ajuste_estado IS NULL OR siesa_ajuste_estado IN ('hecho', 'fallido'));
  END IF;
END;
$$;
