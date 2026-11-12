-- ---------------------------------------------------------------------------
-- 043 — Catálogo de ítems de SIESA y "portafolio extra" por sede
-- ---------------------------------------------------------------------------
--
-- QUÉ RESUELVE
-- El panel de "Nuevo despacho" solo muestra lo que el DESTINO ya maneja (tiene fila
-- en `traslados_snapshot`) o lo que cumple el portafolio del flujo (CAT en Llano,
-- CAM en Machado, capacidad cargada...). Un producto nuevo para una sede queda
-- encerrado en un círculo: la sede no lo tiene, entonces no sale en el panel,
-- entonces nadie se lo despacha, entonces nunca se mueve y la sede nunca lo tiene.
--
-- El "portafolio extra" es la puerta que lo rompe: un administrador agrega a mano
-- un producto (destino + código de ítem) al portafolio de UNA sede, y desde ese
-- momento el producto aparece en la lista de esa sede en TODOS los flujos, aunque
-- no tenga capacidad, no se haya movido nunca allí o no exista en el origen.
--
-- QUÉ HACE
--   1. Habilita la extensión `pg_trgm` (búsqueda por texto parcial en el catálogo).
--   2. `traslados_catalogo`: catálogo de ítems ACTIVOS de SIESA (~23 mil filas),
--      poblado por el cron `scripts/refresh-catalogo.js`. Sirve para buscar el ítem
--      al agregarlo y para darle descripción/UM a un extra que no tiene fila en el
--      snapshot. NO tiene inventario: el stock sigue viniendo del snapshot.
--   3. `traslados_portafolio_extra`: los pares (destino, ítem) agregados a mano. Vive
--      SOLO en Supabase: nunca se escribe nada en SIESA.
--   4. `traslados_catalogo_log`: una línea por refresco del catálogo (mismo propósito
--      que `traslados_snapshot_log`, migración 041).
--
-- POR QUÉ `codigo_item` ES text
-- Es el mismo tipo y la misma forma que `traslados_snapshot.codigo_item` (el código
-- de SIESA como texto, sin ceros a la izquierda). Con eso la clave del catálogo, la
-- del extra y la del snapshot cruzan sin conversiones.
--
-- ORDEN DE DESPLIEGUE
-- Correr esta migración ANTES de desplegar el backend nuevo. Aun así, si el backend
-- llega primero, la lista de productos no se cae: sin la tabla simplemente no hay
-- extras (ver `extrasDe` en siesa.service.js). Después de migrar, correr el primer
-- refresco del catálogo (workflow "Refrescar catálogo SIESA" o
-- `node scripts/refresh-catalogo.js`): hasta entonces el catálogo está vacío y no se
-- puede agregar ningún ítem.
--
-- IDEMPOTENTE: se puede correr dos veces.
--
-- Correr en el SQL Editor de Supabase.
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ─── Catálogo de ítems activos de SIESA ────────────────────────────────────

CREATE TABLE IF NOT EXISTS traslados_catalogo (
  codigo_item     text PRIMARY KEY,
  -- Un ítem puede tener varias extensiones en SIESA (v121a: una fila por extensión);
  -- el refresco conserva la primera por código, así que acá va solo una.
  rowid_item_ext  bigint,
  descripcion     text NOT NULL,
  referencia      text,
  um              text,
  um_orden        text,
  -- 1 = activo. La consulta de Connekta ya filtra por estado 1; se guarda por si el
  -- filtro se relaja algún día y para poder rechazar un inactivo al agregarlo.
  estado          integer,
  id_grupo        text,
  grupo           text,
  id_subgrupo     text,
  subgrupo        text,
  -- Cuándo lo vio el último refresco. El prune borra lo que quedó con una fecha
  -- anterior al inicio del refresco vigente (ítems que ya no están activos).
  sincronizado_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE traslados_catalogo IS
  'Catálogo de ítems activos de SIESA (consulta de Connekta merkahorro_catalogo_activo). '
  'Solo identidad del ítem: sin inventario. Lo puebla scripts/refresh-catalogo.js.';

-- Búsqueda parcial ("ILIKE %texto%") sobre descripción y referencia.
CREATE INDEX IF NOT EXISTS idx_catalogo_descripcion_trgm
  ON traslados_catalogo USING gin (descripcion gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_catalogo_referencia_trgm
  ON traslados_catalogo USING gin (referencia gin_trgm_ops);

-- ─── Portafolio extra por sede ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS traslados_portafolio_extra (
  -- Bodega SIESA de la sede (cualquiera de SEDES en config/flujos.js).
  destino      text NOT NULL,
  codigo_item  text NOT NULL,
  -- Quién lo agregó (texto libre: nombre o correo del administrador). Solo auditoría.
  agregado_por text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (destino, codigo_item)
);

COMMENT ON TABLE traslados_portafolio_extra IS
  'Productos que un administrador agregó a mano al portafolio de una sede. Aparecen en '
  'la lista de esa sede en todos los flujos aunque no tengan capacidad ni movimiento. '
  'Solo Supabase: nunca se escribe en SIESA.';

-- ─── Bitácora de refrescos del catálogo ────────────────────────────────────

CREATE TABLE IF NOT EXISTS traslados_catalogo_log (
  id               bigserial PRIMARY KEY,
  creado_at        timestamptz NOT NULL DEFAULT now(),
  -- 'ok' | 'abortado' (lo frenó una guarda) | 'error' (se rompió algo)
  resultado        text NOT NULL,
  duracion_ms      integer,
  -- Filas que trajo Connekta y filas que declaró tener (guarda de completitud).
  filas_crudas     integer,
  filas_declaradas integer,
  -- Ítems distintos que terminaron en la tabla.
  items            integer,
  -- Cuántas filas se llevó el prune. Lo normal es 0 o unas pocas.
  borradas         integer,
  -- Motivo del abort o mensaje del error. NULL cuando salió bien.
  detalle          text
);

COMMENT ON TABLE traslados_catalogo_log IS
  'Una fila por refresco del catálogo. Solo para investigar; nada del flujo la lee.';

CREATE INDEX IF NOT EXISTS idx_catalogo_log_creado
  ON traslados_catalogo_log (creado_at DESC);
