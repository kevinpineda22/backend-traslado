-- =============================================================================
-- Migration 010: trazabilidad de tiempos del proceso de traslado.
-- Ejecutar en el SQL Editor de Supabase (una sola vez).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- El admin necesita ver los RANGOS de cada actividad: cuándo empezó y terminó
-- la recolección, cuándo empezó y terminó la auditoría, y cuánto tardó cada una.
--
-- Marcas a nivel DESPACHO (no por ítem — decisión de negocio). Con estas + las
-- que ya existen (`created_at` = despacho creado, `siesa_enviado_at` = subido a
-- SIESA) se reconstruye la línea de tiempo completa y se calculan las duraciones
-- por resta. No guardamos duraciones: son derivadas, y guardarlas sería un dato
-- redundante que se puede desincronizar.
--
--   recoleccion_iniciada_at   → el despachador reclamó el despacho (→ En_recoleccion)
--   recoleccion_finalizada_at → cerró la recolección (→ Recolectado)
--   auditoria_iniciada_at     → el auditor hizo el primer "comparar" (empezó a contar)
--   auditoria_finalizada_at   → el auditor firmó (→ Auditado/Rechazado/Inconsistencia)
-- ---------------------------------------------------------------------------
ALTER TABLE traslados_despachos
  ADD COLUMN IF NOT EXISTS recoleccion_iniciada_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS recoleccion_finalizada_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS auditoria_iniciada_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS auditoria_finalizada_at    TIMESTAMPTZ;
