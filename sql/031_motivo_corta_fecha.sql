-- =============================================================================
-- Migration 031: nuevo motivo de faltante "Corta fecha/Vencido"
-- Ejecutar en el SQL Editor de Supabase (una sola vez).
-- =============================================================================
--
-- Se agrega un motivo por el que un ítem NO se envía: el producto está en corta
-- fecha o vencido. Aplica al flujo General (traslados normales) y al Parque→Llano.
-- Valor interno `corta_fecha_vencido` (18 chars, entra en el VARCHAR(30) de la
-- columna). Es una ANOTACIÓN del faltante: NO fuerza la cantidad a 0 (se puede
-- enviar lo que sí está bueno y anotar el resto), igual que surtido_parcial.
--
-- Espejos que se sincronizan con este CHECK (si divergen, rompe):
--   · src/middleware/validators.js  → enum de Zod (rechaza el POST /recolectar)
--   · src/models/Item.model.js       → MOTIVOS_FALTANTE
--   · src/models/Novedad.model.js    → TIPO_PUBLICO (API de integraciones)
--   · src/services/notificacionesTraslado.service.js → MOTIVO_LABEL (correo compras)
--   · front src/pages/Traslados/utils/recoleccionDespacho.js → MOTIVO_LABEL/ORDEN
-- ---------------------------------------------------------------------------

-- Recrear el CHECK para admitir el valor nuevo. Se dropea el anterior (creado en
-- la migración 004) y se agrega con el set ampliado. DROP ... IF EXISTS lo hace
-- idempotente si se corre más de una vez.
ALTER TABLE traslados_items
  DROP CONSTRAINT IF EXISTS chk_items_motivo;

ALTER TABLE traslados_items
  ADD CONSTRAINT chk_items_motivo
  CHECK (
    motivo IS NULL
    OR motivo IN ('sin_stock', 'surtido_parcial', 'inventario_inflado', 'corta_fecha_vencido')
  );
