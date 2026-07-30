# Respuesta — B1 cerrado, y B2 tenía una vuelta más

> **Para:** Johan.
> **De:** Juan Manuel (backend).
> **Fecha:** 2026-07-30.
> **Responde a:** `HANDOFF_ALERTAS_AWAIT_Y_VOLUMEN.md`.
>
> **Resumen:** B1 tenías toda la razón, era mío y ya está. B2 también tenías razón
> en que hay un bug — pero **tu arreglo tampoco daba bien**, y la razón es que la
> unidad por defecto del carrito no es la que suponíamos ninguno de los dos.
>
> Y algo más incómodo: los dos estuvimos razonando sobre un comentario que
> **escribí yo especulando**. Vale la pena decirlo antes de darlo por cerrado.

---

## 0. Estado

| # | Tarea | Estado |
|---|-------|--------|
| B1 | `await` en el estampado | ✅ **Hecho** (§1) |
| B2 | `× factor` de más en el volumen | ✅ **Arreglado, distinto a lo propuesto** (§2) |
| B2b | Verificar `f122_volumen` contra datos reales | ⬜ **Pendiente — no lo puede cerrar ninguno de los dos por deducción** (§3) |

---

## 1. B1 — `await`: tenías razón, y era peor de lo que parece

Arreglado en `auditor.controller.js`. Un `await`, con el `.catch()` que ya estaba,
así que sigue sin poder tirar.

Lo que más me convenció no fue el costo sino **el perfil de falla que describís**:
anda perfecto en local porque el proceso sigue vivo, y falla de a ratos en Vercel
sin patrón. Es el tipo de bug que se valida OK, se despliega tranquilo y aparece a
la semana en el piso — y encima anulando justo la protección que acabábamos de
poner. Un `await` de 100 ms en un `GET` que el auditor hace una vez al abrir no se
discute contra eso.

También tenés razón en que era una **inconsistencia**, no un criterio: en
`compararAuditoria` ya lo tenía con `await`. Los dos call sites quedaron iguales, y
dejé el porqué escrito en el código para que nadie lo "limpie" pensando que sobra.

---

## 2. B2 — El bug existe, pero el arreglo no era sacar el `× factor`

### Dónde no cierra tu razonamiento

Tu argumento es:

> `cantidad` ya está expresada en esa misma unidad (`cantidad_admin` y
> `cantidad_despachador` viven en la UM del renglón)

Es cierto que viven en la UM del renglón. Lo que no es cierto es que esa UM sea la
**unidad de orden**. Mirá `buildUnidades` (`siesa.service.js`):

```js
const unidades = [{ unidad: base, factor: 1 }];          // ← primera
if (orden && orden !== base && factor !== 1) {
  unidades.push({ unidad: orden, factor });               // ← segunda
}
```

Y en `TablaProductosSiesa.jsx`:

```js
const baseFactor = (p) => cantidades[rk(p)]?.factor ?? umDetalle(p)[0]?.factor ?? 1;
```

`umDetalle(p)[0]` es la **unidad base, con factor 1**. O sea: **la unidad por defecto
del carrito es la base, no la de orden.** El admin puede cambiarla a la de orden,
pero mientras no lo haga, `cantidad` está en unidades sueltas y `factor` vale 1.

### Qué pasaba con cada fórmula

Con un ítem en P48 (factor de orden 48) y `volumen` = volumen del paquete:

| Cantidad del carrito | Fórmula actual (`v×c×f`) | Tu propuesta (`v×c`) | Correcto |
|---|---|---|---|
| 10, en unidad **base** (f=1) | 10 × v_paquete ❌ | 10 × v_paquete ❌ | 10 × v_paquete/48 |
| 2, en unidad **de orden** (f=48) | 96 × v_paquete ❌ | 2 × v_paquete ✅ | 2 × v_paquete |

O sea: tu fórmula arregla el caso de la unidad de orden y **deja roto el caso por
defecto**, que es el más común. La actual estaba mal en los dos.

### El arreglo que puse

Normalizar el volumen a **unidad base en el backend**, que es donde se conoce el
factor de orden del snapshot:

```js
// siesa.service.js
volumenBase(row) = row.volumen / (row.factor || 1)
```

Y el frontend queda con **una sola fórmula que vale para cualquier unidad elegida**:

```
volumen_total = volumen_base × cantidad × factor_de_la_unidad_elegida
```

- Si despacha en unidades base (factor 1) → volumen de una unidad. ✅
- Si despacha en la de orden (factor N) → N × v_base reconstruye el paquete. ✅

El frontend **no cambió**: su fórmula ya era esa. Lo que cambió es qué significa el
campo que recibe. Los 11 tests de `volumenTraslado.js` siguen verdes porque la
función pura no se tocó.

---

## 3. B2b — Lo que ninguno de los dos puede cerrar deduciendo

Acá quiero ser claro porque me parece importante.

Vos citaste como respuesta el comentario de mi migración `014`:

> "es el volumen de UN paquete de la unidad de orden, no necesariamente el de UNA
> unidad base"

**Ese comentario lo escribí yo especulando**, no verificando. Era una inferencia por
la forma del JOIN, con el "no necesariamente" puesto justamente porque no lo sabía.
Así que cuando me lo devolvés como confirmación, estamos los dos apoyándonos en la
misma suposición sin dato nuevo en el medio. No es que esté mal razonado — es que no
es evidencia.

**Lo que sí es evidencia estructural** y me hace inclinar por la hipótesis del
paquete: la columna vive en `t122_mc_items_unidades`, una tabla cuyas filas **son**
unidades de medida con su factor. Un `f122_volumen` ahí describe naturalmente el
volumen *de esa unidad*. Es un argumento mejor que el JOIN, pero sigue sin ser el dato.

**Cómo se cierra de verdad**, y recién se puede ahora:

1. Correr la `014` y refrescar el snapshot (hasta hoy la columna no existía, por eso
   nadie pudo mirar).
2. Buscar un ítem con `factor > 1` y comparar el `volumen` contra uno físicamente
   parecido con `factor = 1`.

```sql
SELECT codigo_item, descripcion, um, um_orden, factor, volumen
FROM traslados_snapshot
WHERE volumen IS NOT NULL AND factor > 1
ORDER BY factor DESC
LIMIT 20;
```

Si para un P48 el `volumen` es ~48 veces el de un ítem suelto comparable, es por
paquete y lo que puse está bien. Si es del mismo orden de magnitud, viene por unidad
base y **hay que sacar la división** de `volumenBase` — una línea, y el frontend
tampoco se entera.

Dejé eso escrito en el código, en `volumenBase`, con el "⚠️ pendiente de verificar"
y qué tocar según el resultado.

---

## 4. Sobre tu propuesta de `ARQUITECTURA.md`

De acuerdo, y creo que es lo más valioso de todo este ida y vuelta. Tres veces nos
mordió el `factor` en lugares distintos: `diferencia`, la comparación del auditor, y
ahora el volumen. Siempre la misma causa — cruzar dos números que viven en unidades
distintas.

Propongo que la regla quede así de corta:

> **Toda columna que guarde una cantidad declara en qué unidad está.** Cruzar dos
> cantidades de unidades distintas exige pasar por el factor, y la conversión se hace
> UNA vez, en el borde que conoce el factor — no en cada consumidor.

Lo de "en el borde" es lo que hicimos con `volumenBase`: normalizar en el backend en
vez de que cada pantalla se acuerde de dividir. Si querés lo escribo yo en
`ARQUITECTURA.md` con la tabla de qué unidad guarda cada columna
(`cantidad_admin`, `cantidad_despachador`, `cantidad_auditor`, `volumen`, `factor`),
que es la parte que hoy hay que deducir leyendo código.

---

## 5. Orden de despliegue (sin cambios respecto al tuyo)

1. ~~`013`~~ ✅
2. `014_volumen_item.sql`
3. `015_auditoria_abierta.sql`
4. `012_backfill_diferencia_und.sql` — tuya
5. Desplegar backend (ya con B1 y B2)
6. Refrescar snapshot
7. **Mirar los datos de volumen** (§3) antes de confiar en el total
8. Prender alertas de a una: `recoleccion` → `auditoria` → `inactivar`

Tu checklist de B1 (§5 de tu handoff) queda tal cual: hay que probarlo **contra el
deploy** y repetirlo 5 o 6 veces, porque en local pasa igual con `await` y sin él.

---

## 6. Cierre

B1 y B2 cerrados en código. Lo único que queda abierto es B2b, y es una consulta a
la base — no una decisión de diseño.

Gracias por el segundo pase. El `await` no lo veía, y era el que hacía que todo el
arreglo del auditor funcionara solo en mi máquina.
