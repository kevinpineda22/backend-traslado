-- =============================================================================
-- Migration 015: señal de "el auditor está trabajando en esto"
-- Ejecutar en el SQL Editor de Supabase (una sola vez), ANTES de desplegar.
-- Depende de la 013 (alertas).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- EL PROBLEMA QUE RESUELVE
--
-- El auditor cuenta TODO en el navegador: `useAuditoriaOffline` guarda cada
-- unidad en localStorage y no manda nada al backend hasta que aprieta "Comparar".
-- Y `auditoria_iniciada_at` (migración 010) se sella recién en ese Comparar.
--
-- O sea: el auditor puede escanear 300 ítems durante una hora y media y, para el
-- backend, ese traslado sigue sin que nadie lo haya tocado. El barrido de alertas
-- lo veía "abandonado" y la regla de inactivación lo congelaba a mitad de conteo;
-- al firmar, el auditor se comía un 409 y quedaba trabado.
--
-- POR QUÉ UNA COLUMNA NUEVA Y NO REUSAR `auditoria_iniciada_at`
-- Son dos cosas distintas y mezclarlas rompe las dos:
--   · `auditoria_iniciada_at` es un HITO de negocio — cuándo empezó a contarse de
--     verdad. Alimenta métricas y no se toca nunca más una vez sellado.
--   · `auditoria_abierta_at` es una SEÑAL DE ACTIVIDAD — "alguien está en esto
--     ahora". Se re-sella en CADA apertura, a propósito.
-- Sellar el hito al abrir ensuciaría la métrica (el trabajo empezaría a contar
-- cuando alguien mira de reojo) y dejaría el hito sin poder distinguir mirar de contar.
--
-- POR QUÉ FRESCURA Y NO UN "YA SE ABRIÓ" DEFINITIVO
-- Si "abierto" fuera para siempre, un auditor que abre el traslado y se va lo
-- dejaría marcado como atendido de por vida: no saldría el aviso NI se inactivaría
-- nunca. Quedaría invisible para las tres reglas — justo el caso que las alertas
-- existen para cazar. Midiendo cuán RECIENTE fue la última apertura, se protege a
-- quien está contando ahora y se sigue cazando a quien abandonó.
-- Es el mismo criterio de ventana de gracia que ya usa el prune del snapshot.
--
-- Sin backfill: NULL = "ningún auditor lo abrió todavía", que es la verdad para
-- todo lo que ya existe.
-- ---------------------------------------------------------------------------
ALTER TABLE traslados_despachos
  ADD COLUMN IF NOT EXISTS auditoria_abierta_at TIMESTAMPTZ;

-- El barrido filtra por esta columna junto con estado e inactivo.
CREATE INDEX IF NOT EXISTS idx_despachos_auditoria_abierta
  ON traslados_despachos (auditoria_abierta_at);
