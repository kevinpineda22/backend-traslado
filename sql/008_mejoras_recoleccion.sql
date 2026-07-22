-- Agregar columna 'grupo' a traslados_items
ALTER TABLE public.traslados_items ADD COLUMN grupo text;

-- Tabla para resolución de códigos de barras (EAN a PLU)
CREATE TABLE public.siesa_codigos_barras (
  codigo_barras text PRIMARY KEY,
  f120_id text NOT NULL,
  unidad_medida text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

-- Habilitar RLS si es política general
ALTER TABLE public.siesa_codigos_barras ENABLE ROW LEVEL SECURITY;

CREATE POLICY "siesa_codigos_barras es de lectura pública"
ON public.siesa_codigos_barras FOR SELECT
USING (true);

-- (La inserción o llenado se asume que viene desde SIESA mediante otro proceso o cron)