-- =============================================================================
-- Migration 011: "No recibido" — marca para ítems que el auditor reporta
-- como no recibidos físicamente (informativo, no toca SIESA).
-- Ejecutar en el SQL Editor de Supabase (una sola vez).
-- =============================================================================

ALTER TABLE traslados_items
  ADD COLUMN IF NOT EXISTS no_recibido BOOLEAN NOT NULL DEFAULT false;
