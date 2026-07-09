-- Capacidad Llano: columna descripción (opcional).
-- Permite guardar la descripción del ítem desde el Excel o al crearlo a mano.
-- Correr en Supabase (SQL editor) antes de desplegar el backend con esta feature.

ALTER TABLE traslados_capacidad
  ADD COLUMN IF NOT EXISTS descripcion text;
