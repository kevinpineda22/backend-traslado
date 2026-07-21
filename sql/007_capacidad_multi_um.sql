-- Capacidad Llano: permitir VARIAS filas por ítem, una por UM.
-- La clave pasa de (codigo_item) a (codigo_item, unidad). La fila "sin UM"
-- (capacidad base) usa unidad = '' para que la unicidad compuesta no choque con
-- NULLs. Así el mismo ítem puede tener CAJA + BULTO sin pisarse.
--
-- Correr en Supabase (SQL editor). Es sobre datos reales: idealmente hacé un
-- backup/duplicado de la tabla antes. Si el DROP CONSTRAINT falla por nombre,
-- avisá y ajustamos (el nombre por defecto es traslados_capacidad_pkey).

UPDATE traslados_capacidad SET unidad = '' WHERE unidad IS NULL;

ALTER TABLE traslados_capacidad ALTER COLUMN unidad SET DEFAULT '';
ALTER TABLE traslados_capacidad ALTER COLUMN unidad SET NOT NULL;

ALTER TABLE traslados_capacidad DROP CONSTRAINT IF EXISTS traslados_capacidad_pkey;
ALTER TABLE traslados_capacidad ADD PRIMARY KEY (codigo_item, unidad);
