-- =============================================================
-- 002_uuid_snapshot.sql
--
-- Esquema AUTORITATIVO actual (supersede a 001_create_tables.sql).
--
-- Cambios respecto a 001:
--   • PKs migradas de BIGINT → UUID (gen_random_uuid) en las 3 tablas.
--   • traslados_despachos: + columna `flujo`.
--   • traslados_items: + snapshot del contexto que vio el admin
--     (factor, rotacion, stock_origen, stock_destino, consumo_destino,
--      stock_seguridad) y + `agotado` (despachador: faltante por agotado).
--   • Nueva tabla `traslados_snapshot` (espejo agregado de SIESA, poblado
--     por el cron /api/siesa/refresh — ver docs/ARQUITECTURA.md §4).
--
-- Correr en una base LIMPIA de dev. Los DROP quitan restos de intentos previos.
-- =============================================================

drop table if exists public.traslados_firmas cascade;
drop table if exists public.traslados_items cascade;
drop table if exists public.traslados_despachos cascade;
drop table if exists public.traslados_snapshot cascade;

-- Trigger reutilizable de updated_at
create or replace function public.trigger_set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- ─── Cabecera del despacho ───────────────────────────────────
create table public.traslados_despachos (
  id uuid primary key default gen_random_uuid(),
  flujo varchar(20) not null default 'general',
  origen varchar(20) not null,
  destino varchar(20) not null,
  despachador_id varchar(100),
  admin_id varchar(100),
  criterios jsonb,
  estado varchar(30) not null default 'Creado',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ─── Items del despacho (con snapshot de lo que vio el admin) ─
create table public.traslados_items (
  id uuid primary key default gen_random_uuid(),
  despacho_id uuid not null references public.traslados_despachos(id) on delete cascade,
  codigo_item varchar(20) not null,
  descripcion text,
  unidad_medida varchar(20),
  factor numeric(12,4) default 1,
  rotacion varchar(40),
  stock_origen numeric(12,2),
  stock_destino numeric(12,2),
  consumo_destino numeric(12,2),
  stock_seguridad numeric(12,2),
  sugerido numeric(12,2),
  cantidad_admin numeric(12,2) not null default 0,
  cantidad_despachador numeric(12,2),
  agotado boolean not null default false,      -- true = faltante por agotado (≠ no recolectado)
  cantidad_auditor numeric(12,2),
  diferencia numeric(12,2),
  aceptado boolean,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ─── Firmas digitales (despachador / auditor) ────────────────
create table public.traslados_firmas (
  id uuid primary key default gen_random_uuid(),
  despacho_id uuid not null references public.traslados_despachos(id) on delete cascade,
  rol varchar(30) not null,
  firma_data text not null,
  created_at timestamptz not null default now()
);

-- ─── Snapshot agregado de SIESA (lo llena el cron) ───────────
create table public.traslados_snapshot (
  bodega varchar(20) not null,
  codigo_item varchar(20) not null,
  descripcion text,
  um varchar(20),
  um_orden varchar(20),
  factor numeric(12,4) default 1,
  inventario numeric(12,2) default 0,
  disponible numeric(12,2) default 0,
  comprometido numeric(12,2) default 0,
  consumo_promedio numeric(12,4) default 0,
  periodo_cubrimiento numeric(12,2) default 0,
  rotacion varchar(40),
  criterios jsonb,
  actualizado_at timestamptz not null default now(),
  primary key (bodega, codigo_item)
);

-- ─── Índices ─────────────────────────────────────────────────
create index if not exists idx_despachos_estado on public.traslados_despachos (estado);
create index if not exists idx_despachos_despachador on public.traslados_despachos (despachador_id);
create index if not exists idx_items_despacho_id on public.traslados_items (despacho_id);
create index if not exists idx_firmas_despacho_id on public.traslados_firmas (despacho_id);

-- ─── Triggers updated_at ─────────────────────────────────────
create trigger set_updated_at_despachos before update on public.traslados_despachos
  for each row execute function public.trigger_set_updated_at();
create trigger set_updated_at_items before update on public.traslados_items
  for each row execute function public.trigger_set_updated_at();
