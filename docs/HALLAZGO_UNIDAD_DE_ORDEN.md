# Hallazgo — SIESA dejó de traer la unidad de orden (el selector de UM se quedó sin datos)

> **Para:** quien mantiene la consulta `merkahorro_traslados_dev` en Connekta, y Johan.
> **De:** Juan Manuel.
> **Fecha:** 2026-08-03.
>
> **Resumen:** el selector de UM del panel no desapareció por un cambio de código.
> Se quedó **sin opciones que ofrecer**: hoy SIESA reporta la unidad de orden igual
> a la unidad base para el **100% de los ítems**, con factor 1.
>
> No hay que tocar el frontend. Hay que averiguar por qué cambió el dato.

---

## 1. La evidencia

Consultas de solo lectura contra `traslados_snapshot` (61.955 filas):

| Chequeo | Resultado |
|---|---|
| Filas con `factor <> 1` | **0 de 61.955** |
| Filas con `um_orden` distinta de `um` | **0** |
| `um_orden` = `'UND'` | en las 61.955 |

Y el mismo ítem que Johan usó para cerrar B2b, hoy:

| Ítem | Johan lo vio | Hoy |
|---|---|---|
| AZUCAR X 500 GR | `factor=100`, `volumen=50.000` | `factor=1`, `volumen=500` |

O sea: antes el dato venía por **paquete de 100 bolsas** (50 kg) y hoy viene por
**bolsa** (500 g). Los dos son correctos para su unidad — lo que cambió es a qué
unidad se refieren.

---

## 2. Por qué eso apaga el selector

`buildUnidades` (`siesa.service.js`) solo ofrece una segunda unidad si existe una
unidad de orden **distinta** de la base y con factor **distinto de 1**:

```js
const unidades = [{ unidad: base, factor: 1 }];
if (orden && orden !== base && factor !== 1) {
  unidades.push({ unidad: orden, factor });   // ← nunca se ejecuta hoy
}
```

Con `um_orden === um` y `factor === 1` en todas las filas, la lista siempre tiene
un solo elemento, y el front muestra la UM como texto fijo en vez de un `<select>`.

El código está bien. Le falta el dato.

---

## 3. CONFIRMADO: cambió la consulta

La consulta `merkahorro_traslados_dev` tiene hoy este JOIN:

```sql
-- JOIN CORREGIDO A UNIDAD DE INVENTARIO:
INNER JOIN dbo.t122_mc_items_unidades
    ON  dbo.v121a.v121a_id_cia              = dbo.t122_mc_items_unidades.f122_id_cia
    AND dbo.v121a.v121a_rowid_item          = dbo.t122_mc_items_unidades.f122_rowid_item
    AND dbo.v121a.v121a_id_unidad_inventario = dbo.t122_mc_items_unidades.f122_id_unidad
```

Se cambió `v121a_id_unidad_orden` por `v121a_id_unidad_inventario`.

**Por qué se hizo, y por qué ya no hace falta.** Al unir por la unidad de
inventario, `f122_volumen` pasa a ser el peso de UNA unidad (500 g para la bolsa de
500 g) en vez del peso del paquete. O sea: fue un arreglo del PESO.

Pero ese mismo problema ya está resuelto en el backend, en `volumenBase`
(`siesa.service.js`), que divide por el factor. Se arregló dos veces lo mismo, y la
segunda vez costó el `Factor` — porque unir contra la unidad base da factor 1
siempre, y sin factor no hay segunda unidad que ofrecer.

### El arreglo

```sql
-- Une por la unidad de ORDEN: de ahí salen el factor de empaque y el volumen del
-- paquete. El backend divide por el factor (volumenBase) para dejar el peso por
-- unidad base, así que el peso queda igual de correcto.
INNER JOIN dbo.t122_mc_items_unidades
    ON  dbo.v121a.v121a_id_cia          = dbo.t122_mc_items_unidades.f122_id_cia
    AND dbo.v121a.v121a_rowid_item      = dbo.t122_mc_items_unidades.f122_rowid_item
    AND dbo.v121a.v121a_id_unidad_orden = dbo.t122_mc_items_unidades.f122_id_unidad
```

Es volver al JOIN que corrió durante meses con 61.955 filas — no es un experimento.

**Después de aplicarlo:** refrescar el snapshot (botón «Actualizar ahora» o el cron)
y verificar con el azúcar por 500 g: `factor` debe volver a 100 y `volumen` a 50.000.
El peso mostrado tiene que seguir dando 500 g por unidad.

---

## 3.1. Cómo se había planteado el diagnóstico (dos hipótesis)

La consulta hace el JOIN por la unidad de orden del ítem:

```sql
INNER JOIN dbo.t122_mc_items_unidades
    ON  dbo.v121a.v121a_id_cia        = dbo.t122_mc_items_unidades.f122_id_cia
    AND dbo.v121a.v121a_rowid_item    = dbo.t122_mc_items_unidades.f122_rowid_item
    AND dbo.v121a.v121a_id_unidad_orden = dbo.t122_mc_items_unidades.f122_id_unidad
```

Ese JOIN es correcto. Entonces, o cambió la consulta, o cambió el maestro:

**Hipótesis A — el maestro cambió.** A los ítems se les puso
`v121a_id_unidad_orden = 'UND'`. Es la más probable: el JOIN sigue escrito igual y
el dato que llega es coherente con una unidad de orden que ahora ES la base.

**Hipótesis B — la consulta cambió** y ahora resuelve por la unidad de inventario.

**Cómo distinguirlas** — correr esto en SIESA para un ítem con empaque conocido
(el azúcar por 500 g, código 31 o 177725):

```sql
SELECT v121a_id_item,
       v121a_id_unidad_inventario AS UM_base,
       v121a_id_unidad_orden      AS UM_orden
FROM dbo.v121a
WHERE v121a_id_item = '0000031';
```

- Si `UM_orden` = `UND` → **hipótesis A**: el maestro. Hay que revisar por qué se
  cambió y si corresponde revertirlo.
- Si `UM_orden` = algo como `P100` → **hipótesis B**: el problema está en la
  consulta registrada en Connekta.

---

## 4. Lo que NO se rompe al arreglarlo

`volumenBase` normaliza el peso dividiendo por el factor, y eso da el **mismo
resultado en los dos escenarios**:

```
HOY    factor=1,   volumen=500    → 500 g por unidad
ANTES  factor=100, volumen=50.000 → 500 g por unidad
```

Así que se puede corregir el origen sin tocar ni revisar el cálculo de peso. Fue
suerte de haber normalizado en el borde: si el `÷ factor` estuviera repartido por
las pantallas, este cambio de datos habría dado pesos ×100 en algunas y no en otras.

---

## 5. Un límite que conviene tener claro

Aunque se recupere la unidad de orden, el selector va a ofrecer **como máximo dos
opciones**: la base y la de orden. Un ítem con tres presentaciones (UND / P6 / P12)
seguiría mostrando solo dos.

La razón es estructural: la consulta trae **una fila por ítem** de
`t122_mc_items_unidades` (la del JOIN), y `traslados_snapshot` guarda **una fila por
(bodega, ítem)** — no hay dónde poner varias unidades. Ofrecer todas las
presentaciones exige traer todas las filas de `t122` y guardarlas aparte.

Ya estaba anotado como pendiente en `ARQUITECTURA.md` §11:

> «Switch de UM completo: verificar `t122_mc_items_unidades` y, si hay varias
> presentaciones por item, ampliar el query.»

En el flujo **Llano** esto ya está resuelto por otro camino: las UM salen del Excel
de Capacidad (`traslados_capacidad`), que sí admite varias por ítem — y por eso los
huevos aparecen en P15 y en P30. Ahí cada UM es una **fila propia** con su capacidad
y su sugerido, en vez de un selector.

---

## 6. Qué hay que hacer

1. **Restaurar el JOIN por `v121a_id_unidad_orden`** en la consulta registrada
   (§3). Es una línea.
2. **Refrescar el snapshot** y verificar con el azúcar por 500 g: `factor` → 100,
   `volumen` → 50.000, y el peso mostrado sigue en 500 g por unidad.
3. No hay que desplegar nada del backend ni del frontend.

---

## 7. La lección, para que no vuelva a pasar

El mismo problema —el peso venía por paquete— se arregló **dos veces y en dos
lugares**: una en el backend (`volumenBase`, dividiendo por el factor) y otra en la
consulta (cambiando el JOIN). Ninguno de los dos arreglos sabía del otro.

El de la consulta parecía más simple y resolvía el síntoma, pero se llevó puesto un
dato del que dependía otra cosa. Y no falló ruidosamente: el peso siguió correcto,
así que nadie lo notó hasta que alguien fue a usar el selector de UM.

> Antes de "corregir" el origen de un dato, conviene mirar quién más lo consume. Un
> campo que parece redundante para un cálculo puede ser el único insumo de otro.

Es el mismo patrón de todos los problemas de este módulo: **nada revienta**.
