-- ---------------------------------------------------------------------------
-- 035 — Backfill correcto de siesa_entrada_externa
-- ---------------------------------------------------------------------------
--
-- QUE RESUELVE
-- El backfill de la 034 marco CERO filas. Su condicion era
-- `siesa_docto IS NOT DISTINCT FROM siesa_salida_docto`, asumiendo que el modo
-- SOLO SALIDA dejaba el mismo consecutivo en las dos columnas. No fue asi, y
-- como no se puede saber desde aca que guardo cada fila, la condicion no sirve.
--
-- LA CONDICION CORRECTA SALE DE UN HECHO VERIFICADO, NO DE UNA SUPOSICION
-- El 03/09/2026 se leyeron los documentos de transito de SIESA de los ultimos
-- 60 dias: 35 despachos, 35 entradas, apareo 1:1. Y las notas de TODAS esas
-- entradas dicen "Traslado salida ..." — es decir, se heredaron del documento
-- base. Este backend escribe "Traslado entrada" (ver notaDoc), asi que
-- NINGUNA de esas entradas salio de nuestro codigo: las creo una persona.
--
-- Entonces la regla es simple y demostrable: todo despacho que ya subio su
-- salida ANTES de que se prendiera la entrada automatica tiene, si esta
-- cerrado, una entrada que hizo otro.
--
-- COMO USARLA
-- Correr ANTES de poner SIESA_SOLO_SALIDA=0. Despues de ese momento las
-- entradas ya las crea el sistema y esta condicion dejaria de ser cierta.
-- Si se corre tarde, ajustar la fecha de corte a mano.
-- ---------------------------------------------------------------------------

UPDATE traslados_despachos
SET siesa_entrada_externa = TRUE
WHERE siesa_estado = 'enviado'
  AND siesa_salida_at IS NOT NULL
  AND siesa_entrada_externa = FALSE;

-- Verificacion: deberia dar ~35 en true (los del periodo solo-salida) y el
-- resto en false (despachos sin salida, o vacios sin items recolectados).
SELECT
  siesa_entrada_externa,
  COUNT(*) AS traslados,
  MIN(siesa_salida_at) AS primera_salida,
  MAX(siesa_salida_at) AS ultima_salida
FROM traslados_despachos
WHERE siesa_estado = 'enviado'
GROUP BY siesa_entrada_externa
ORDER BY siesa_entrada_externa;
