-- ---------------------------------------------------------------------------
-- 025 — Sede del despachador: cada cuenta ve solo lo de su bodega
-- ---------------------------------------------------------------------------
--
-- QUÉ RESUELVE
-- Hasta ahora los dos paneles operativos mostraban TODO a todo el mundo:
-- `findForAuditor()` traía cada despacho en Recolectado sin mirar el destino, y
-- el pool del despachador ofrecía cualquier despacho sin mirar el origen. Con una
-- cuenta por sede eso significa que Vegas ve lo de Barbosa, y que alguien puede
-- reclamar por error un traslado que no le toca.
--
-- POR QUÉ UNA SOLA COLUMNA Y NO DOS
-- La misma sede acota los dos paneles, pero contra campos distintos:
--
--   Panel del despachador  → filtra por `despachos.origen`  (yo despacho DESDE acá)
--   Panel de recibo        → filtra por `despachos.destino`  (yo recibo ACÁ)
--
-- No hacen falta dos columnas porque no son dos datos: es la bodega donde la
-- persona trabaja. Girardota Parque (00301) es el caso que lo prueba — recibe lo
-- que viene de PV001 y despacha hacia Llano. Con una sola sede, su cuenta ve las
-- dos cosas en el panel que corresponde, sin configurar nada extra.
--
-- SEDE NULA = VE TODO
-- Los despachadores que ya existen no tienen sede y no se les inventa una. Un
-- NULL acá significa "sin restricción", que es exactamente el comportamiento de
-- hoy. Así esta migración no le cambia el panel a nadie que esté trabajando: el
-- filtro solo aparece para quien tenga sede cargada.
--
-- REQUIERE LA 021 CORRIDA ANTES.
-- Las cuentas de recibo se insertan sin cédula, y `documento` es NOT NULL hasta
-- que la 021 lo libera. Sin ese paso previo, el INSERT de abajo falla con un
-- error de constraint que no dice nada sobre la causa real. El bloque siguiente
-- lo detecta y lo explica en castellano antes de tocar nada.
--
-- Correr en el SQL Editor de Supabase.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'traslados_despachadores'
       AND column_name = 'documento'
       AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION
      'Falta correr sql/021_despachador_correo_obligatorio.sql primero: '
      'documento sigue siendo NOT NULL y las cuentas de recibo van sin cédula.';
  END IF;
END $$;

ALTER TABLE traslados_despachadores
  ADD COLUMN IF NOT EXISTS sede varchar(10);

COMMENT ON COLUMN traslados_despachadores.sede IS
  'Bodega de la persona (código SIESA: PV001, 00201, …). Acota el panel del '
  'despachador por origen y el de recibo por destino. NULL = ve todas las sedes.';

-- Buscar la sede por correo es lo que hace cada request de los dos paneles.
CREATE INDEX IF NOT EXISTS idx_despachadores_sede
  ON traslados_despachadores (sede) WHERE sede IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Cuentas de recibo, una por bodega.
--
-- El correo va en MINÚSCULAS a propósito: se compara contra el de la sesión para
-- resolver la sede, y el modelo lo normaliza así (ver `normalizarCorreo`). Un
-- "Recibovegas@" cargado con mayúsculas no matchearía con el "recibovegas@" que
-- llega del login, y esa cuenta se quedaría sin filtro — viendo todo, en
-- silencio.
--
-- ON CONFLICT sobre el correo: la migración se puede correr dos veces sin
-- duplicar a nadie, y si la cuenta ya existía se le completa la sede.
-- ---------------------------------------------------------------------------

INSERT INTO traslados_despachadores (nombre, correo, sede, activo) VALUES
  ('RECIBO PLAZA',         'reciboplaza@merkahorrosas.com',         'PV001', true),
  ('RECIBO VILLAHERMOSA',  'recibovillahermosa@merkahorrosas.com',  '00201', true),
  ('RECIBO PARQUE',        'reciboparque@merkahorrosas.com',        '00301', true),
  ('RECIBO LLANO',         'recibollano@merkahorrosas.com',         '00401', true),
  ('RECIBO SAN JUAN',      'recibosanjuan@merkahorrosas.com',       '00801', true),
  ('RECIBO VEGAS',         'recibovegas@merkahorrosas.com',         '00601', true),
  ('RECIBO BARBOSA',       'recibobarbosa@merkahorrosas.com',       '00701', true)
-- El predicado del ON CONFLICT tiene que ser IDÉNTICO al del índice de la 020
-- (`WHERE activo = true AND correo IS NOT NULL`). Con uno distinto, Postgres no
-- infiere el índice y responde "no unique or exclusion constraint matching".
ON CONFLICT (lower(correo)) WHERE activo = true AND correo IS NOT NULL
DO UPDATE SET sede = EXCLUDED.sede, updated_at = now();

-- ---------------------------------------------------------------------------
-- Verificación:
--
--   SELECT nombre, correo, sede, activo
--     FROM traslados_despachadores
--    ORDER BY sede NULLS LAST, nombre;
--
-- Se espera: las 7 cuentas de recibo con su sede, y los despachadores previos
-- con sede NULL (siguen viendo todo, como hasta hoy).
-- ---------------------------------------------------------------------------
