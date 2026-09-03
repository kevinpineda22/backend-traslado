-- ---------------------------------------------------------------------------
-- 034 — La entrada en transito la creo OTRO (no este backend)
-- ---------------------------------------------------------------------------
--
-- QUE RESUELVE
-- Desde el 19/08/2026 el backend corre en modo SOLO SALIDA: sube la salida
-- (CTS/65) y no la entrada (CTE/66). Se asumia que el par quedaba abierto y que
-- la mercancia figuraba fuera de bodega en el ERP.
--
-- El 03/09/2026 se verifico contra SIESA y NO era asi: las 35 salidas del
-- periodo tenian su entrada, el mismo dia, apareo 1:1, cero huerfanas y cero
-- duplicadas. Las venia creando una persona a mano en el ERP.
--
-- La huella que lo delata: las notas de la CTE dicen "Traslado salida ...".
-- Este backend escribiria "Traslado entrada" (ver notaDoc). SIESA hereda las
-- notas del documento base al recibir el transito, asi que esas entradas NO
-- salieron de nuestro codigo.
--
-- POR QUE HACE FALTA UNA COLUMNA
-- Al prender la entrada automatica, `siesa_docto` deja de significar una sola
-- cosa. Puede ser:
--   - el consecutivo de una entrada que creo ESTE backend, o
--   - el de una entrada que ya existia y se ADOPTO sin crear nada.
-- Contablemente valen igual, pero para auditar el corte no son lo mismo: un
-- despacho con `siesa_entrada_externa = true` es uno que el sistema encontro
-- hecho. Sin esta columna, esa diferencia se pierde y nadie puede reconstruir
-- en que momento el sistema tomo el relevo.
--
-- EL RIESGO QUE ESTO ACOMPANA
-- Si el sistema crea la entrada mientras alguien la sigue creando a mano, el
-- destino recibe la mercancia DOS VECES. Es el espejo del incidente de la
-- salida duplicada (sql/030), del otro lado del transito. Por eso el codigo
-- consulta a SIESA antes de importar (SIESA_ENTRADA_VERIFICAR, prendido por
-- default) y FRENA si no puede verificar.
-- ---------------------------------------------------------------------------

ALTER TABLE traslados_despachos
  ADD COLUMN IF NOT EXISTS siesa_entrada_externa BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN traslados_despachos.siesa_entrada_externa IS
  'true = la entrada en transito ya existia en SIESA y se adopto (la creo una '
  'persona en el ERP u otro proceso). false = la creo este backend.';

-- Los despachos que quedaron en modo SOLO SALIDA tienen la entrada hecha a mano:
-- ninguno la creo este backend. Se marcan para que el corte quede documentado.
-- Se reconocen porque `siesa_docto` guarda el consecutivo de la SALIDA (era lo
-- que ese modo escribia) y coincide con `siesa_salida_docto`.
UPDATE traslados_despachos
SET siesa_entrada_externa = TRUE
WHERE siesa_estado = 'enviado'
  AND siesa_salida_at IS NOT NULL
  AND siesa_salida_docto IS NOT NULL
  AND siesa_docto IS NOT DISTINCT FROM siesa_salida_docto;

-- Poder listar rapido los que el sistema encontro hechos.
CREATE INDEX IF NOT EXISTS idx_despachos_siesa_entrada_externa
  ON traslados_despachos (siesa_entrada_externa)
  WHERE siesa_entrada_externa = TRUE;

-- Verificacion.
SELECT
  siesa_entrada_externa,
  COUNT(*) AS traslados
FROM traslados_despachos
WHERE siesa_estado = 'enviado'
GROUP BY siesa_entrada_externa
ORDER BY siesa_entrada_externa;
