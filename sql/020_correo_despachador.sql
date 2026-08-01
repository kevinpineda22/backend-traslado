-- =============================================================================
-- Migration 020: correo del despachador — conecta el maestro de flota con la
-- asignación de despachos.
-- Ejecutar en el SQL Editor de Supabase (una sola vez), ANTES de desplegar.
-- Depende de la 016 (maestro de despachadores).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- EL PROBLEMA QUE RESUELVE
--
-- `traslados_despachos.despachador_id` guarda el CORREO del usuario logueado: es
-- con lo que el panel del despachador arma su lista y con lo que el backend valida
-- la propiedad del despacho (`assertPuedeRecolectar`, el ownerGuard de
-- `updateStatus`).
--
-- Pero el maestro de flota identifica por DOCUMENTO, porque el manifiesto necesita
-- cédula y teléfono — datos que la sesión no tiene. Son dos identidades distintas
-- de la misma persona, y hasta ahora no había forma de cruzarlas.
--
-- POR QUÉ IMPORTA (y no es teórico)
-- El selector "asignar despachador" del panel tenía una lista fija: d1 / d2.
-- Asignar cualquier valor que NO sea un correo deja el despacho INVISIBLE:
--
--   · no sale en el pool  → `sin_asignar` filtra por `despachador_id IS NULL`
--   · no sale para nadie  → ningún correo de sesión matchea "d1"
--
-- Y no falla con un error: el despacho simplemente no aparece en ninguna pantalla.
-- Hoy está latente porque nadie asignó nunca (verificado: todos los despachos
-- tienen `despachador_id` en null). La primera asignación lo habría perdido.
--
-- Con el correo acá, el selector lista gente real de flota y asigna el valor que
-- la sesión sí reconoce.
--
-- POR QUÉ NULLABLE
-- Los despachadores ya cargados (LUIS, DANILO) no tienen correo todavía. Se deja
-- `NULL` y el panel NO los ofrece para asignar hasta que se les cargue: es
-- preferible que no aparezcan como opción a que se pueda asignar un despacho que
-- después nadie ve.
--
-- El índice único es PARCIAL (solo activos y con correo): dos despachadores de
-- baja pueden compartir correo histórico, y varios sin correo no chocan entre sí.
-- ---------------------------------------------------------------------------
ALTER TABLE traslados_despachadores
  ADD COLUMN IF NOT EXISTS correo VARCHAR(160);

CREATE UNIQUE INDEX IF NOT EXISTS idx_despachadores_correo_activo
  ON traslados_despachadores (lower(correo))
  WHERE activo = true AND correo IS NOT NULL;

-- ---------------------------------------------------------------------------
-- CARGA DE LOS CORREOS EXISTENTES
--
-- Descomentá y completá con los correos reales con los que estas personas se
-- loguean. Tiene que ser EL MISMO correo de la sesión: si no coincide, el
-- despacho asignado no le va a aparecer.
-- ---------------------------------------------------------------------------
-- UPDATE traslados_despachadores SET correo = 'luis@merkahorrosas.com'   WHERE documento = '124556';
-- UPDATE traslados_despachadores SET correo = 'danilo@merkahorrosas.com' WHERE documento = '1234';

-- Para verificar quiénes quedan sin correo (no se pueden asignar todavía):
--   SELECT nombre, documento, correo FROM traslados_despachadores
--    WHERE activo = true ORDER BY correo NULLS FIRST;
