-- =============================================================================
-- Migration 018: carga inicial de la flota (vehículos, conductores, despachadores)
-- Ejecutar en el SQL Editor de Supabase DESPUÉS de la 016.
--
-- Datos tomados de `INFORMACION MANIFIESTO.xlsx` (hojas CAMIONES, CONDUCTORES,
-- DESPACHADORES), entregado por Johan el 2026-07-31.
--
-- NORMALIZACIÓN APLICADA AL CARGAR
--   · Nombres, ciudades y placas en MAYÚSCULAS (van impresos en un documento).
--   · Espacios de más colapsados y recortados — el Excel traía varios nombres con
--     espacio al final y una licencia con espacio al principio.
--   · Licencias en mayúsculas: venían mezcladas ("lc10000143063", "Lc06002907604").
--   · Cédulas y teléfonos como TEXTO. En Excel eran números, y un número pierde
--     los ceros a la izquierda: la cédula 0123456789 se convertiría en 123456789.
--
-- IDEMPOTENTE: cada INSERT se salta las filas que ya existen (por placa o
-- documento, entre los activos). Se puede correr de nuevo sin duplicar.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Vehículos — 5 de la flota propia.
-- ---------------------------------------------------------------------------
INSERT INTO traslados_vehiculos (placa, marca, clase, tipo, color, carroceria)
SELECT v.placa, v.marca, v.clase, v.tipo, v.color, v.carroceria
FROM (VALUES
  ('GTX 302', 'Chevrolet', 'Camion',    'NQR', 'BLANCO',         'Estacas'),
  ('ESQ 501', 'Chevrolet', 'Camion',    'NQR', 'BLANCO GALAXIA', 'Furgon'),
  ('KPP 267', 'Foton',     'Camion',    'FRR', 'BLANCO',         'Furgon'),
  ('KSK 176', 'Chevrolet', 'Camion',    'FRR', 'BLANCO',         'Furgon'),
  ('WNP 585', 'Chevrolet', 'Camioneta', 'NHR', 'BLANCO',         'Estacas')
) AS v(placa, marca, clase, tipo, color, carroceria)
WHERE NOT EXISTS (
  SELECT 1 FROM traslados_vehiculos t
   WHERE upper(t.placa) = upper(v.placa) AND t.activo = true
);

-- ---------------------------------------------------------------------------
-- Conductores — 6.
--
-- OJO: tres NO tienen licencia cargada (Iván Darío, Juan Guillermo, Robinson).
-- Se cargan igual con `NULL` en vez de inventar el dato: un manifiesto con la
-- licencia en blanco es honesto; uno con una licencia falsa, no. Conviene
-- completarlas desde el panel cuando alguien las tenga a mano.
-- ---------------------------------------------------------------------------
INSERT INTO traslados_conductores (documento, nombre, telefono, licencia, direccion, ciudad)
SELECT c.documento, c.nombre, c.telefono, c.licencia, c.direccion, c.ciudad
FROM (VALUES
  ('1216713188', 'JORGE LUIS VELASQUEZ GIRALDO',   '3508054993', 'LC10000143063', 'Calle 81 # 45 45',   'MEDELLIN'),
  ('15516297',   'MANUEL ALEXANDER LUJAN MENESES', '3147712492', 'LC06002907604', 'Clle 43 #57A 72',    'COPACABANA'),
  ('3482971',    'IVAN DARIO ECHAVARRIA TORRES',   '3005022567', NULL,            'Calle 52 # 52 - 24', 'COPACABANA'),
  ('1020482654', 'JUAN FELIPE DÍAZ SERNA',         '3002934444', 'LC3007657229',  'Cra36 #59b 20',      'COPACABANA'),
  ('15507093',   'JUAN GUILLERMO ARANGO OSORIO',   '3166953933', NULL,            'Cra 58 # 46a 36',    'COPACABANA'),
  ('1000539398', 'ROBINSON ELIAS JARAMILLO RIOS',  '3206699970', NULL,            'Calle 52 # 52 - 24', 'COPACABANA')
) AS c(documento, nombre, telefono, licencia, direccion, ciudad)
WHERE NOT EXISTS (
  SELECT 1 FROM traslados_conductores t
   WHERE t.documento = c.documento AND t.activo = true
);

-- ---------------------------------------------------------------------------
-- Despachadores — 2.
--
-- ⚠️ ESTOS DATOS PARECEN DE PRUEBA. Cédulas 1234 y 124556, teléfonos 32547444 y
-- 2222222: no son documentos ni teléfonos reales. Se cargan tal cual porque es lo
-- que vino en el Excel y sirve para probar el flujo, pero **hay que corregirlos
-- antes de usar el manifiesto en serio** — el punto del documento es saber quién
-- despachó, y una cédula inventada no identifica a nadie.
-- ---------------------------------------------------------------------------
INSERT INTO traslados_despachadores (documento, nombre, telefono)
SELECT d.documento, d.nombre, d.telefono
FROM (VALUES
  ('1234',   'DANILO', '32547444'),
  ('124556', 'LUIS',   '2222222')
) AS d(documento, nombre, telefono)
WHERE NOT EXISTS (
  SELECT 1 FROM traslados_despachadores t
   WHERE t.documento = d.documento AND t.activo = true
);

-- ---------------------------------------------------------------------------
-- Verificación — debe devolver 5, 6 y 2.
-- ---------------------------------------------------------------------------
-- SELECT 'vehiculos' AS tabla, COUNT(*) FROM traslados_vehiculos WHERE activo
-- UNION ALL SELECT 'conductores', COUNT(*) FROM traslados_conductores WHERE activo
-- UNION ALL SELECT 'despachadores', COUNT(*) FROM traslados_despachadores WHERE activo;
