-- Config de reposición editable desde el admin (días de los traslados).
-- Una sola fila (clave = 'reposicion') con el JSON de cadencias Llano y el
-- cubrimiento global del General. Correr en Supabase antes de desplegar.

CREATE TABLE IF NOT EXISTS traslados_config (
  clave      text PRIMARY KEY,
  valor      jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Semilla con los valores por defecto (no pisa si ya existe).
INSERT INTO traslados_config (clave, valor)
VALUES (
  'reposicion',
  '{"llano":{"A":1,"B":3,"C":5},"general":{"periodoCubrimiento":null}}'::jsonb
)
ON CONFLICT (clave) DO NOTHING;
