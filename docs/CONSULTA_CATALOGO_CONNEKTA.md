# Consulta del catálogo en Connekta

Es la consulta que alimenta `traslados_catalogo`: la lista de ítems ACTIVOS de SIESA
(código, descripción, referencia, unidades, grupo y subgrupo), sin inventario. La
trae un job (`catalogo.service.js`, `scripts/refresh-catalogo.js`) y sirve para:

- **Buscar** el producto que un administrador va a agregar al portafolio de una sede
  (`GET /api/catalogo?q=`).
- **Validar** que el ítem existe y está activo antes de agregarlo
  (`POST /api/portafolio-extra`).
- **Dar descripción y UM** a un producto "extra" que no tiene fila en el snapshot (la
  sede nunca lo movió y el origen tampoco lo tiene): ver `filaDesdeCatalogo` en
  `siesa.service.js`.

- **Nombre en Connekta:** `merkahorro_catalogo_activo`
- **Variable de entorno:** `CONNEKTA_QUERY_CATALOGO` (por defecto, el nombre de arriba)
- **Parámetros:** ninguno (Connekta solo expone consultas dinámicas sin parámetros)
- **Tamaño:** ~23.071 filas, ~24 páginas de 1000 (`tamPag` 1000 es el máximo que acepta)

Connekta no recibe SQL por HTTP: el endpoint `ejecutarconsulta` solo acepta el
*nombre* de una consulta registrada. Esta copia es para poder leerla y razonar sobre
ella sin entrar a SIESA — **la fuente de verdad sigue siendo la registrada**. Si se
modifica allá, actualizar esta copia en el mismo cambio. Mismo criterio que
`docs/CONSULTA_SNAPSHOT_CONNEKTA.md`.

---

## Lo que el backend da por hecho de esta consulta

### 1. Solo ítems activos (`Estado = 1`)

El `WHERE` filtra `v121a_estado_item_ext = 1`. Un ítem que se inactiva en SIESA
desaparece de la consulta y, en el siguiente refresco, de `traslados_catalogo` (el
prune borra lo que el refresco no vio). `POST /api/portafolio-extra` rechaza además
cualquier fila con `estado` distinto de 1, por si algún día se relaja el filtro.

### 2. Un `CodigoItem` puede repetirse

`v121a` tiene una fila por **extensión** del ítem, y los `LEFT JOIN` de criterios
multiplican filas si un ítem tiene más de un valor en el mismo plan. El catálogo es por
ítem, así que `dedupePorCodigo` conserva la PRIMERA fila de cada código (por eso las
páginas se guardan en su posición y no en orden de llegada: el "primero" tiene que ser
el mismo en cada refresco).

El código se guarda con el normalizador único (`src/config/codigoItem.js`): texto, sin
espacios y SIN ceros a la izquierda (`"0003851"` → `"3851"`; solo ceros → `"0"`). Lo
comparten el catálogo, el portafolio extra y la guardia del ajuste de inventario; contra
`traslados_snapshot` (que guarda el código tal cual lo da SIESA) la guardia prueba la forma
cruda y la normalizada.

### 3. `ORDER BY … OFFSET 0 ROWS` al final

Sin orden estable la paginación repite y saltea filas, y el catálogo queda agujereado
(ver el comentario largo de `config/connekta.js` y el punto 6 de
`CONSULTA_SNAPSHOT_CONNEKTA.md`). El `OFFSET 0 ROWS` es obligatorio: Connekta envuelve
la consulta en una subconsulta y SQL Server prohíbe `ORDER BY` ahí sin `TOP/OFFSET`.
La llave de orden es `(v121a_id_item, v121a_rowid_item_ext)`, única por fila.

### 4. Columnas que lee `aRegistroCatalogo`

| Columna | Va a `traslados_catalogo` | Nota |
|---------|---------------------------|------|
| `CodigoItem` | `codigo_item` (PK, texto) | obligatoria; sin ella la fila se descarta |
| `RowidItemExt` | `rowid_item_ext` | |
| `DescItem` | `descripcion` | |
| `Referencia` | `referencia` | |
| `UM` | `um` | unidad de inventario |
| `UMOrden` | `um_orden` | unidad de orden |
| `Estado` | `estado` | 1 = activo |
| `IdGrupo` / `Grupo` | `id_grupo` / `grupo` | plan de criterios 001 |
| `IdSubgrupo` / `Subgrupo` | `id_subgrupo` / `subgrupo` | plan de criterios 002 |

### 5. Detalles de Connekta que no se pueden tocar

- Sin `IN (...)` ni parámetros: Connekta los interpreta como varias consultas y rechaza
  la paginación.
- **Connekta rechaza o trunca las consultas largas** (ver el punto 6 del snapshot). Esta
  mide mucho menos, pero la regla es la misma: mantenerla compacta.

### 6. Guardas del refresco (antes de borrar nada)

| Guarda | Regla | Variable |
|--------|-------|----------|
| Completitud | filas traídas >= 95% de las que Connekta declara | `CATALOGO_MIN_COMPLETITUD` |
| Regresión | ítems del pull >= 80% de las filas que ya hay | `CATALOGO_MIN_REGRESION` |
| Vacío | un pull sin ítems nunca es válido | — |

Si una falla, el refresco aborta con `CatalogoIncompletoError` (409) y la tabla queda
intacta. Solo con las guardas superadas y todo el upsert escrito se borran las filas con
`sincronizado_at` anterior al inicio del refresco. Cada refresco deja una línea en
`traslados_catalogo_log` (resultado `ok` / `abortado` / `error`).

---

## Cómo se corre

- **Diario:** `.github/workflows/catalogo-refresh.yml` (02:30 hora de Colombia) y a mano
  con `workflow_dispatch`. Usa los mismos secretos que `snapshot-refresh.yml` más
  `CONNEKTA_QUERY_CATALOGO` (opcional si se usa el nombre por defecto).
- **Botón:** `POST /api/catalogo/refresh` dispara ese workflow (misma configuración
  `GITHUB_DISPATCH_TOKEN` / `GITHUB_REPO`; el archivo se puede cambiar con
  `GITHUB_WORKFLOW_CATALOGO`). Sin esa configuración corre el pull inline.
- **Primera vez:** correr la migración `sql/043_portafolio_extra.sql` y después un
  refresco. Hasta entonces el catálogo está vacío y no se puede agregar ningún ítem.

---

## La consulta

> Los `LEFT JOIN` de los planes `001` y `002` siguen exactamente el mismo patrón que
> los de `merkahorro_traslados_dev` (ver `CONSULTA_SNAPSHOT_CONNEKTA.md`): `crit` une el
> ítem con su criterio del plan, `mayor` trae la descripción del criterio mayor.

```sql
SELECT
dbo.v121a.v121a_id_item AS CodigoItem,
dbo.v121a.v121a_rowid_item_ext AS RowidItemExt,
LTRIM(RTRIM(dbo.v121a.v121a_descripcion)) AS DescItem,
LTRIM(RTRIM(dbo.v121a.v121a_referencia)) AS Referencia,
LTRIM(RTRIM(dbo.v121a.v121a_id_unidad_inventario)) AS UM,
LTRIM(RTRIM(dbo.v121a.v121a_id_unidad_orden)) AS UMOrden,
dbo.v121a.v121a_estado_item_ext AS Estado,
LTRIM(RTRIM(mayor001.f106_id)) AS IdGrupo,
LTRIM(RTRIM(mayor001.f106_descripcion)) AS Grupo,
LTRIM(RTRIM(mayor002.f106_id)) AS IdSubgrupo,
LTRIM(RTRIM(mayor002.f106_descripcion)) AS Subgrupo
FROM dbo.v121a
LEFT JOIN dbo.t125_mc_items_criterios AS crit001
ON dbo.v121a.v121a_id_cia = crit001.f125_id_cia
AND dbo.v121a.v121a_rowid_item = crit001.f125_rowid_item
AND crit001.f125_id_plan = '001'
LEFT JOIN dbo.t106_mc_criterios_item_mayores AS mayor001
ON mayor001.f106_id_cia = crit001.f125_id_cia
AND mayor001.f106_id_plan = crit001.f125_id_plan
AND mayor001.f106_id = crit001.f125_id_criterio_mayor
LEFT JOIN dbo.t125_mc_items_criterios AS crit002
ON dbo.v121a.v121a_id_cia = crit002.f125_id_cia
AND dbo.v121a.v121a_rowid_item = crit002.f125_rowid_item
AND crit002.f125_id_plan = '002'
LEFT JOIN dbo.t106_mc_criterios_item_mayores AS mayor002
ON mayor002.f106_id_cia = crit002.f125_id_cia
AND mayor002.f106_id_plan = crit002.f125_id_plan
AND mayor002.f106_id = crit002.f125_id_criterio_mayor
WHERE dbo.v121a.v121a_id_cia = 1
AND dbo.v121a.v121a_estado_item_ext = 1
ORDER BY dbo.v121a.v121a_id_item,
dbo.v121a.v121a_rowid_item_ext
OFFSET 0 ROWS
```
