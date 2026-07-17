-- Capacidad Llano: UM opcional por ítem.
-- A algunos ítems se les asigna una unidad de medida (ej: "CAJA") y un factor
-- (cuántas UND base = 1 de esa unidad). La capacidad se carga EN esa unidad.
-- En el despacho, esos ítems dejan elegir la cantidad en esa UM.
-- Correr en Supabase (SQL editor) antes de desplegar.

ALTER TABLE traslados_capacidad
  ADD COLUMN IF NOT EXISTS unidad text,
  ADD COLUMN IF NOT EXISTS factor numeric;
