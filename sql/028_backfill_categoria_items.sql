-- ---------------------------------------------------------------------------
-- 028 — Rellenar el SUBGRUPO de los ítems ya despachados
-- ---------------------------------------------------------------------------
--
-- QUÉ RESUELVE
-- El Dashboard desglosa "qué se pidió y qué salió" por grupo y por subgrupo. El
-- grupo ya se había rellenado (migración 024), pero el subgrupo nunca: los
-- traslados viejos lo tienen en NULL y todo el histórico cae bajo "Sin subgrupo",
-- que es exactamente el análisis que no sirve.
--
-- OJO CON EL NOMBRE DE LA COLUMNA
-- `traslados_items.categoria` guarda el criterio 002, que en el negocio se llama
-- SUBGRUPO. Y `traslados_items.grupo` guarda el 001. Los nombres de las columnas
-- no coinciden con los del negocio: se copiaron así desde el carrito del admin
-- (ver `construirItem`) y renombrarlos ahora obligaría a migrar datos y tocar
-- media docena de archivos. Queda anotado para que nadie lo lea al revés.
--
-- POR QUÉ SE PUEDE RELLENAR SIN INVENTAR NADA
-- El subgrupo es del PRODUCTO, no del traslado: no cambia porque la mercancía se
-- haya movido. Tomarlo del snapshot de hoy da el mismo valor que tenía cuando se
-- armó el pedido, salvo que alguien haya reclasificado el producto en el ERP — y
-- en ese caso el dato nuevo es el bueno.
--
-- Correr en el SQL Editor de Supabase. Es idempotente: solo toca los NULL.
-- ---------------------------------------------------------------------------

-- ─────────────────────────────────────────────────────────────────────────────
-- ANTES: cuántos quedarían por rellenar (solo lectura, para comparar después)
-- ─────────────────────────────────────────────────────────────────────────────
-- SELECT count(*) FILTER (WHERE grupo IS NULL)     AS sin_grupo,
--        count(*) FILTER (WHERE categoria IS NULL) AS sin_subgrupo,
--        count(*)                                  AS total
--   FROM traslados_items;

-- ─────────────────────────────────────────────────────────────────────────────
-- PASO 1 — desde el snapshot de SIESA.
--
-- El snapshot tiene una fila por (bodega, ítem) y el subgrupo es del producto, así
-- que cualquiera de sus filas sirve. DISTINCT ON toma la más fresca para no
-- depender de cuál devuelva el planner.
-- ─────────────────────────────────────────────────────────────────────────────
WITH subgrupo_snapshot AS (
  SELECT DISTINCT ON (TRIM(codigo_item))
         TRIM(codigo_item)                     AS codigo_item,
         NULLIF(TRIM(criterios ->> '002'), '') AS subgrupo
    FROM traslados_snapshot
   WHERE NULLIF(TRIM(criterios ->> '002'), '') IS NOT NULL
   ORDER BY TRIM(codigo_item), actualizado_at DESC
)
UPDATE traslados_items ti
   SET categoria = ss.subgrupo
  FROM subgrupo_snapshot ss
 WHERE ti.categoria IS NULL
   AND TRIM(ti.codigo_item) = ss.codigo_item;

-- ─────────────────────────────────────────────────────────────────────────────
-- PASO 2 — de paso, terminar el grupo que la 024 no alcanzó.
--
-- Los ítems despachados DESPUÉS de correr la 024 vuelven a nacer con grupo NULL
-- si el snapshot no lo tenía en ese momento. Repetir el paso acá los levanta, y
-- no molesta si no hay ninguno.
-- ─────────────────────────────────────────────────────────────────────────────
WITH grupo_snapshot AS (
  SELECT DISTINCT ON (TRIM(codigo_item))
         TRIM(codigo_item)                     AS codigo_item,
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

-- ---------------------------------------------------------------------------
-- DESPUÉS: verificación.
--
--   SELECT count(*) FILTER (WHERE grupo IS NULL)     AS sin_grupo,
--          count(*) FILTER (WHERE categoria IS NULL) AS sin_subgrupo,
--          count(*)                                  AS total
--     FROM traslados_items;
--
-- Y para ver cómo queda el desglose que muestra el Dashboard:
--
--   SELECT COALESCE(NULLIF(TRIM(grupo), ''), 'Sin grupo') AS grupo,
--          count(*)                                       AS lineas,
--          round(SUM(cantidad_admin * COALESCE(NULLIF(factor,0),1)))          AS pedido_und,
--          round(SUM(COALESCE(cantidad_despachador,0) * COALESCE(NULLIF(factor,0),1))) AS despachado_und
--     FROM traslados_items
--    WHERE cantidad_despachador IS NOT NULL
--    GROUP BY 1
--    ORDER BY pedido_und DESC;
--
-- Lo que quede en NULL son códigos que el snapshot no conoce: ítems dados de baja
-- en SIESA o cargados a mano desde el Monitor. Se agrupan bajo "Sin grupo" /
-- "Sin subgrupo", que es lo correcto — inventarles una categoría sería peor.
-- ---------------------------------------------------------------------------
