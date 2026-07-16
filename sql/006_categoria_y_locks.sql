-- =============================================================================
-- Migration 006: categoría del ítem + lock distribuido del snapshot
-- Ejecutar en el SQL Editor de Supabase (una sola vez).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. categoria — categoría comercial del ítem (ej: "ABARROTES", "FRUVER").
--    Sale del plan "TIP" (TIPO) del snapshot de SIESA: `criterios.TIP`.
--    Se copia al crear el despacho porque es un SNAPSHOT: si mañana SIESA
--    reclasifica el producto, el despacho ya cerrado debe seguir contando la
--    historia que vio el admin. Misma razón por la que ya se copian
--    `descripcion`, `rotacion` y `stock_origen`.
--
--    La usan el despachador y el auditor para recorrer la bodega ordenados por
--    categoría (alfabético) en vez de saltar de un pasillo a otro.
-- ---------------------------------------------------------------------------
ALTER TABLE traslados_items
  ADD COLUMN IF NOT EXISTS categoria TEXT;

-- Ordenar por (categoria, descripcion) es el acceso habitual del panel.
CREATE INDEX IF NOT EXISTS idx_items_categoria
  ON traslados_items(despacho_id, categoria, descripcion);

-- ---------------------------------------------------------------------------
-- 2. traslados_locks — exclusión mutua entre instancias serverless.
--
--    El refresh del snapshot se protegía con una variable en memoria del
--    proceso (`refreshEnCurso`). En Vercel eso NO sirve: cada invocación puede
--    correr en una instancia distinta, con su propia memoria, así que el cron y
--    el botón manual podían lanzar dos pulls pesados a la vez contra Connekta
--    — justo lo que dispara los deadlocks de SQL Server.
--
--    El lock vive en la BD, que es lo único compartido. La PK es el mecanismo
--    de exclusión: dos INSERT del mismo `nombre` no pueden ganar los dos.
--
--    `expira_at` es la red de seguridad: si una instancia muere a mitad del
--    refresh (timeout de Vercel, OOM), nadie libera el lock. Sin TTL el sistema
--    quedaría trabado para siempre. Un lock sin expiración es un deadlock con
--    pasos extra.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS traslados_locks (
  nombre     TEXT PRIMARY KEY,
  tomado_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expira_at  TIMESTAMPTZ NOT NULL,
  detalle    TEXT
);

-- Para el barrido de locks vencidos.
CREATE INDEX IF NOT EXISTS idx_locks_expira ON traslados_locks(expira_at);
