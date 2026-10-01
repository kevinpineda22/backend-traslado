-- =============================================================================
-- Migration 036: el conteo del auditor vive en la base, escaneo por escaneo.
-- Ejecutar en el SQL Editor de Supabase (una sola vez), ANTES de desplegar.
-- Depende de la 015 (auditoria_abierta_at).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- EL PROBLEMA QUE RESUELVE
--
-- Hasta hoy el auditor contaba TODO en el localStorage de su celular y no le
-- mandaba nada al backend hasta firmar. Tres consecuencias:
--
--   1. Celular que se apaga, se daña o se queda sin batería = recepción perdida
--      entera. Una hora de conteo de 300 productos, a empezar de nuevo.
--   2. Nadie podía ver el avance: para el monitor, un traslado con el auditor
--      contando se veía igual que uno abandonado.
--   3. Dos auditores no podían repartirse un camión: cada celular tenía su
--      propio conteo y solo uno firmaba.
--
-- El despachador ya no tenía este problema (sincroniza cada 3 s a
-- `traslados_items.cantidad_despachador`). Esto lo iguala del lado del auditor.
--
-- POR QUÉ UNA TABLA Y NO `traslados_items.cantidad_auditor`
-- Porque el conteo en curso NO es el resultado. `cantidad_auditor` y
-- `diferencia` se escriben al CONFIRMAR, con la decisión y la firma, y de ahí
-- leen el correo comparativo, la analítica y el plano final. Escribir ahí cada
-- escaneo haría que esos consumidores vean conteos a medias como si fueran la
-- recepción firmada.
--
-- POR QUÉ UNA FILA POR AUDITOR
-- Si dos personas cuentan el mismo producto, cada una escribe SU fila con SU
-- total, y el total del producto es la suma. Con una sola fila por producto, el
-- segundo celular pisaría al primero (gana el último que sincroniza) — y la
-- cola offline hace que "el último" sea cualquiera, no el más reciente.
--
-- Y UNA POR DISPOSITIVO (`dispositivo`)
-- Las cuentas de sede se comparten: dos celulares con el mismo correo son dos
-- personas contando. Si la fila fuera solo por correo, volverían a pisarse. Cada
-- navegador genera un id propio la primera vez y lo conserva. Bonus: si alguien
-- cambia de celular a mitad de recepción, lo que contó con el anterior sigue en
-- su fila y se sigue sumando — no se pierde ni hay que copiarlo.
--
-- LA CLAVE LA ARMA EL BACKEND (`clave`)
-- Identifica la fila: contenedor (o ninguno) | producto (renglón o código de un
-- ítem fuera de lista) | auditor | dispositivo. Se guarda armada en vez de un índice sobre
-- expresiones porque el upsert de PostgREST solo sabe usar columnas en
-- `on_conflict`. Ver `RecepcionConteo.model.js → claveConteo`.
--
-- `contenedor_id` queda listo para la recepción por contenedor (fase 3): hoy
-- siempre es NULL. La FK se agrega con la tabla de contenedores.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS traslados_recepcion_conteos (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  despacho_id    UUID NOT NULL REFERENCES traslados_despachos(id) ON DELETE CASCADE,
  clave          TEXT NOT NULL,
  contenedor_id  UUID,
  -- Renglón del despacho. NULL = mercancía que NO venía en la lista (sobrante):
  -- se identifica por `codigo_item` y se inserta como renglón recién al confirmar.
  item_id        UUID REFERENCES traslados_items(id) ON DELETE CASCADE,
  codigo_item    TEXT NOT NULL,
  descripcion    TEXT,
  unidad_medida  TEXT,
  -- SIEMPRE en UND, igual que `traslados_items.cantidad_auditor`.
  cantidad       NUMERIC(14,4) NOT NULL DEFAULT 0 CHECK (cantidad >= 0),
  no_recibido    BOOLEAN NOT NULL DEFAULT FALSE,
  -- Lo que se había contado antes de un "Recontar" (respaldo + confirmación por
  -- repetición). NULL = este producto no está en recuento.
  conteo_previo  NUMERIC(14,4),
  contado_por    TEXT NOT NULL,
  -- Id del navegador que contó ('' = cliente sin id). Ver encabezado.
  dispositivo    TEXT NOT NULL DEFAULT '',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT traslados_recepcion_conteos_clave_uk UNIQUE (despacho_id, clave)
);

COMMENT ON TABLE traslados_recepcion_conteos IS
  'Conteo EN CURSO del auditor, una fila por (contenedor, producto, auditor, dispositivo). El resultado firmado sigue en traslados_items.cantidad_auditor (migración 036).';

-- El panel y el monitor siempre leen acotado a un despacho.
CREATE INDEX IF NOT EXISTS idx_recepcion_conteos_despacho
  ON traslados_recepcion_conteos (despacho_id);

-- Verificación.
SELECT COUNT(*) AS filas FROM traslados_recepcion_conteos;
