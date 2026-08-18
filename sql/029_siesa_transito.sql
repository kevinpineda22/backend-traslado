-- =============================================================================
-- Migration 029: transferencia EN TRÁNSITO (conector 252844,
-- TRANSFERENCIA_TRANSITO_DEV_REQUISICIONES). Ejecutar en el SQL Editor de
-- Supabase (una sola vez).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- SIESA dejó de aceptar la transferencia DIRECTA (clase 67, un solo documento)
-- y ahora exige transferencia EN TRÁNSITO: DOS documentos encadenados que se
-- mandan back-to-back al cargar el camión (estado Recolectado):
--
--   1. SALIDA en tránsito  (clase 65, tipo CTS) → saca de la bodega origen.
--      SIESA le asigna un consecutivo (F_CONSEC_AUTO_REG = 1).
--   2. ENTRADA en tránsito (clase 66, tipo CTE) → mete en la bodega destino y
--      REFERENCIA a la salida por su consecutivo (CO_BASE + TIPO_DOCTO=CTS +
--      CONSECUTIVO = nro del docto de salida).
--
-- El riesgo nuevo: son DOS writes al ERP en una misma operación. Si la SALIDA
-- entra pero la ENTRADA falla (red / rechazo), la mercancía queda colgada en
-- tránsito. El reintento NO debe re-mandar la salida —eso duplicaría el
-- movimiento de tránsito—, tiene que mandar SOLO la entrada referenciando el
-- consecutivo que la salida ya generó.
--
-- Por eso persistimos el docto de la salida apenas SIESA la acepta. Su sola
-- presencia significa "la salida ya entró": el orquestador salta la salida y
-- reintenta únicamente la entrada. Es la misma idempotencia de siesa_docto /
-- siesa_ajuste_estado, aplicada al primer eslabón del par.
--
--   siesa_salida_docto:
--     TEXT   → consecutivo que SIESA asignó a la salida. NON-NULL ⇒ la salida
--               ya entró y jamás se reenvía. NULL ⇒ todavía no se mandó (o el
--               despacho es anterior a esta migración).
--
-- siesa_docto sigue guardando el docto de la ENTRADA (el que cierra el par).
-- ---------------------------------------------------------------------------
ALTER TABLE traslados_despachos
  ADD COLUMN IF NOT EXISTS siesa_salida_docto    TEXT,
  ADD COLUMN IF NOT EXISTS siesa_salida_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS siesa_salida_payload  JSONB;
