-- =============================================================================
-- Migration 021: el correo del despachador pasa a ser obligatorio; la cédula y
-- el teléfono dejan de serlo.
-- Ejecutar en el SQL Editor de Supabase (una sola vez). Depende de la 020.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- POR QUÉ SE INVIERTE QUÉ ES OBLIGATORIO
--
-- El maestro nació para llenar el manifiesto, donde la cédula y el teléfono son
-- datos del documento impreso. Pero ahora este maestro cumple una segunda función,
-- más crítica: es la lista con la que el admin ASIGNA un despacho.
--
-- Y para asignar, el único dato que el sistema necesita es el CORREO: es lo que
-- `traslados_despachos.despachador_id` guarda y lo que el panel del despachador
-- compara para encontrar sus despachos. Un despachador sin correo no se puede
-- asignar; uno sin cédula sí, y el manifiesto simplemente sale con ese campo en
-- blanco (`traslados_manifiestos.despachador_documento` ya es nullable).
--
-- O sea: sin cédula el documento queda incompleto, sin correo el despacho queda
-- INVISIBLE. Por eso el obligatorio cambia de lugar.
--
-- ⚠️ CONSECUENCIA ACEPTADA: el manifiesto puede imprimirse sin cédula ni teléfono
-- del despachador. Es una decisión de negocio — si el documento oficial los exige,
-- hay que cargarlos igual aunque el sistema no los pida.
--
-- Verificado antes de escribir esta migración: los despachadores activos ya tienen
-- correo cargado, así que el NOT NULL no rompe nada. Para confirmarlo de nuevo:
--
--   SELECT nombre, correo FROM traslados_despachadores
--    WHERE activo = true AND (correo IS NULL OR correo = '');
--   -- debe dar 0 filas
-- ---------------------------------------------------------------------------

-- 1. La cédula deja de ser obligatoria.
ALTER TABLE traslados_despachadores
  ALTER COLUMN documento DROP NOT NULL;

-- 2. Las cédulas vacías pasan a NULL.
--    El índice único de abajo trata cada NULL como distinto (así lo hace Postgres),
--    pero DOS cadenas vacías sí chocarían entre sí. Guardar '' en vez de NULL haría
--    que el segundo despachador sin cédula fallara con un error de duplicado que no
--    tiene nada que ver con lo que la persona hizo.
UPDATE traslados_despachadores SET documento = NULL WHERE documento = '';

-- 3. El índice de documento se recrea excluyendo los nulos, para dejar explícito
--    que varios despachadores pueden no tener cédula.
DROP INDEX IF EXISTS idx_despachadores_documento_activo;
CREATE UNIQUE INDEX IF NOT EXISTS idx_despachadores_documento_activo
  ON traslados_despachadores (documento)
  WHERE activo = true AND documento IS NOT NULL;

-- 4. El correo pasa a obligatorio.
ALTER TABLE traslados_despachadores
  ALTER COLUMN correo SET NOT NULL;
