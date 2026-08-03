-- =============================================================================
-- Migration 024: rellenar `traslados_items.grupo` en los renglones viejos.
-- Ejecutar en el SQL Editor de Supabase (una sola vez). No crea ni borra nada:
-- solo escribe donde hoy hay NULL.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- EL PROBLEMA QUE RESUELVE
--
-- La lista del despachador se ordena por grupo (`findById` pide
-- `.order("grupo")`, y el front agrupa con `ordenarItemsPorCategoria`). Pero un
-- renglón con `grupo` en NULL cae en "Sin grupo", y cuando TODOS los renglones
-- de un despacho están en NULL el único criterio que queda es la descripción:
-- la lista se ve alfabética. Es exactamente lo que reporta la operación.
--
-- El grupo se empezó a guardar recién cuando el AdminPanel lo mandó en el
-- payload (`grupo: p.criterios?.["001"]`). Todo lo creado ANTES de ese cambio
-- quedó en NULL, y esos despachos no se corrigen solos: el grupo es un snapshot
-- del ítem, se escribe al crear el renglón y nadie lo vuelve a tocar.
--
-- POR QUÉ EL SNAPSHOT Y NO `items_siesa`
--
-- Las dos tablas tienen el dato, pero no lo tienen igual. Medido contra los
-- códigos que hoy están sin grupo: `traslados_snapshot` los resuelve todos;
-- `items_siesa` deja afuera cerca de un 13%. Además el snapshot ya es la fuente
-- que este módulo usa para todo lo demás (mismo Supabase, sin joins nuevos), y
-- el grupo sale del MISMO criterio 001 que escribe el AdminPanel — así el
-- renglón viejo queda con el valor que habría tenido si se creaba hoy.
--
-- `items_siesa` entra igual, en el paso 2, como red para lo que el snapshot no
-- tenga. Es lo mismo que usa el módulo Domicilios.
-- ---------------------------------------------------------------------------

-- ─── Paso 0: cuánto hay para arreglar (informativo, corré esto primero) ─────
-- SELECT COUNT(*) AS renglones_sin_grupo,
--        COUNT(DISTINCT codigo_item) AS codigos_distintos
--   FROM traslados_items WHERE grupo IS NULL;

-- ─── Paso 1: desde el snapshot de SIESA (criterio 001 = Grupo) ─────────────
-- El snapshot tiene una fila por (bodega, codigo_item) y el grupo es del
-- producto, no de la bodega: cualquiera de sus filas sirve. Se toma la más
-- fresca con DISTINCT ON para no depender de cuál devuelva el planner.
WITH grupo_snapshot AS (
  SELECT DISTINCT ON (TRIM(codigo_item))
         TRIM(codigo_item)                   AS codigo_item,
         NULLIF(TRIM(criterios ->> '001'), '') AS grupo
    FROM traslados_snapshot
   WHERE NULLIF(TRIM(criterios ->> '001'), '') IS NOT NULL
   ORDER BY TRIM(codigo_item), actualizado_at DESC
)
UPDATE traslados_items ti
   SET grupo = gs.grupo
  FROM grupo_snapshot gs
 WHERE ti.grupo IS NULL
   AND TRIM(ti.codigo_item) = gs.codigo_item;

-- ─── Paso 2: red de respaldo desde `items_siesa` ───────────────────────────
-- Solo para lo que el paso 1 no alcanzó. `f120_id` es integer y `codigo_item`
-- es varchar: el guarda de dígitos evita que un código con letras reviente el
-- cast (el CAST corre por fila, no hay garantía de que el WHERE lo filtre antes).
UPDATE traslados_items ti
   SET grupo = NULLIF(TRIM(s.grupo), '')
  FROM items_siesa s
 WHERE ti.grupo IS NULL
   AND TRIM(ti.codigo_item) ~ '^[0-9]+$'
   AND s.f120_id = TRIM(ti.codigo_item)::integer
   AND NULLIF(TRIM(s.grupo), '') IS NOT NULL;

-- ---------------------------------------------------------------------------
-- VERIFICACIÓN
--
-- Lo que quede en NULL después de los dos pasos son códigos que ninguna de las
-- dos fuentes conoce (ítems dados de baja en SIESA, o cargados a mano). Se
-- quedan en "Sin grupo" al final de la lista, que es el comportamiento correcto:
-- inventarle un grupo sería peor que no tenerlo.
--
--   SELECT COUNT(*) FROM traslados_items WHERE grupo IS NULL;
--
--   SELECT codigo_item, descripcion
--     FROM traslados_items WHERE grupo IS NULL
--    GROUP BY 1, 2 ORDER BY 1;
--
-- Y para ver un despacho ya agrupado como lo va a ver el despachador:
--
--   SELECT COALESCE(grupo, 'Sin grupo') AS grupo, COUNT(*)
--     FROM traslados_items WHERE despacho_id = '<uuid>'
--    GROUP BY 1 ORDER BY 1;
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- ESTO NO SE REPITE
--
-- Los renglones NUEVOS ya nacen con grupo: el AdminPanel lo manda en el payload
-- y `aFilaItem` lo persiste. `agregarItemsBorrador` además lo REFRESCA al
-- re-agregar un ítem, así que un renglón viejo que se vuelva a tocar se corrige
-- solo. Esta migración es para los que nadie va a volver a tocar.
-- ---------------------------------------------------------------------------
