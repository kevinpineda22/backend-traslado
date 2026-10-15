-- ---------------------------------------------------------------------------
-- 040 — "A este ítem la capacidad se la pone una persona, no SRI"
-- ---------------------------------------------------------------------------
--
-- QUÉ RESUELVE
-- La sincronización con SRI va a traer la capacidad medida de góndola
-- (caras × profundidad × altura) y pisar la columna `capacidad`. Para la
-- mayoría del surtido eso es exactamente lo que queremos: el dato medido le
-- gana a la estimación cargada a mano.
--
-- Pero hay ítems donde la góndola NO manda. Cervezas y gaseosas en P6 se
-- apilan fuera del lineal, los huevos van en bandeja, el frijol a granel se
-- carga por bulto. Ahí la capacidad la define quien conoce la operación, y una
-- medición de estantería la empeora.
--
-- Esta columna los marca para que la sincronización los saltee.
--
-- POR QUÉ UNA COLUMNA Y NO UNA LISTA EN EL CÓDIGO
-- Mismo argumento que `multi_um` (migración 026): una lista de códigos en el
-- repositorio obliga a un deploy cada vez que cambia el surtido, y el que sabe
-- cuáles son no es quien despliega.
--
-- EL DATO ES DEL ÍTEM, NO DE LA FILA
-- La tabla tiene una fila por (codigo_item, unidad), pero "a este ítem la
-- capacidad se la pone una persona" es una propiedad del PRODUCTO. Se replica
-- en todas las filas del ítem y se lee con OR, igual que `multi_um`: si
-- CUALQUIERA de sus filas está en true, SRI no toca ninguna.
--
-- POR QUÉ NO HAY TABLA TEMPORAL — SE INTENTÓ Y FALLÓ
-- La primera versión sembraba los códigos en un `CREATE TEMP TABLE` y fallaba
-- con `relation "_fijos_csv" does not exist`, incluso envuelta en BEGIN/COMMIT.
-- La razón: Supabase conecta por un pooler en modo transacción, así que cada
-- sentencia puede ejecutarse en una conexión distinta del pool. Una tabla
-- temporal vive por SESIÓN, y acá no hay sesión estable que la sostenga.
--
-- Por eso la lista va embebida en cada sentencia que la necesita, como un CTE
-- sobre un ARRAY literal. Cuesta repetirla dos veces, pero cada sentencia es
-- autosuficiente e idempotente: se pueden correr juntas, por separado, en
-- cualquier orden y las veces que haga falta.
--
-- Son 153 códigos. Si cambia la lista, hay que cambiar LOS DOS bloques.
--
-- Correr en el SQL Editor de Supabase.
-- ---------------------------------------------------------------------------

-- 1. La columna.
ALTER TABLE traslados_capacidad
  ADD COLUMN IF NOT EXISTS fijo boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN traslados_capacidad.fijo IS
  'true = la capacidad de este ítem la define una persona; la sincronización '
  'con SRI no la pisa. Es propiedad del ÍTEM: se replica en todas sus filas y '
  'se lee con OR.';

-- El filtro típico es "¿este ítem está fijo?" al sincronizar, sobre pocos
-- ítems marcados dentro de un surtido grande.
CREATE INDEX IF NOT EXISTS idx_capacidad_fijo
  ON traslados_capacidad (codigo_item) WHERE fijo = true;

-- ---------------------------------------------------------------------------
-- 2. SIEMBRA — los 153 ítems de "capacidades por confirmar".
--
-- OJO CON LOS CEROS A LA IZQUIERDA. El Excel trae los códigos sin ceros ("19")
-- pero la tabla puede tener filas viejas guardadas con ceros ("0000019"): el
-- modelo las normaliza en memoria (normCodigo, en
-- src/models/Capacidad.model.js) y nunca se arreglaron en la base. Un
-- `WHERE codigo_item IN (...)` crudo no las encontraría y el ítem quedaría sin
-- marcar. Por eso se compara el código NORMALIZADO de los dos lados, con la
-- misma regla que el JS: sacar los ceros de adelante, y si queda vacío
-- devolver el original.
-- ---------------------------------------------------------------------------

WITH fijos (codigo) AS (
  SELECT unnest(ARRAY[
    '19', '21', '172', '181', '458', '461', '462', '1086', '1677', '2278',
    '2491', '2494', '2574', '2582', '2586', '2592', '3469', '4079', '4885', '4886',
    '5001', '5160', '5234', '6152', '6190', '6270', '6600', '6873', '8830', '9565',
    '10333', '10778', '10789', '10796', '10839', '10914', '11785', '11787', '11788', '11789',
    '11811', '12039', '12040', '12041', '12639', '13050', '13200', '13202', '13211', '13213',
    '13323', '13661', '13706', '13868', '13904', '14516', '15048', '15414', '15628', '15629',
    '15630', '15673', '15721', '15909', '16542', '16570', '16614', '16626', '16628', '16795',
    '16939', '16942', '16943', '17900', '17927', '17929', '17952', '17967', '25513', '25588',
    '25589', '170019', '170020', '174888', '174891', '174898', '175118', '175143', '175946', '175948',
    '175952', '175954', '176206', '176290', '176379', '177693', '177791', '178078', '178332', '178396',
    '178455', '178465', '178470', '178711', '178786', '179680', '180326', '180327', '180328', '180460',
    '181156', '181262', '181320', '182247', '182736', '183146', '183148', '184007', '184615', '184681',
    '184682', '185094', '185811', '185812', '185885', '185886', '185887', '186088', '186415', '186502',
    '186503', '186518', '186751', '186787', '186859', '187196', '187214', '187322', '187323', '187329',
    '187590', '187825', '188023', '188078', '188146', '188232', '188407', '188417', '188448', '188488',
    '188717', '188852', '188909'
  ])
)
UPDATE traslados_capacidad c
   SET fijo = true
  FROM fijos f
 WHERE COALESCE(NULLIF(regexp_replace(c.codigo_item, '^0+', ''), ''), c.codigo_item)
       = f.codigo
   AND c.fijo IS NOT TRUE;

-- ---------------------------------------------------------------------------
-- 3. REPORTE — ítems de la lista que NO existen en traslados_capacidad.
--
-- Estos NO quedaron marcados, porque no hay fila que marcar. No es un error de
-- la migración: significa que ese ítem nunca se cargó en la pantalla de
-- Capacidad · Llano. El riesgo es real y silencioso: cuando alguien lo cargue,
-- va a entrar SIN el `fijo`, y la próxima sincronización con SRI le va a pisar
-- la capacidad.
--
-- Si devuelve filas, hay que cargar esos ítems y volver a correr el paso 2.
-- ---------------------------------------------------------------------------

WITH fijos (codigo) AS (
  SELECT unnest(ARRAY[
    '19', '21', '172', '181', '458', '461', '462', '1086', '1677', '2278',
    '2491', '2494', '2574', '2582', '2586', '2592', '3469', '4079', '4885', '4886',
    '5001', '5160', '5234', '6152', '6190', '6270', '6600', '6873', '8830', '9565',
    '10333', '10778', '10789', '10796', '10839', '10914', '11785', '11787', '11788', '11789',
    '11811', '12039', '12040', '12041', '12639', '13050', '13200', '13202', '13211', '13213',
    '13323', '13661', '13706', '13868', '13904', '14516', '15048', '15414', '15628', '15629',
    '15630', '15673', '15721', '15909', '16542', '16570', '16614', '16626', '16628', '16795',
    '16939', '16942', '16943', '17900', '17927', '17929', '17952', '17967', '25513', '25588',
    '25589', '170019', '170020', '174888', '174891', '174898', '175118', '175143', '175946', '175948',
    '175952', '175954', '176206', '176290', '176379', '177693', '177791', '178078', '178332', '178396',
    '178455', '178465', '178470', '178711', '178786', '179680', '180326', '180327', '180328', '180460',
    '181156', '181262', '181320', '182247', '182736', '183146', '183148', '184007', '184615', '184681',
    '184682', '185094', '185811', '185812', '185885', '185886', '185887', '186088', '186415', '186502',
    '186503', '186518', '186751', '186787', '186859', '187196', '187214', '187322', '187323', '187329',
    '187590', '187825', '188023', '188078', '188146', '188232', '188407', '188417', '188448', '188488',
    '188717', '188852', '188909'
  ])
)
SELECT f.codigo AS item_sin_fila_en_capacidad
  FROM fijos f
 WHERE NOT EXISTS (
         SELECT 1
           FROM traslados_capacidad c
          WHERE COALESCE(NULLIF(regexp_replace(c.codigo_item, '^0+', ''), ''), c.codigo_item)
                = f.codigo
       )
 ORDER BY f.codigo::bigint;

-- ---------------------------------------------------------------------------
-- 4. VERIFICACIÓN.
--
--   SELECT count(DISTINCT codigo_item) AS items_fijos
--     FROM traslados_capacidad WHERE fijo = true;
--   -- esperado: 153 menos los que haya reportado el paso 3
--
--   SELECT codigo_item, unidad, capacidad, factor
--     FROM traslados_capacidad WHERE fijo = true
--    ORDER BY codigo_item::bigint, unidad;
-- ---------------------------------------------------------------------------
