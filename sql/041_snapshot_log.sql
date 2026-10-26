-- ---------------------------------------------------------------------------
-- 041 — Bitácora de los refrescos del snapshot
-- ---------------------------------------------------------------------------
--
-- QUÉ RESUELVE
-- El 26/10/2026 el equipo reportó productos que mostraban inventario y consumo
-- en 0 —el café NESCAFE, el azúcar MANUELITA, el frutiño de mora— cuando el
-- snapshot sí tenía sus datos. Para cuando se investigó, el cron ya había
-- corrido de nuevo y los números estaban bien.
--
-- No hubo forma de saber qué pasó. `traslados_snapshot` guarda el estado ACTUAL
-- y cada refresco pisa al anterior: no queda rastro de cuántas filas trajo, de
-- cuántas tenía cada bodega, ni de si el prune borró algo. Cada reporte de este
-- tipo es una investigación a ciegas, y la respuesta honesta es "no sé".
--
-- Esta tabla guarda una línea por refresco. No cambia el comportamiento de
-- nada: solo deja el rastro que hoy no existe.
--
-- POR QUÉ `por_bodega` ES LO IMPORTANTE
-- El total general puede verse sano mientras una bodega se vacía. La pregunta
-- que no se pudo contestar fue "¿cuántos ítems tenía Llano a las 12:17?", y esa
-- vive acá. Va en jsonb porque las sedes cambian (ver `bodegasInvolucradas` en
-- src/config/flujos.js) y no queremos una migración por cada sede nueva.
--
-- POR QUÉ SE REGISTRAN TAMBIÉN LOS FALLOS
-- Un refresco que aborta por las guardas de completitud es justamente el evento
-- interesante: significa que Connekta devolvió un pull parcial. Hoy eso se
-- pierde en los logs de GitHub Actions, que caducan.
--
-- VOLUMEN
-- El cron corre cada 15 minutos: 96 filas por día, ~35 mil al año. Si alguna vez
-- molesta, borrar lo viejo es seguro — nada lee esta tabla salvo una persona
-- investigando:
--   DELETE FROM traslados_snapshot_log WHERE creado_at < now() - interval '90 days';
--
-- Correr en el SQL Editor de Supabase.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS traslados_snapshot_log (
  id               bigserial PRIMARY KEY,
  creado_at        timestamptz NOT NULL DEFAULT now(),
  -- 'ok' | 'abortado' (lo frenó una guarda) | 'error' (se rompió algo)
  resultado        text NOT NULL,
  duracion_ms      integer,
  -- Lo que vino de Connekta, antes de agregar por (bodega, ítem).
  filas_crudas     integer,
  filas_declaradas integer,
  -- Ítems ya agregados, que es lo que termina en la tabla.
  items            integer,
  -- {"00401": 9396, "00301": 13201, ...} — el conteo por sede.
  por_bodega       jsonb,
  -- Cuántas filas se llevó el prune. Lo normal es 0.
  borradas         integer,
  -- Motivo del abort o mensaje del error. NULL cuando salió bien.
  detalle          text
);

COMMENT ON TABLE traslados_snapshot_log IS
  'Una fila por refresco del snapshot. Solo para investigar reportes de datos '
  'incompletos: nada del flujo la lee.';

COMMENT ON COLUMN traslados_snapshot_log.por_bodega IS
  'Ítems por bodega en ESTE refresco. Responde "cuántos tenía Llano a tal hora", '
  'que es la pregunta que no se pudo contestar el 26/10/2026.';

-- Siempre se consulta lo más reciente hacia atrás.
CREATE INDEX IF NOT EXISTS idx_snapshot_log_creado
  ON traslados_snapshot_log (creado_at DESC);

-- ---------------------------------------------------------------------------
-- CÓMO SE USA CUANDO ALGUIEN REPORTA "ME SALIÓ TODO EN CERO"
--
--   -- ¿Qué pasó alrededor de esa hora?
--   SELECT creado_at, resultado, items, por_bodega, borradas, duracion_ms, detalle
--     FROM traslados_snapshot_log
--    WHERE creado_at BETWEEN '2026-10-26 11:30-05' AND '2026-10-26 12:30-05'
--    ORDER BY creado_at;
--
--   -- ¿Alguna sede se desplomó respecto del refresco anterior?
--   SELECT creado_at,
--          (por_bodega->>'00401')::int AS llano,
--          (por_bodega->>'00401')::int
--            - lag((por_bodega->>'00401')::int) OVER (ORDER BY creado_at) AS cambio
--     FROM traslados_snapshot_log
--    WHERE resultado = 'ok'
--    ORDER BY creado_at DESC
--    LIMIT 50;
--
--   -- ¿Con qué frecuencia abortan las guardas?
--   SELECT resultado, count(*), max(creado_at) AS ultimo
--     FROM traslados_snapshot_log
--    WHERE creado_at > now() - interval '7 days'
--    GROUP BY resultado;
-- ---------------------------------------------------------------------------
