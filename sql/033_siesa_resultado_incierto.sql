-- ---------------------------------------------------------------------------
-- 033 — Estado "incierto": el envío a SIESA no respondió
-- ---------------------------------------------------------------------------
--
-- QUÉ RESUELVE
-- Un traslado se subió DOS VECES a SIESA. La secuencia fue:
--
--   Intento 1 → POST a SIESA → timeout a los 60 s → quedó 'pendiente'
--   Intento 2 → el cron lo reintentó → SIESA aceptó → 'enviado'
--
-- El problema es que un timeout NO significa que falló: significa que NO SABEMOS
-- si llegó. SIESA pudo haber procesado la salida y haberse cortado solo la
-- respuesta de vuelta. Ahí el reintento la manda por segunda vez, y queda un
-- movimiento de inventario que nunca ocurrió.
--
-- POR QUÉ LAS DEFENSAS QUE YA HABÍA NO ALCANZAN
-- Las tres son correctas y cada una cubre un caso real:
--   1. 'enviado' es terminal      → no reenvía algo YA CONFIRMADO.
--   2. Lock por despacho          → no manda dos veces A LA VEZ.
--   3. Transición condicional     → resuelve la CARRERA en la base.
-- Pero las tres asumen que se conoce el resultado del envío anterior. Un timeout
-- es justamente el caso donde no se conoce.
--
-- QUÉ HACE ESTE ESTADO
-- Separa "falló" de "no sé". El cron solo reintenta 'pendiente', así que un
-- 'incierto' NO se reintenta solo: espera a que una persona mire en SIESA y
-- decida. Si la salida está, se marca enviada; si no está, se reintenta.
--
-- Es la política que el propio código ya declaraba y no implementaba:
-- "Preferimos parar y avisar antes que insistir a ciegas" (requisicion.service).
--
-- EL COSTO, DICHO EXPLÍCITAMENTE
-- Un traslado que de verdad se cayó por red ahora necesita que alguien lo
-- destrabe. Se elige a propósito: un traslado trabado se resuelve en la app en
-- un minuto, y un duplicado en el ERP hay que ir a pedirle a SIESA que lo borre.
-- ---------------------------------------------------------------------------

ALTER TABLE traslados_despachos
  DROP CONSTRAINT IF EXISTS chk_despachos_siesa_estado;

ALTER TABLE traslados_despachos
  ADD CONSTRAINT chk_despachos_siesa_estado
  CHECK (
    siesa_estado IS NULL
    OR siesa_estado IN ('pendiente', 'enviado', 'fallido', 'incierto')
  );

COMMENT ON COLUMN traslados_despachos.siesa_estado IS
  'pendiente = por enviar o reintentable · enviado = confirmado por SIESA · '
  'fallido = SIESA rechazo o se agotaron los intentos · '
  'incierto = no hubo respuesta (timeout): NO se reintenta solo, hay que verificar en SIESA.';

-- El indice de pendientes NO incluye 'incierto' a proposito: es lo que impide
-- que el cron lo levante. Se agrega uno propio para poder listarlos y avisar.
CREATE INDEX IF NOT EXISTS idx_despachos_siesa_incierto
  ON traslados_despachos (siesa_estado)
  WHERE siesa_estado = 'incierto';

-- Verificacion.
SELECT
  siesa_estado,
  COUNT(*) AS traslados
FROM traslados_despachos
WHERE siesa_estado IS NOT NULL
GROUP BY siesa_estado
ORDER BY siesa_estado;
