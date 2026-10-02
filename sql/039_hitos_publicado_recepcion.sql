-- =============================================================================
-- Migration 039: hitos de publicación y de inicio real de la recepción
-- Ejecutar en el SQL Editor de Supabase (una sola vez), ANTES de desplegar el
-- backend que escribe estas columnas.
-- =============================================================================
--
-- CONTEXTO — por qué esta migración
-- ---------------------------------------------------------------------------
-- La tarjeta "Dónde se traba el flujo" del Dashboard medía mal 3 de sus 4 etapas,
-- porque dos de las marcas que usaba no son HITOS sino RELOJES:
--
--   · "Esperando despachador" arrancaba en `disponible_at`. Pero `disponible_at`
--     es el reloj de las alertas de inactividad y se re-sella al pasar a
--     Recolectado, al abandonar la recolección y al reactivar. En todo traslado
--     terminado queda DESPUÉS de `recoleccion_iniciada_at`: la resta daba
--     negativa, se descartaba, y la etapa salía siempre "sin datos".
--
--   · "Recibiendo" arrancaba en `auditoria_iniciada_at`, que se sella en el
--     PRIMER Comparar. El recibidor cuenta todo en el navegador y no toca el
--     backend hasta comparar, así que el reloj arrancaba con el conteo YA hecho:
--     medía solo de Comparar a la firma (mediana 18 min). Y todo el conteo se
--     sumaba a la etapa anterior, "Esperando camión" (mediana 5.3 h).
--
-- `auditoria_abierta_at` tampoco servía para arreglarlo: se re-sella en cada
-- apertura porque mide FRESCURA (migración 015), no cuándo empezó.
--
-- Y la 036 (recepción por conteos) movió `auditoria_iniciada_at` al primer
-- escaneo. Eso arregla los traslados nuevos, pero los anteriores lo tienen en el
-- primer Comparar: la columna quedó con dos definiciones según la fecha, y no
-- sirve para una mediana. Las marcas de esta migración tienen una sola.
--
--   publicado_at:
--     Cuándo el traslado quedó a la vista del despachador (entra a "Creado" como
--     publicación: al crearse listo, al finalizar un borrador o al nacer como
--     parte 2 de un traslado dividido). Se re-sella si un listado se reabre y se
--     vuelve a enviar — mientras estuvo en Borrador nadie lo veía, así que la
--     espera real arranca en la ÚLTIMA publicación. NO lo toca abandonar la
--     recolección ni reactivar: eso no es publicar.
--
--   recepcion_iniciada_at:
--     Cuándo el traslado entró a En_recepcion: el PRIMER conteo guardado de quien
--     recibe (escaneo suelto o canastilla — los tres caminos de recepción pasan
--     por `senalarRecepcionActiva`). De En_recepcion no se vuelve, así que se
--     escribe una sola vez por construcción. No se usa "la primera apertura":
--     Recolectado significa que el camión SALIÓ, y abrir el traslado con el camión
--     en la ruta haría que "Recibiendo" se comiera el viaje.
--     Un panel viejo, que no guarda escaneos, pasa de Recolectado a la firma sin
--     entrar a En_recepcion: no recibe la marca y queda fuera de las medianas.
--
-- SIN BACKFILL, A PROPÓSITO
-- ---------------------------------------------------------------------------
-- Los traslados viejos no tienen estas horas y no hay de dónde sacarlas. Se podría
-- aproximar (`publicado_at = created_at`, `recepcion_iniciada_at =
-- auditoria_iniciada_at`), pero mezclar dos definiciones dentro de la misma mediana
-- da un número que PARECE completo y miente. Las etapas nuevas arrancan vacías y se
-- llenan con los traslados que se cierren desde el deploy; el Dashboard muestra el
-- `n` de cada etapa para que se vea cuán chica es la muestra.
-- ---------------------------------------------------------------------------

ALTER TABLE traslados_despachos
  ADD COLUMN IF NOT EXISTS publicado_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS recepcion_iniciada_at TIMESTAMPTZ;

COMMENT ON COLUMN traslados_despachos.publicado_at IS
  'Hito: última vez que el traslado quedó visible para el despachador (entró a Creado como publicación). No es reloj de alertas: ver disponible_at.';

COMMENT ON COLUMN traslados_despachos.recepcion_iniciada_at IS
  'Hito: entrada a En_recepcion = primer conteo guardado de quien recibe (escaneo o canastilla). Una vez por traslado. Arranque real de la recepción.';
