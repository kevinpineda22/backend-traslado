# Consulta del snapshot en Connekta

Es la consulta que alimenta `traslados_snapshot`: inventario, disponible, consumo y
criterios de cada ítem en cada bodega de los flujos. El cron la trae entera
(`snapshot.service.js`) y todo el panel de "Nuevo despacho" lee de ahí.

- **Nombre en Connekta:** `merkahorro_traslados_dev`
- **Variable de entorno:** `CONNEKTA_QUERY_TRASLADOS`

Connekta no recibe SQL por HTTP: el endpoint `ejecutarconsulta` solo acepta el
*nombre* de una consulta registrada. Esta copia es para poder leerla y razonar
sobre ella sin entrar a SIESA — **la fuente de verdad sigue siendo la registrada**.
Si se modifica allá, actualizar esta copia en el mismo cambio.

---

## Lo que el backend da por hecho de esta consulta

Cada punto es algo de lo que depende el código. Cambiar la consulta sin revisarlos
rompe cosas en silencio.

### 1. No filtra existencia — los agotados SÍ entran

La base es `t400_cm_existencia` y el `WHERE` solo filtra compañía y bodegas. SIESA
guarda una fila por cada ítem que alguna vez se movió en una bodega y no la borra
cuando se agota, así que el snapshot incluye los ítems en cero.

Verificado con datos el 28/09/2026: la bodega `00401` (Llano) tiene 9344 ítems, de
los cuales 4132 con inventario ≤ 0.

**Depende de esto:** `getProductosLlano` y `getProductosTraslado` muestran solo los
ítems que existen en el destino. Si esta consulta empezara a filtrar
`existencia > 0`, un ítem agotado desaparecería del snapshot de la tienda y, con
él, del panel — justo lo que más hay que reponer.

### 2. Los criterios son del ÍTEM, no de la bodega

Los `t125_mc_items_criterios` se unen por `v121a_rowid_item`. Un ítem tiene el mismo
Grupo, Proveedor, CAT, etc. en todas las bodegas.

Por eso el filtro de CAT de Llano no servía para saber si un ítem "es de Llano":
si Llano no tenía el ítem, se leía el CAT del origen, y era el mismo.

### 3. Una fila por instalación

`t400` tiene una fila por (ítem, bodega, instalación), y un `LEFT JOIN` de criterios
con más de una fila para el mismo plan también duplica. El backend deduplica y suma
por (bodega, ítem) en `agregarPorBodegaItem`, así que el conteo de filas crudas no
es el conteo de ítems.

### 4. Un ítem sin fila de su unidad de orden queda FUERA del snapshot

`t122_mc_items_unidades` entra con `INNER JOIN` por la unidad de **orden**. Si un
ítem tiene una unidad de orden que no está cargada en `t122`, la consulta no lo
devuelve en ninguna bodega, y no hay ningún aviso. Si alguien reporta "este
producto no aparece en ningún lado", empezar por acá.

### 5. El estado del ítem se trae pero NO se usa

La consulta devuelve `v121a_estado_item_ext AS Estado`, pero `aRegistro`
(`snapshot.service.js`) no lo guarda. Un ítem inactivo en SIESA sigue apareciendo en
el panel. Pendiente de decidir si se filtra.

### 6. Detalles de Connekta que no se pueden tocar

- Bodegas con `OR`, **no con `IN (...)`**: Connekta lo interpreta como varias
  consultas y rechaza la paginación.
- `ORDER BY ... OFFSET 0 ROWS` al final: sin orden estable, la paginación repite
  y saltea filas y el snapshot queda agujereado (ver el `console.warn` de
  `huellaFila` en `snapshot.service.js`).
- Las bodegas del `WHERE` tienen que coincidir con `bodegasInvolucradas()` en
  `src/config/flujos.js`. Una sede nueva se agrega en los dos lados.

---

## La consulta

```sql
SELECT
    dbo.t150_mc_bodegas.f150_id_cia AS Cia,
    dbo.t285_co_centro_op.f285_id AS IDCO,
    dbo.t285_co_centro_op.f285_descripcion AS DescCO,
    dbo.t150_mc_bodegas.f150_id AS IdBodega,
    dbo.t150_mc_bodegas.f150_descripcion AS DescBodega,
    dbo.v121a.v121a_id_item AS CodigoItem,
    dbo.v121a.v121a_descripcion AS DescItem,
    dbo.v121a.v121a_id_unidad_inventario AS UM,
    dbo.t122_mc_items_unidades.f122_factor AS Factor,
    dbo.v121a.v121a_id_unidad_orden AS UMOrden,
    dbo.v121a.v121a_referencia AS Referencia,
    dbo.t122_mc_items_unidades.f122_volumen AS Volumen,
    dbo.t400_cm_existencia.f400_cant_existencia_1 - dbo.t400_cm_existencia.f400_cant_pos_1 AS CantidadDisponible,
    dbo.t400_cm_existencia.f400_cant_existencia_1 AS CantidadInventario,
    dbo.t400_cm_existencia.f400_cant_comprometida_1 AS CantidadComprometida,
    dbo.t400_cm_existencia.f400_costo_prom_uni AS CostoProm,
    GETDATE() AS Fecha,
    dbo.t200_mm_terceros.f200_id AS Nit,
    dbo.t200_mm_terceros.f200_razon_social AS RazonSocialProv,
    dbo.t202_mm_proveedores.f202_id_sucursal AS SucProv,
    dbo.t202_mm_proveedores.f202_descripcion_sucursal AS DescSucProv,
    dbo.t400_cm_existencia.f400_fecha_ult_compra AS FechaUltCompra,
    dbo.t400_cm_existencia.f400_fecha_ult_entrada AS FechaUltEntrada,
    dbo.t400_cm_existencia.f400_consumo_promedio AS ConsumoPromedio,
    dbo.v121a.v121a_estado_item_ext AS Estado,
    dbo.t400_cm_existencia.f400_id_instalacion AS IdInstalacion,
    dbo.t132_mc_items_instalacion.f132_periodo_cubrimiento AS PeriodoCubrimiento,
    dbo.t132_mc_items_instalacion.f132_mf_tamano_lote AS TamanoLote,
    dbo.t132_mc_items_instalacion.f132_costo_prom_uni AS CostoPromUnitInst,
    crit001.f125_id_plan AS Plan1,
    plan001.f105_descripcion AS DescPlan1,
    mayor001.f106_descripcion AS DescMayor1,
    crit002.f125_id_plan AS Plan2,
    plan002.f105_descripcion AS DescPlan2,
    mayor002.f106_descripcion AS DescMayor2,
    crit003.f125_id_plan AS Plan3,
    plan003.f105_descripcion AS DescPlan3,
    mayor003.f106_descripcion AS DescMayor3,
    crit004.f125_id_plan AS Plan4,
    plan004.f105_descripcion AS DescPlan4,
    mayor004.f106_descripcion AS DescMayor4,
    crit005.f125_id_plan AS Plan5,
    plan005.f105_descripcion AS DescPlan5,
    mayor005.f106_descripcion AS DescMayor5,
    crit007.f125_id_plan AS Plan7,
    plan007.f105_descripcion AS DescPlan7,
    mayor007.f106_descripcion AS DescMayor7,
    critMUA.f125_id_plan AS PlanMUA,
    planMUA.f105_descripcion AS DescPlanMUA,
    mayorMUA.f106_descripcion AS DescMayorMUA,
    critTLD.f125_id_plan AS PlanTLD,
    planTLD.f105_descripcion AS DescPlanTLD,
    mayorTLD.f106_descripcion AS DescMayorTLD,
    critSP.f125_id_plan AS PlanSP,
    planSP.f105_descripcion AS DescPlanSP,
    mayorSP.f106_descripcion AS DescMayorSP,
    critCAT.f125_id_plan AS PlanCAT,
    planCAT.f105_descripcion AS DescPlanCAT,
    mayorCAT.f106_descripcion AS DescMayorCAT,
    critTIP.f125_id_plan AS PlanTIP,
    planTIP.f105_descripcion AS DescPlanTIP,
    mayorTIP.f106_descripcion AS DescMayorTIP
FROM dbo.t400_cm_existencia
INNER JOIN dbo.t150_mc_bodegas
    ON dbo.t400_cm_existencia.f400_rowid_bodega = dbo.t150_mc_bodegas.f150_rowid
    AND dbo.t400_cm_existencia.f400_id_cia = dbo.t150_mc_bodegas.f150_id_cia
INNER JOIN dbo.t285_co_centro_op
    ON dbo.t285_co_centro_op.f285_id = dbo.t150_mc_bodegas.f150_id_co
    AND dbo.t285_co_centro_op.f285_id_cia = dbo.t150_mc_bodegas.f150_id_cia
INNER JOIN dbo.v121a
    ON dbo.t400_cm_existencia.f400_id_cia = dbo.v121a.v121a_id_cia
    AND dbo.t400_cm_existencia.f400_rowid_item_ext = dbo.v121a.v121a_rowid_item_ext
INNER JOIN dbo.t132_mc_items_instalacion
    ON dbo.t400_cm_existencia.f400_id_instalacion = dbo.t132_mc_items_instalacion.f132_id_instalacion
    AND dbo.t400_cm_existencia.f400_id_cia = dbo.t132_mc_items_instalacion.f132_id_cia
    AND dbo.t400_cm_existencia.f400_rowid_item_ext = dbo.t132_mc_items_instalacion.f132_rowid_item_ext
-- Une por la unidad de ORDEN: de ahí salen el factor de empaque y el volumen
-- del paquete. El backend divide por el factor (volumenBase) para dejar el peso
-- por unidad base, así que el peso queda igual de correcto.
INNER JOIN dbo.t122_mc_items_unidades
    ON  dbo.v121a.v121a_id_cia          = dbo.t122_mc_items_unidades.f122_id_cia
    AND dbo.v121a.v121a_rowid_item      = dbo.t122_mc_items_unidades.f122_rowid_item
    AND dbo.v121a.v121a_id_unidad_orden = dbo.t122_mc_items_unidades.f122_id_unidad
LEFT OUTER JOIN (
    dbo.t202_mm_proveedores
    INNER JOIN dbo.t200_mm_terceros
        ON dbo.t202_mm_proveedores.f202_rowid_tercero = dbo.t200_mm_terceros.f200_rowid
        AND dbo.t202_mm_proveedores.f202_id_cia = dbo.t200_mm_terceros.f200_id_cia
) ON dbo.t132_mc_items_instalacion.f132_mf_rowid_tercero_prov_1 = dbo.t200_mm_terceros.f200_rowid
  AND dbo.t132_mc_items_instalacion.f132_mf_id_sucursal_prov_1 = dbo.t202_mm_proveedores.f202_id_sucursal
LEFT JOIN dbo.t125_mc_items_criterios AS crit001
    ON dbo.v121a.v121a_id_cia = crit001.f125_id_cia
    AND dbo.v121a.v121a_rowid_item = crit001.f125_rowid_item
    AND crit001.f125_id_plan = '001'
LEFT JOIN dbo.t106_mc_criterios_item_mayores AS mayor001
    ON mayor001.f106_id_cia = crit001.f125_id_cia
    AND mayor001.f106_id_plan = crit001.f125_id_plan
    AND mayor001.f106_id = crit001.f125_id_criterio_mayor
LEFT JOIN dbo.t105_mc_criterios_item_planes AS plan001
    ON plan001.f105_id_cia = mayor001.f106_id_cia
    AND plan001.f105_id = mayor001.f106_id_plan
LEFT JOIN dbo.t125_mc_items_criterios AS crit002
    ON dbo.v121a.v121a_id_cia = crit002.f125_id_cia
    AND dbo.v121a.v121a_rowid_item = crit002.f125_rowid_item
    AND crit002.f125_id_plan = '002'
LEFT JOIN dbo.t106_mc_criterios_item_mayores AS mayor002
    ON mayor002.f106_id_cia = crit002.f125_id_cia
    AND mayor002.f106_id_plan = crit002.f125_id_plan
    AND mayor002.f106_id = crit002.f125_id_criterio_mayor
LEFT JOIN dbo.t105_mc_criterios_item_planes AS plan002
    ON plan002.f105_id_cia = mayor002.f106_id_cia
    AND plan002.f105_id = mayor002.f106_id_plan
LEFT JOIN dbo.t125_mc_items_criterios AS crit003
    ON dbo.v121a.v121a_id_cia = crit003.f125_id_cia
    AND dbo.v121a.v121a_rowid_item = crit003.f125_rowid_item
    AND crit003.f125_id_plan = '003'
LEFT JOIN dbo.t106_mc_criterios_item_mayores AS mayor003
    ON mayor003.f106_id_cia = crit003.f125_id_cia
    AND mayor003.f106_id_plan = crit003.f125_id_plan
    AND mayor003.f106_id = crit003.f125_id_criterio_mayor
LEFT JOIN dbo.t105_mc_criterios_item_planes AS plan003
    ON plan003.f105_id_cia = mayor003.f106_id_cia
    AND plan003.f105_id = mayor003.f106_id_plan
LEFT JOIN dbo.t125_mc_items_criterios AS crit004
    ON dbo.v121a.v121a_id_cia = crit004.f125_id_cia
    AND dbo.v121a.v121a_rowid_item = crit004.f125_rowid_item
    AND crit004.f125_id_plan = '004'
LEFT JOIN dbo.t106_mc_criterios_item_mayores AS mayor004
    ON mayor004.f106_id_cia = crit004.f125_id_cia
    AND mayor004.f106_id_plan = crit004.f125_id_plan
    AND mayor004.f106_id = crit004.f125_id_criterio_mayor
LEFT JOIN dbo.t105_mc_criterios_item_planes AS plan004
    ON plan004.f105_id_cia = mayor004.f106_id_cia
    AND plan004.f105_id = mayor004.f106_id_plan
LEFT JOIN dbo.t125_mc_items_criterios AS crit005
    ON dbo.v121a.v121a_id_cia = crit005.f125_id_cia
    AND dbo.v121a.v121a_rowid_item = crit005.f125_rowid_item
    AND crit005.f125_id_plan = '005'
LEFT JOIN dbo.t106_mc_criterios_item_mayores AS mayor005
    ON mayor005.f106_id_cia = crit005.f125_id_cia
    AND mayor005.f106_id_plan = crit005.f125_id_plan
    AND mayor005.f106_id = crit005.f125_id_criterio_mayor
LEFT JOIN dbo.t105_mc_criterios_item_planes AS plan005
    ON plan005.f105_id_cia = mayor005.f106_id_cia
    AND plan005.f105_id = mayor005.f106_id_plan
LEFT JOIN dbo.t125_mc_items_criterios AS crit007
    ON dbo.v121a.v121a_id_cia = crit007.f125_id_cia
    AND dbo.v121a.v121a_rowid_item = crit007.f125_rowid_item
    AND crit007.f125_id_plan = '007'
LEFT JOIN dbo.t106_mc_criterios_item_mayores AS mayor007
    ON mayor007.f106_id_cia = crit007.f125_id_cia
    AND mayor007.f106_id_plan = crit007.f125_id_plan
    AND mayor007.f106_id = crit007.f125_id_criterio_mayor
LEFT JOIN dbo.t105_mc_criterios_item_planes AS plan007
    ON plan007.f105_id_cia = mayor007.f106_id_cia
    AND plan007.f105_id = mayor007.f106_id_plan
LEFT JOIN dbo.t125_mc_items_criterios AS critMUA
    ON dbo.v121a.v121a_id_cia = critMUA.f125_id_cia
    AND dbo.v121a.v121a_rowid_item = critMUA.f125_rowid_item
    AND critMUA.f125_id_plan = 'MUA'
LEFT JOIN dbo.t106_mc_criterios_item_mayores AS mayorMUA
    ON mayorMUA.f106_id_cia = critMUA.f125_id_cia
    AND mayorMUA.f106_id_plan = critMUA.f125_id_plan
    AND mayorMUA.f106_id = critMUA.f125_id_criterio_mayor
LEFT JOIN dbo.t105_mc_criterios_item_planes AS planMUA
    ON planMUA.f105_id_cia = mayorMUA.f106_id_cia
    AND planMUA.f105_id = mayorMUA.f106_id_plan
LEFT JOIN dbo.t125_mc_items_criterios AS critTLD
    ON dbo.v121a.v121a_id_cia = critTLD.f125_id_cia
    AND dbo.v121a.v121a_rowid_item = critTLD.f125_rowid_item
    AND critTLD.f125_id_plan = 'TLD'
LEFT JOIN dbo.t106_mc_criterios_item_mayores AS mayorTLD
    ON mayorTLD.f106_id_cia = critTLD.f125_id_cia
    AND mayorTLD.f106_id_plan = critTLD.f125_id_plan
    AND mayorTLD.f106_id = critTLD.f125_id_criterio_mayor
LEFT JOIN dbo.t105_mc_criterios_item_planes AS planTLD
    ON planTLD.f105_id_cia = mayorTLD.f106_id_cia
    AND planTLD.f105_id = mayorTLD.f106_id_plan
LEFT JOIN dbo.t125_mc_items_criterios AS critSP
    ON dbo.v121a.v121a_id_cia = critSP.f125_id_cia
    AND dbo.v121a.v121a_rowid_item = critSP.f125_rowid_item
    AND critSP.f125_id_plan = 'SP'
LEFT JOIN dbo.t106_mc_criterios_item_mayores AS mayorSP
    ON mayorSP.f106_id_cia = critSP.f125_id_cia
    AND mayorSP.f106_id_plan = critSP.f125_id_plan
    AND mayorSP.f106_id = critSP.f125_id_criterio_mayor
LEFT JOIN dbo.t105_mc_criterios_item_planes AS planSP
    ON planSP.f105_id_cia = mayorSP.f106_id_cia
    AND planSP.f105_id = mayorSP.f106_id_plan
LEFT JOIN dbo.t125_mc_items_criterios AS critCAT
    ON dbo.v121a.v121a_id_cia = critCAT.f125_id_cia
    AND dbo.v121a.v121a_rowid_item = critCAT.f125_rowid_item
    AND critCAT.f125_id_plan = 'CAT'
LEFT JOIN dbo.t106_mc_criterios_item_mayores AS mayorCAT
    ON mayorCAT.f106_id_cia = critCAT.f125_id_cia
    AND mayorCAT.f106_id_plan = critCAT.f125_id_plan
    AND mayorCAT.f106_id = critCAT.f125_id_criterio_mayor
LEFT JOIN dbo.t105_mc_criterios_item_planes AS planCAT
    ON planCAT.f105_id_cia = mayorCAT.f106_id_cia
    AND planCAT.f105_id = mayorCAT.f106_id_plan
LEFT JOIN dbo.t125_mc_items_criterios AS critTIP
    ON dbo.v121a.v121a_id_cia = critTIP.f125_id_cia
    AND dbo.v121a.v121a_rowid_item = critTIP.f125_rowid_item
    AND critTIP.f125_id_plan = 'TIP'
LEFT JOIN dbo.t106_mc_criterios_item_mayores AS mayorTIP
    ON mayorTIP.f106_id_cia = critTIP.f125_id_cia
    AND mayorTIP.f106_id_plan = critTIP.f125_id_plan
    AND mayorTIP.f106_id = critTIP.f125_id_criterio_mayor
LEFT JOIN dbo.t105_mc_criterios_item_planes AS planTIP
    ON planTIP.f105_id_cia = mayorTIP.f106_id_cia
    AND planTIP.f105_id = mayorTIP.f106_id_plan
WHERE dbo.t150_mc_bodegas.f150_id_cia = 1
  AND (
    dbo.t150_mc_bodegas.f150_id = 'PV001'
    OR dbo.t150_mc_bodegas.f150_id = '00301'
    OR dbo.t150_mc_bodegas.f150_id = '00201'
    OR dbo.t150_mc_bodegas.f150_id = '00701'
    OR dbo.t150_mc_bodegas.f150_id = '00801'
    OR dbo.t150_mc_bodegas.f150_id = '00601'
    OR dbo.t150_mc_bodegas.f150_id = '00401'
  )
ORDER BY dbo.t150_mc_bodegas.f150_id,
         dbo.v121a.v121a_id_item,
         dbo.t400_cm_existencia.f400_id_instalacion
OFFSET 0 ROWS
```
