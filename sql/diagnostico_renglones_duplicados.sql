-- ---------------------------------------------------------------------------
-- DIAGNÓSTICO — renglones partidos en dos por el bug del match del recibidor
-- ---------------------------------------------------------------------------
--
-- SOLO LECTURA. No modifica nada. Se puede correr en producción sin riesgo.
--
-- QUÉ BUSCA
-- Un mismo `codigo_item` que aparece DOS veces en el mismo despacho: una como
-- renglón normal y otra marcada `agregado_por_auditor`. Eso es el síntoma del
-- bug: el lector daba un EAN, el panel no lo encontraba, SIESA resolvía el
-- código bueno y nadie volvía a buscarlo — así el ítem se agregaba como
-- "sobrante" aunque estuviera en la lista.
--
-- CÓMO LEER EL RESULTADO
--   contado_real   = lo que el recibidor contó de verdad (la suma de las dos)
--   sobrante_falso = la diferencia inflada que hay que descontar
--
-- OJO: no todo duplicado es este bug. Si de verdad llegó mercancía de más del
-- mismo producto, el renglón agregado es legítimo. Por eso esto NO corrige
-- nada — lista los casos para que alguien los mire uno por uno.
-- ---------------------------------------------------------------------------

SELECT
  d.id                                  AS despacho_id,
  d.origen,
  d.destino,
  d.estado,
  d.updated_at::date                    AS fecha,
  i.codigo_item,
  MAX(i.descripcion)                    AS descripcion,

  COUNT(*)                              AS renglones,
  COUNT(*) FILTER (WHERE i.agregado_por_auditor) AS agregados_por_recibidor,

  -- El renglón legítimo: lo que se pidió y lo que salió del camión.
  SUM(i.cantidad_admin)                 AS pedido,
  SUM(i.cantidad_despachador)           AS despachado,

  -- Lo que el recibidor contó, sumando las dos filas: el número real.
  SUM(i.cantidad_auditor)               AS contado_real,

  -- La diferencia que aporta SOLO la fila agregada: esto es lo que sobra de más.
  SUM(i.diferencia) FILTER (WHERE i.agregado_por_auditor) AS sobrante_falso

FROM traslados_items i
JOIN traslados_despachos d ON d.id = i.despacho_id
GROUP BY d.id, d.origen, d.destino, d.estado, d.updated_at::date, i.codigo_item
HAVING COUNT(*) > 1
   AND COUNT(*) FILTER (WHERE i.agregado_por_auditor) > 0
   AND COUNT(*) FILTER (WHERE NOT i.agregado_por_auditor) > 0
ORDER BY d.updated_at DESC, i.codigo_item;
