-- =============================================================================
-- Migration 040: nuevo motivo de faltante "En custodia" + nota del motivo
-- Ejecutar en el SQL Editor de Supabase (una sola vez) ANTES de deployar el
-- backend y el front.
-- =============================================================================
--
-- "En custodia" es un motivo que SOLO existe para traslados que salen de
-- Principal Copacabana / Plaza (origen PV001). Es una ANOTACIÓN del faltante,
-- igual que surtido_parcial y corta_fecha_vencido: NO fuerza la cantidad a 0,
-- conserva lo que el despachador ya contó.
--
-- Al elegirlo, el despachador TIENE que escribir una nota (quién lo tiene, por
-- qué). Se guarda en `motivo_nota`. El CHECK de abajo impide un "en custodia"
-- sin nota aunque el front o el backend fallen.
--
-- La restricción por sede NO vive acá (el ítem no conoce el origen; está en el
-- despacho). La aplica el backend en `registrarLoteRecoleccion`.
--
-- Espejos que se sincronizan con este CHECK (si divergen, rompe):
--   · src/middleware/validators.js  → enum de Zod (rechaza el POST /recolectar)
--   · src/models/Item.model.js       → MOTIVOS_FALTANTE / MOTIVOS_CON_NOTA / MOTIVOS_SOLO_ORIGEN
--   · src/models/Novedad.model.js    → TIPO_PUBLICO (API de integraciones)
--   · src/services/notificacionesTraslado.service.js → MOTIVO_LABEL (correo compras)
--   · front src/pages/Traslados/utils/recoleccionDespacho.js → MOTIVO_LABEL/ORDEN
-- ---------------------------------------------------------------------------

ALTER TABLE traslados_items
  ADD COLUMN IF NOT EXISTS motivo_nota TEXT;

ALTER TABLE traslados_items
  DROP CONSTRAINT IF EXISTS chk_items_motivo;

ALTER TABLE traslados_items
  ADD CONSTRAINT chk_items_motivo
  CHECK (
    motivo IS NULL
    OR motivo IN ('sin_stock', 'surtido_parcial', 'inventario_inflado', 'corta_fecha_vencido', 'en_custodia')
  );

-- Un "en custodia" sin nota no se puede guardar.
ALTER TABLE traslados_items
  DROP CONSTRAINT IF EXISTS chk_items_motivo_nota;

ALTER TABLE traslados_items
  ADD CONSTRAINT chk_items_motivo_nota
  CHECK (
    motivo IS DISTINCT FROM 'en_custodia'
    OR length(btrim(coalesce(motivo_nota, ''))) > 0
  );
