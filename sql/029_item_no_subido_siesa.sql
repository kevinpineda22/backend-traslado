-- ---------------------------------------------------------------------------
-- 029 — "Este renglón NO entró a SIESA"
-- ---------------------------------------------------------------------------
--
-- QUÉ RESUELVE
-- Cuando la importación a SIESA falla, el admin sube la requisición a mano. En
-- esa subida manual a veces quedan renglones por fuera, y hoy no hay dónde
-- anotarlo: el traslado entero queda `siesa_estado = 'fallido'` (migración 007),
-- pero eso no dice CUÁLES renglones faltaron. El que tiene que cuadrar contra el
-- ERP termina comparando a ojo contra el papel.
--
-- Esta marca es ese detalle, al lado del renglón.
--
-- POR QUÉ UNA COLUMNA NUEVA Y NO REUSAR `motivo`
-- `motivo` responde "por qué faltó mercancía": agotado, surtido parcial,
-- inventario fantasma. La analítica lo usa para separar un problema de
-- ABASTECIMIENTO de uno de CONFIABILIDAD DEL INVENTARIO, que se arreglan en
-- áreas distintas. Que un renglón no haya entrado al ERP no es ninguna de las
-- dos: es INTEGRACIÓN, y la mercancía sí salió. Meterlo en `motivo` haría que en
-- unos meses nadie pueda distinguir un desabastecimiento real de un error de
-- sistema.
--
-- POR QUÉ NO SE TOCAN LAS CANTIDADES
-- La tentación es poner `cantidad_despachador` en 0 para que el renglón "se vea"
-- distinto. Sería falso y además destructivo: el estado que se muestra se DERIVA
-- de esa cantidad, así que ponerla en 0 borra lo que el despachador realmente
-- recogió — justo la trazabilidad para la que sirve esta marca. Y arrastraría
-- dos cálculos más: el cumplimiento de la sede (que suma lo despachado) y el
-- faltante por motivo (que resta pedido menos despachado). Un renglón entregado
-- completo aparecería como incumplimiento de una sede que no hizo nada mal.
--
-- La marca es una ANOTACIÓN. No cambia ni una cantidad.
--
-- QUIÉN Y CUÁNDO
-- Se guardan porque el uso es cuadrar contra el ERP: ahí la constancia de quién
-- afirmó qué, y cuándo, es la mitad del valor.
-- ---------------------------------------------------------------------------

ALTER TABLE traslados_items
  ADD COLUMN IF NOT EXISTS siesa_omitido     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS siesa_omitido_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS siesa_omitido_por TEXT;

COMMENT ON COLUMN traslados_items.siesa_omitido IS
  'true = este renglon NO entro a SIESA (subida manual incompleta). Anotacion: no altera cantidades.';
COMMENT ON COLUMN traslados_items.siesa_omitido_at IS
  'Cuando se marco. Para cuadrar contra el ERP.';
COMMENT ON COLUMN traslados_items.siesa_omitido_por IS
  'Correo de quien lo marco. Para cuadrar contra el ERP.';

-- Solo se consultan los marcados, que son la excepcion: indice parcial.
CREATE INDEX IF NOT EXISTS idx_items_siesa_omitido
  ON traslados_items (despacho_id)
  WHERE siesa_omitido = true;

-- Verificacion.
SELECT
  COUNT(*) FILTER (WHERE siesa_omitido)          AS marcados,
  COUNT(*)                                        AS items_totales
FROM traslados_items;
