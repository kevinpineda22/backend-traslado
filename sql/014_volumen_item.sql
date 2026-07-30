-- =============================================================================
-- Migration 014: volumen por ítem en el snapshot
-- Ejecutar en el SQL Editor de Supabase (una sola vez), ANTES de desplegar.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- La consulta de Connekta (`merkahorro_traslados_dev`) ahora trae
-- `dbo.t122_mc_items_unidades.f122_volumen AS Volumen`.
--
-- PARA QUÉ: al armar un despacho, sumar el volumen de todo lo seleccionado y
-- saber de antemano qué camión hace falta. Hoy eso se calcula a ojo.
--
-- POR QUÉ NULLABLE Y SIN DEFAULT 0
-- `NULL` = "SIESA no tiene el volumen de este ítem" y `0` = "ocupa cero", que no
-- es lo mismo. Con un default 0, un ítem sin dato entraría al total como si no
-- ocupara lugar y el camión se planificaría de menos. En NULL, el panel puede
-- avisar "hay N ítems sin volumen cargado" en vez de mentir con un total.
--
-- OJO CON LA UNIDAD DEL DATO: `f122_volumen` sale de la fila de
-- `t122_mc_items_unidades` correspondiente a la UNIDAD DE ORDEN del ítem
-- (el JOIN es por `v121a_id_unidad_orden`), la misma fila de la que sale
-- `f122_factor`. O sea: es el volumen de UN paquete de la unidad de orden, no
-- necesariamente el de UNA unidad base. Ver el comentario de `volumenTotal` en
-- el frontend antes de tocar el cálculo.
-- ---------------------------------------------------------------------------
ALTER TABLE traslados_snapshot
  ADD COLUMN IF NOT EXISTS volumen NUMERIC(14, 6);
