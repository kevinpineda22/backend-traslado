-- =============================================================================
-- Migration 038: el auditor RECIBE por canastilla.
-- Ejecutar en el SQL Editor de Supabase (una sola vez), ANTES de desplegar.
-- Depende de la 036 (conteo del auditor) y la 037 (contenedores).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- QUÉ RESUELVE
--
-- Con canastillas (037) el auditor baja del camión la 15, entra a ella en el
-- panel, escanea lo que tiene adentro y la cierra. Al cerrarla el sistema la
-- compara contra lo que el despachador declaró EN ESA canastilla. Si un producto
-- no cuadra, se recuenta mientras la canastilla está todavía abierta enfrente,
-- no al final con todo el camión mezclado.
--
-- LA AUDITORÍA SIGUE SIENDO CIEGA
-- El auditor ve los NÚMEROS de las canastillas, nunca su contenido. Al cerrar una
-- se le dice qué productos recontar (por nombre, como hoy) y CUÁNTOS productos
-- declarados no encontró — sin nombrarlos: nombrarlos sería decirle qué buscar.
--
-- LO QUE CUENTA PARA EL INVENTARIO ES EL TOTAL POR PRODUCTO
-- Un producto que el despachador puso en la 15 y aparece en la 22 está "mal
-- ubicado", no faltante + sobrante. La comparación final del traslado (la de
-- siempre) suma todas las canastillas por producto. Lo de cada canastilla queda
-- guardado en `recepcion_resultado` para el monitor y el correo.
-- ---------------------------------------------------------------------------

ALTER TABLE traslados_contenedores
  -- Canastilla que llegó en el camión y NO estaba en la lista del despachador.
  -- La crea el auditor al recibir; todo su contenido es sobrante o mal ubicado.
  ADD COLUMN IF NOT EXISTS no_listado BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS recepcion_estado TEXT NOT NULL DEFAULT 'pendiente',
  -- Quién la está contando (o la cerró). Aviso, no candado: si al celular se le
  -- acaba la batería, otra persona la toma y sigue.
  ADD COLUMN IF NOT EXISTS recepcion_por TEXT,
  ADD COLUMN IF NOT EXISTS recepcion_at TIMESTAMPTZ,
  -- Foto de la comparación al cerrarla: { contado: {item_id: und}, diferencias,
  -- faltantes, sobrantes, forzado }. Se guarda porque un "Recontar" del
  -- traslado entero (después) mezcla las canastillas, y el monitor tiene que
  -- poder decir igual qué pasó en cada una.
  ADD COLUMN IF NOT EXISTS recepcion_resultado JSONB;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'traslados_contenedores_recepcion_estado_ck'
  ) THEN
    ALTER TABLE traslados_contenedores
      ADD CONSTRAINT traslados_contenedores_recepcion_estado_ck
      CHECK (recepcion_estado IN ('pendiente', 'contando', 'cerrado', 'no_recibido'));
  END IF;
END $$;

COMMENT ON COLUMN traslados_contenedores.recepcion_estado IS
  'Recepción de la canastilla: pendiente → contando → cerrado | no_recibido (migración 038).';

-- Verificación.
SELECT recepcion_estado, COUNT(*) FROM traslados_contenedores GROUP BY 1;
