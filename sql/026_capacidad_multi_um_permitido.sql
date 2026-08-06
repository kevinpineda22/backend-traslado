-- ---------------------------------------------------------------------------
-- 026 — "Este ítem SÍ se puede pedir en varias UM a la vez"
-- ---------------------------------------------------------------------------
--
-- QUÉ RESUELVE
-- Cuando un ítem está partido por unidad de medida, sus filas son LA MISMA
-- necesidad expresada distinto: 60 UND y 10 P6 son el mismo pedido, no dos.
-- Pedir las dos casi siempre es un error de armado, y el panel va a avisar.
--
-- Pero hay excepciones reales — huevos y frijol — donde pedir las dos
-- presentaciones a la vez es lo correcto. Esta columna las marca.
--
-- POR QUÉ ACÁ Y NO UNA LISTA EN EL CÓDIGO
-- Una lista de códigos en el repositorio obliga a un deploy cada vez que cambia
-- el surtido, y el que sabe cuáles son no es quien despliega. Acá lo marca la
-- misma persona que carga la capacidad, en la pantalla donde ya trabaja.
--
-- EL DATO ES DEL ÍTEM, NO DE LA FILA
-- La tabla tiene una fila por (codigo_item, unidad), pero "se puede pedir en
-- varias UM" es una propiedad del PRODUCTO. Se guarda en todas las filas del
-- ítem y se lee como: el ítem lo permite si CUALQUIERA de sus filas lo tiene en
-- true. Guardarlo solo en la fila base no servía — un ítem cargado directamente
-- con dos UM puede no tener fila base, y el dato se perdería.
--
-- Correr en el SQL Editor de Supabase.
-- ---------------------------------------------------------------------------

ALTER TABLE traslados_capacidad
  ADD COLUMN IF NOT EXISTS multi_um boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN traslados_capacidad.multi_um IS
  'true = este ítem se puede pedir en varias UM a la vez sin que el panel avise. '
  'Es propiedad del ÍTEM: se replica en todas sus filas y se lee con OR.';

-- El filtro típico es "¿este ítem lo permite?", sobre pocos ítems marcados.
CREATE INDEX IF NOT EXISTS idx_capacidad_multi_um
  ON traslados_capacidad (codigo_item) WHERE multi_um = true;

-- ---------------------------------------------------------------------------
-- Marcar huevos y frijol se hace desde la pantalla de Capacidad · Llano, con la
-- casilla nueva. No se siembran acá a propósito: haría falta adivinar sus
-- códigos, y un código equivocado deja el aviso activo justo donde se lo quería
-- callar — o peor, lo calla en un ítem donde sí hacía falta.
--
-- Verificación:
--   SELECT codigo_item, unidad, capacidad, multi_um
--     FROM traslados_capacidad
--    WHERE multi_um = true
--    ORDER BY codigo_item, unidad;
-- ---------------------------------------------------------------------------
