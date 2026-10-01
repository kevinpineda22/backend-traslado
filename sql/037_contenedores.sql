-- =============================================================================
-- Migration 037: CONTENEDORES — el despachador agrupa lo que despacha.
-- Ejecutar en el SQL Editor de Supabase (una sola vez), ANTES de desplegar.
-- Depende de la 036 (traslados_recepcion_conteos).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- EL PROBLEMA QUE RESUELVE
--
-- En un despacho grande el despachador arma canastillas: "en la 15 van los
-- aceites y el arroz, en la 22 los enlatados". Hasta hoy el sistema solo sabía
-- el TOTAL por producto, así que al llegar el camión el auditor recibía una
-- montaña de productos sin saber qué canastilla bajar primero ni contra qué
-- comparar cada una. Con esto, cada canastilla viaja con su contenido declarado
-- y el auditor la recibe por separado (fase 3).
--
-- LOS CONTENEDORES SON OPCIONALES
-- Un despacho sin contenedores funciona exactamente igual que antes. Un producto
-- puede ir entero suelto, entero en un contenedor, o repartido: 30 en la 15, 20
-- en la 22 y 5 sueltos.
--
-- EL TOTAL SIGUE SIENDO `cantidad_despachador`
-- SIESA, los correos, el comparativo, la analítica y el monitor leen el total
-- por producto y no se tocan. Los contenedores son un DESGLOSE de ese total:
--
--     cantidad_despachador = cantidad_suelta + Σ contenedor_items.cantidad
--
-- El backend mantiene esa suma (ver `Contenedor.model.js → recalcularTotal`) y la
-- vuelve a verificar al finalizar la recolección, que es lo que sale a SIESA.
--
-- POR QUÉ `cantidad_suelta` Y NO DEDUCIRLA
-- Si el celular mandara el TOTAL (como antes), dos personas llenando el mismo
-- producto en dos contenedores distintos se pisarían: cada una mandaría un total
-- armado con lo que ella veía. Con la parte suelta guardada aparte, cada escritura
-- toca SOLO lo suyo (su contenedor, o lo suelto) y el total lo arma el servidor.
--
-- UNIDADES: `contenedor_items.cantidad` está en la UM DEL RENGLÓN, igual que
-- `cantidad_despachador`. Por eso no se puede cambiar la unidad de un producto que
-- ya está en un contenedor (ARQUITECTURA §6.5): las cantidades guardadas quedarían
-- expresadas en una unidad que el renglón ya no tiene.
-- ---------------------------------------------------------------------------

ALTER TABLE traslados_items
  ADD COLUMN IF NOT EXISTS cantidad_suelta NUMERIC(14,4);

COMMENT ON COLUMN traslados_items.cantidad_suelta IS
  'Parte del conteo del despachador que va SIN contenedor (UM del renglón). cantidad_despachador = cantidad_suelta + suma de traslados_contenedor_items. NULL = sin contar (migración 037).';

-- Backfill: hasta hoy todo iba suelto. Así los despachos en curso al desplegar
-- arrancan con el desglose correcto.
UPDATE traslados_items
   SET cantidad_suelta = cantidad_despachador
 WHERE cantidad_despachador IS NOT NULL
   AND cantidad_suelta IS NULL;

-- ---------------------------------------------------------------------------
-- El contenedor físico. `numero` es el que está pintado en la canastilla (las
-- canastillas ya vienen numeradas): lo digita el despachador y se guarda
-- normalizado ("007" → "7", " c-15 " → "C-15") para que dos formas de escribir
-- la misma no pasen por dos contenedores distintos.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS traslados_contenedores (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  despacho_id  UUID NOT NULL REFERENCES traslados_despachos(id) ON DELETE CASCADE,
  numero       TEXT NOT NULL CHECK (length(numero) BETWEEN 1 AND 20),
  estado       TEXT NOT NULL DEFAULT 'abierto' CHECK (estado IN ('abierto', 'cerrado')),
  creado_por   TEXT,
  cerrado_por  TEXT,
  cerrado_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- La misma canastilla no puede estar dos veces en el mismo camión.
  CONSTRAINT traslados_contenedores_numero_uk UNIQUE (despacho_id, numero)
);

COMMENT ON TABLE traslados_contenedores IS
  'Contenedores (canastillas) en que el despachador agrupa un despacho. Opcionales (migración 037).';

-- ---------------------------------------------------------------------------
-- Qué hay dentro de cada contenedor. Una fila por (contenedor, renglón). Cantidad
-- en la UM del renglón y SIEMPRE > 0: sacar un producto del contenedor borra la
-- fila, así "está en el contenedor" y "tiene fila" son lo mismo.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS traslados_contenedor_items (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contenedor_id    UUID NOT NULL REFERENCES traslados_contenedores(id) ON DELETE CASCADE,
  item_id          UUID NOT NULL REFERENCES traslados_items(id) ON DELETE CASCADE,
  cantidad         NUMERIC(14,4) NOT NULL CHECK (cantidad > 0),
  actualizado_por  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT traslados_contenedor_items_uk UNIQUE (contenedor_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_contenedores_despacho
  ON traslados_contenedores (despacho_id);
CREATE INDEX IF NOT EXISTS idx_contenedor_items_item
  ON traslados_contenedor_items (item_id);

-- El conteo del auditor ya tenía la columna (036) esperando esta tabla.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'traslados_recepcion_conteos_contenedor_fk'
  ) THEN
    ALTER TABLE traslados_recepcion_conteos
      ADD CONSTRAINT traslados_recepcion_conteos_contenedor_fk
      FOREIGN KEY (contenedor_id) REFERENCES traslados_contenedores(id) ON DELETE CASCADE;
  END IF;
END $$;

-- Verificación: los dos números deberían coincidir (todo lo contado quedó suelto).
SELECT
  COUNT(*) FILTER (WHERE cantidad_despachador IS NOT NULL) AS renglones_contados,
  COUNT(*) FILTER (WHERE cantidad_suelta IS NOT NULL)      AS con_suelto
FROM traslados_items;
