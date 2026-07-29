-- =============================================================================
-- Migration 012: BACKFILL de `diferencia` a UND.
--
-- Contexto: `updateCantidadAuditor` y `marcarNoRecibido` calculaban `diferencia`
-- con `cantidad_despachador` EN CRUDO, sin multiplicar por `factor`. Como
-- `cantidad_auditor` SÍ se guarda en UND, la resta mezclaba unidades: un renglón
-- en P48 con cantidad_despachador=2 (96 UND reales) y auditor contando 96 quedaba
-- con diferencia 94 en vez de 0.
--
-- El código ya está corregido (helper `ItemModel.despachadoEnUnd`), pero los
-- despachos auditados ANTES del fix conservan el valor viejo, y `diferencia` se
-- consume en el Excel "Plano Final".
--
-- Unidades por columna (la invariante):
--   cantidad_admin, cantidad_despachador → UM del renglón
--   cantidad_auditor, diferencia         → UND
--
-- Ejecutar en el SQL Editor de Supabase. Es IDEMPOTENTE: solo toca filas cuyo
-- valor difiere del correcto, así que se puede correr de nuevo sin efecto.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- PASO 1 (opcional, recomendado): ver el impacto ANTES de escribir.
-- Corré SOLO este SELECT primero y revisá el resultado.
-- ─────────────────────────────────────────────────────────────────────────────
-- SELECT
--   i.id,
--   i.codigo_item,
--   i.descripcion,
--   i.unidad_medida,
--   i.factor,
--   i.cantidad_despachador                                         AS desp_en_um,
--   COALESCE(i.cantidad_despachador, 0)
--     * COALESCE(NULLIF(i.factor, 0), 1)                           AS desp_en_und,
--   i.cantidad_auditor,
--   i.diferencia                                                   AS diferencia_actual,
--   i.cantidad_auditor
--     - (COALESCE(i.cantidad_despachador, 0)
--        * COALESCE(NULLIF(i.factor, 0), 1))                       AS diferencia_correcta
-- FROM traslados_items i
-- WHERE i.cantidad_auditor IS NOT NULL
--   AND i.diferencia IS DISTINCT FROM (
--         i.cantidad_auditor
--         - (COALESCE(i.cantidad_despachador, 0)
--            * COALESCE(NULLIF(i.factor, 0), 1))
--       )
-- ORDER BY i.despacho_id, i.codigo_item;

-- ─────────────────────────────────────────────────────────────────────────────
-- PASO 2: el backfill.
--
-- Solo filas YA AUDITADAS (`cantidad_auditor IS NOT NULL`): si el auditor nunca
-- contó, `diferencia` debe seguir en NULL — "nunca se auditó" no es "diferencia 0".
--
-- `COALESCE(cantidad_despachador, 0)`: null es "nunca se registró" y equivale a
-- 0 despachado, igual que hace el código (`Number(null) || 0`).
--
-- `COALESCE(NULLIF(factor, 0), 1)`: mismo fallback que el helper del backend. La
-- columna es `numeric(12,4) default 1` pero es nullable, y un factor 0 anularía
-- la cantidad despachada.
--
-- Los ítems agregados por el auditor (`agregado_por_auditor = true`) NO necesitan
-- excepción: tienen cantidad_despachador = 0, así que la fórmula da
-- `cantidad_auditor - 0`, que es exactamente lo que corresponde.
-- ─────────────────────────────────────────────────────────────────────────────
UPDATE traslados_items i
SET diferencia = i.cantidad_auditor
      - (COALESCE(i.cantidad_despachador, 0) * COALESCE(NULLIF(i.factor, 0), 1))
WHERE i.cantidad_auditor IS NOT NULL
  AND i.diferencia IS DISTINCT FROM (
        i.cantidad_auditor
        - (COALESCE(i.cantidad_despachador, 0) * COALESCE(NULLIF(i.factor, 0), 1))
      );

-- ─────────────────────────────────────────────────────────────────────────────
-- PASO 3: verificación. Debe devolver 0 filas.
-- ─────────────────────────────────────────────────────────────────────────────
-- SELECT COUNT(*) AS filas_inconsistentes
-- FROM traslados_items i
-- WHERE i.cantidad_auditor IS NOT NULL
--   AND i.diferencia IS DISTINCT FROM (
--         i.cantidad_auditor
--         - (COALESCE(i.cantidad_despachador, 0) * COALESCE(NULLIF(i.factor, 0), 1))
--       );
