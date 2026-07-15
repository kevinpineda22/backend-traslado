-- =============================================================================
-- Migration 004: Motivos de faltante (despachador) + items agregados por auditor
-- Ejecutar en el SQL Editor de Supabase (una sola vez).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. motivo — por qué un ítem va con faltante (lo elige el despachador).
--    'sin_stock'          → no hay existencias en bodega.
--    'surtido_parcial'    → bodega quedó incompleta porque ya se surtió parte
--                            de la cantidad en el punto de venta.
--    'inventario_inflado' → el inventario del sistema está mal (dispara correo
--                            aparte a Inventarios).
--    NULL                 → sin faltante / no aplica.
-- ---------------------------------------------------------------------------
ALTER TABLE traslados_items
  ADD COLUMN IF NOT EXISTS motivo VARCHAR(30);

-- Restringe los valores permitidos (deja pasar NULL).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_items_motivo'
  ) THEN
    ALTER TABLE traslados_items
      ADD CONSTRAINT chk_items_motivo
      CHECK (motivo IS NULL OR motivo IN ('sin_stock', 'surtido_parcial', 'inventario_inflado'));
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. agregado_por_auditor — el ítem NO venía en la lista original del
--    despachador; el auditor lo recibió y lo escaneó en recepción.
-- ---------------------------------------------------------------------------
ALTER TABLE traslados_items
  ADD COLUMN IF NOT EXISTS agregado_por_auditor BOOLEAN NOT NULL DEFAULT false;

-- Índice para filtrar los agregados por auditor en reportes/planillas.
CREATE INDEX IF NOT EXISTS idx_items_agregado_auditor
  ON traslados_items(despacho_id) WHERE agregado_por_auditor = true;
