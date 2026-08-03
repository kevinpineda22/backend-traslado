-- =============================================================================
-- Migration 023: recolección multiusuario — el candado pasa del DESPACHO al RENGLÓN.
-- Ejecutar en el SQL Editor de Supabase (una sola vez), ANTES de desplegar.
-- Depende de la 004 (motivos) y la 020 (correo del despachador).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- EL PROBLEMA QUE RESUELVE
--
-- Un despacho grande no lo cuenta una persona sola. Hoy el primero que aprieta
-- "Iniciar recolección" queda como dueño en `traslados_despachos.despachador_id`,
-- y a cualquier otro el backend le devuelve 403: el segundo despachador no puede
-- ni escanear. La operación lo resuelve como puede — todos cuentan desde el mismo
-- usuario, y con eso se pierde quién contó qué.
--
-- POR QUÉ NO ALCANZA CON QUITAR EL CANDADO
-- El candado no está de adorno: sin él, dos personas que cuentan el MISMO producto
-- se pisan la cantidad y gana el último POST. En un traslado eso es inventario mal
-- declarado, que se arrastra hasta SIESA. El candado no sobra, está en el nivel
-- equivocado — es del renglón, no del despacho.
--
-- QUÉ CAMBIA
-- El despacho pasa a ser compartido: cualquiera puede entrar a recolectarlo. Cada
-- RENGLÓN, en cambio, queda de quien lo contó primero, y otro que intente
-- escribirlo recibe un 409 que dice de quién es. Dos personas pueden trabajar la
-- misma lista sin tocarse nunca.
--
-- POR QUÉ TEXT Y NO UNA FK
-- Guarda el CORREO de la sesión, igual que `traslados_despachos.despachador_id`
-- (ver migración 020): es el identificador que el front tiene a mano y contra el
-- que el backend compara. Una FK a `traslados_despachadores` obligaría a que todo
-- el que recolecta esté dado de alta en el maestro de flota, que hoy no se cumple
-- y no queremos que trabe una recolección en curso.
--
-- NULL = "todavía no lo contó nadie". El backend NO lo pisa cuando la escritura
-- viene del sistema y no de una persona (la auto-clasificación del flujo llano
-- escribe motivos sin dueño): un renglón auto-marcado no le pertenece a nadie.
-- ---------------------------------------------------------------------------
ALTER TABLE traslados_items
  ADD COLUMN IF NOT EXISTS recolectado_por TEXT;

COMMENT ON COLUMN traslados_items.recolectado_por IS
  'Correo de quien contó este renglón (candado por renglón, migración 023). NULL = sin contar, o contado por el sistema (auto-clasificación del flujo llano).';

-- Para pintar "lo tomó Fulano" en el panel y para el resumen por persona: siempre
-- se consulta acotado a un despacho.
CREATE INDEX IF NOT EXISTS idx_traslados_items_recolectado_por
  ON traslados_items (despacho_id, recolectado_por);

-- ---------------------------------------------------------------------------
-- HISTÓRICOS
--
-- Los renglones ya recolectados quedan con `recolectado_por` en NULL y así se
-- dejan, a propósito: hasta hoy solo podía contarlos el dueño del despacho, pero
-- ese dato es una DEDUCCIÓN, no un registro. Rellenarlo con
-- `traslados_despachos.despachador_id` escribiría como hecho algo que nadie
-- verificó — y justamente el motivo de esta migración es que en la práctica varias
-- personas contaban desde el mismo usuario.
--
-- Los despachos cerrados no se ven afectados: el candado solo aplica mientras el
-- despacho está `En_recoleccion`.
--
-- Para ver el reparto de un despacho en curso:
--   SELECT COALESCE(recolectado_por, '(sin contar)') AS quien, COUNT(*)
--     FROM traslados_items WHERE despacho_id = '<uuid>'
--    GROUP BY 1 ORDER BY 2 DESC;
-- ---------------------------------------------------------------------------
