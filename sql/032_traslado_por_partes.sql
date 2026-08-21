-- ---------------------------------------------------------------------------
-- 032 — Traslado en PARTES (primera parte hoy, el resto mañana)
-- ---------------------------------------------------------------------------
--
-- QUÉ RESUELVE
-- Un Llano de 400 renglones no siempre se alcanza a sacar en un día. Hoy el
-- despachador tiene dos salidas y las dos son malas:
--
--   1. Finalizar igual — y entonces los 200 que no alcanzó a caminar quedan
--      auto-clasificados. La regla del flujo Llano dice: "hay stock en SIESA pero
--      no se recolectó ⇒ Inventario Fantasma". Esa regla asume que la persona
--      FUE al pasillo y no encontró el producto. Cuando lo que pasó es que no le
--      dio el tiempo, la conclusión es falsa: ensucia la analítica de
--      confiabilidad de inventario con algo que no es un problema de inventario,
--      y manda a alguien a investigar un fantasma que nunca existió.
--
--   2. No finalizar — y el camión no sale, con 200 renglones ya listos adentro.
--
-- Con esto el despachador manda lo que tiene listo y lo pendiente se va a un
-- traslado NUEVO, que queda en el pool para que cualquiera lo tome al otro día.
--
-- POR QUÉ NO UN MOTIVO "PENDIENTE"
-- La tentación es marcar los 200 con un motivo nuevo. Sería el mismo error que
-- ya cometimos con SIESA (ver sql/029): `motivo` responde "por qué faltó
-- mercancía" y la analítica lo usa para separar abastecimiento de confiabilidad
-- de inventario. "No me dio el tiempo" no es ninguna de las dos.
--
-- Los renglones pendientes NO SE MARCAN: SE MUEVEN. Y como la auto-clasificación
-- corre sobre lo que QUEDÓ, pasa a ver solo lo que la persona sí caminó — o sea
-- que se vuelve correcta sola, sin tocarla.
--
-- POR QUÉ SE MUEVEN Y NO SE COPIAN
-- Se reapunta `despacho_id` de la fila. Copiar obligaría a reconstruir la foto
-- del ítem (stock de origen y destino, consumo, sugerido, peso, criterios) que se
-- tomó cuando el admin armó el traslado, y cualquier campo que se olvide sale
-- como un dato plausible pero falso. Moviendo, la foto viaja intacta.
--
-- ESTAS COLUMNAS SON SOLO TRAZABILIDAD
-- Ninguna lógica depende de ellas: la parte 2 es un traslado normal y corriente.
-- Sirven para responder "¿de dónde salió este traslado?" cuando alguien lo mire
-- en el monitor y le extrañe que tenga 200 renglones de una ruta de 400.
-- ---------------------------------------------------------------------------

ALTER TABLE traslados_despachos
  ADD COLUMN IF NOT EXISTS parte_de  UUID REFERENCES traslados_despachos(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS parte_num INTEGER;

COMMENT ON COLUMN traslados_despachos.parte_de IS
  'Traslado del que salio esta parte. NULL = traslado normal. Solo trazabilidad.';
COMMENT ON COLUMN traslados_despachos.parte_num IS
  'Numero de parte: 2 = continuacion de otro. NULL = traslado normal.';

-- Para poder listar las partes de un traslado sin recorrer la tabla entera.
-- Parcial: las partes son la excepcion, no la regla.
CREATE INDEX IF NOT EXISTS idx_despachos_parte_de
  ON traslados_despachos (parte_de)
  WHERE parte_de IS NOT NULL;

-- Verificacion.
SELECT
  COUNT(*) FILTER (WHERE parte_de IS NOT NULL) AS traslados_que_son_parte,
  COUNT(*)                                     AS traslados_totales
FROM traslados_despachos;
