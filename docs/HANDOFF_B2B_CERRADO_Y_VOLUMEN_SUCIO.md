# Handoff — B2b cerrado: tu división está bien, pero el dato de SIESA está sucio

> **Para:** Juan Manuel (backend).
> **De:** Johan.
> **Fecha:** 2026-07-30.
> **Responde a:** `RESPUESTA_AWAIT_Y_VOLUMEN.md`.
>
> **Resumen:** B1 verificado en producción y B2b cerrado con datos: `f122_volumen`
> **es por paquete**, así que `volumenBase` está bien y no hay que tocarla.
>
> Pero al mirar los datos apareció otra cosa: **el maestro de SIESA tiene el volumen
> mal cargado en muchos ítems**, y la forma en que está escrito `volumenTotal` hace
> que eso pase inadvertido. Un despacho de huevos daría total 0 con el cartel de
> "datos completos".

---

## 0. Estado

| # | Tarea | Estado |
|---|-------|--------|
| B1 | `await` en el estampado | ✅ **Verificado en producción** (§1) |
| B2 | `volumenBase` | ✅ **Confirmado correcto** — no tocar (§2) |
| B2b | Verificar `f122_volumen` | ✅ **Cerrado** (§2) |
| **D1** | **`volumen = 0` se cuenta como dato bueno** | 🔴 **Nuevo** (§3) |
| **D2** | **Volumen mal cargado en dos categorías del maestro** | 🟡 **Nuevo — se arregla en SIESA, no en código** (§4) |

---

## 1. B1 verificado

Seis llamadas a `GET /api/auditor/despachos/:id` contra el deploy, espaciadas 4
segundos, sobre despachos en estado terminal. Las seis devolvieron `200` y **las seis
estamparon `auditoria_abierta_at`**, con timestamps separados ~4,8 s. Cero pérdidas.

El `await` está haciendo efecto en Vercel. La protección del auditor funciona.

---

## 2. B2b — Es por paquete. Tu división está bien.

No hizo falta la consulta a Connekta: los datos del snapshot alcanzaron.

Recordá que `snapshot.service.js:144` guarda el valor **crudo** (`volumen: num(o.Volumen)`);
la división de `volumenBase` ocurre recién al servir `/siesa/productos`. Así que
mirando `traslados_snapshot.volumen` se ve el `f122_volumen` original.

| Producto | factor | crudo | ÷ factor | ¿Sirve para 1 unidad? |
|---|---|---|---|---|
| AZUCAR MERKAHORRO **X 500 GR** | 100 | 50.000 | **500** | ✅ 500 ml para una bolsa de 500 g |
| CALDO RICOSTILLA X 60 C **630GR** | 60 | 630 | **10,5** | ✅ un cubito |

**El azúcar lo define**: 50.000 = 100 × 500, exactamente el contenido de un paquete
de 100 bolsas de 500 g. Y el caldo confirma: 630 crudo para una caja de 60 cubitos
cuyo peso total es justamente 630 g.

La hipótesis contraria se cae sola: si el volumen viniera por unidad base, una bolsa
de azúcar de 500 g ocuparía **50 litros**.

**Conclusión: `f122_volumen` es el volumen del paquete de la unidad de orden.
`volumenBase` está bien. Podés sacar el `⚠️ pendiente de verificar` del comentario.**

---

## 3. D1 — `volumen = 0` entra al total como dato bueno 🔴

Este es el que urge.

### Lo que pasa

```sql
SELECT codigo_item, descripcion, factor, volumen FROM traslados_snapshot
 WHERE volumen = 0;
```

Devuelve, entre otros:

| codigo_item | descripcion | factor | volumen |
|---|---|---|---|
| 175226 | CALDO KNORR X 1 UND | 48 | **0** |
| 178779 | BOMBON ITALO X UND | 10 | **0** |
| 174878 | **HUEVO BLANCO AAA X UND** | 30 | **0** |

Huevos ocupando cero.

### Por qué no se nota

En `volumenDeItem`, un `0` no es `null`: pasa el guard, y la función devuelve `0`.

```js
if (volumen == null || volumen === "") return null;   // 0 NO entra acá
const v = Number(volumen);
if (!Number.isFinite(v) || v < 0) return null;        // 0 tampoco: no es < 0
return v * c * f;                                      // → 0
```

Y en `volumenTotal`, como no es `null`, **cuenta como `conDato`**:

```js
if (v == null) sinDato += 1;
else { total += v; conDato += 1; }   // ← el 0 cae acá
```

Resultado: un despacho de puros ítems con volumen 0 devuelve `total: 0`,
`sinDato: 0` y **`completo: true`**. El panel muestra el cartel verde de datos
completos sobre un total que es mentira.

Es exactamente la falla que `sinDato` fue diseñado para evitar, entrando por la
puerta que quedó abierta: **`sinDato` cuenta ausencias, no mentiras.**

### El dato que lo vuelve urgente: NO hay un solo `NULL`

```
sin_dato | en_cero | dudosos | creibles | items_distintos
---------+---------+---------+----------+----------------
       0 |      31 |     152 |    64890 |           16060
```

**`sin_dato = 0`.** En 65.073 filas no hay un solo `NULL`. SIESA nunca devuelve
vacío: cuando no tiene el dato manda `0`.

O sea que hoy la rama `null` de `volumenDeItem` **nunca se ejecuta**, y `sinDato`
**siempre vale 0**. La red de seguridad está bien construida y desconectada — no
porque esté mal escrita, sino porque el caso que espera no llega nunca.

Por eso D1 no es solo tapar unos ítems: **es lo que enciende el contador que ya
existe.** Una línea, y el mecanismo empieza a funcionar.

### La decisión de la 014, revisada

La migración dice, y era razonable:

> `NULL` = "SIESA no tiene el volumen de este ítem" y `0` = "ocupa cero", que no es
> lo mismo.

La distinción está bien pensada. El problema es que **SIESA no la respeta**: emite `0`
para ítems que evidentemente ocupan lugar. Y "ocupa cero" no existe como caso real —
ningún producto físico ocupa cero.

### Propuesta

Tratar el `0` como ausencia de dato, en el borde:

```js
// volumenBase — siesa.service.js
// Ningún producto físico ocupa cero: un 0 de SIESA es "no lo cargaron", no "no
// ocupa lugar". Se devuelve null para que el panel lo cuente como sin dato en vez
// de sumarlo como cero y dar un total completo que miente.
if (!(v > 0)) return null;
```

Es un cambio de una línea y el frontend no se entera: ya sabe manejar `null`.

---

## 4. D2 — El volumen está mal cargado en dos categorías 🟡

Además de los ceros hay una familia de valores diminutos (0,02 a 0,9 ml por unidad)
que **no los arregla D1** —no son cero— y **tampoco los ve `sinDato`** —no son null—.
Entran al total como números válidos y chiquitos.

Pero al sacar la lista completa apareció algo que cambia el enfoque: **no son ítems
sueltos al azar, son dos categorías enteras del maestro.**

### La escala, y por qué NO propongo construir un contador

Medimos: **53 productos distintos con problema, sobre 16.060. El 0,33%.**

Le había propuesto a Johan un tercer contador (`dudoso`) con un piso configurable
junto a `sinDato`. **Me desdigo: para 53 productos eso es sobre-ingeniería** — un
umbral arbitrario que hay que mantener para cazar el 0,3% de los casos.

Y sobre todo, porque el problema **no está desperdigado: está agrupado en dos
categorías del maestro**, y eso lo hace arreglable de raíz.

### Los ceros son la categoría de FRESCOS

| Producto | factor | volumen |
|---|---|---|
| TRUCHA X 2 UND · MIXTURA MARISCOS A GRANEL | 1 | 0 |
| POLLO CAMPO · PRESAS MIXTAS · ALAS BLANCAS · POLLO CON VÍSCERAS | 1 | 0 |
| HUEVO BLANCO AAA | 30 | 0 |
| HUEVO GRANJERITO (×4 presentaciones) | 1 | 0 |
| MANGOSTINO · CARAMBOLO · FRESA · RAÍZ CHINA | 1 | 0 |

Carnes, pollo, pescado, huevos, frutas y verduras. **A la categoría de frescos nunca
le cargaron el volumen.**

Esto no es marginal: **el pollo, los huevos y la fruta son justamente lo que llena un
camión.** Un traslado de frescos hoy mostraría total 0 con el cartel de "datos
completos".

### Los dudosos son la categoría de FARMACIA y CAJA

| Producto | factor | volumen |
|---|---|---|
| ADVIL · DOLEX · ASPIRINA · ACETAMINOFEN · APRONAX · SEVEDOL · LUMBAL · BUSCAPINA | 6-28 | **1** ó **2** |
| NORAVER (×5 sabores) · ALKA SELTZER · BONFIEST · SAL DE FRUTAS · GASTROFAST | 6-14 | **1** |
| CHICLE CHICLETS · GALLETAS FESTIVAL · REFAJO LATA · PANZEROTTI | 6-100 | **1** ó **2** |

Fijate el patrón: el valor es **exactamente `1`** con factores 6, 8, 10, 12 y 14. Eso
no es un volumen medido, es **un placeholder cargado para toda la categoría**. (El
chicle vale `2`, igual que el "X 2 UND" del nombre — ahí alguien copió la cantidad
del empaque.)

### Propuesta: arreglar el maestro, no el código

Es una lista de 53 productos agrupados en dos categorías. Eso lo revisa una persona
en una tarde con quien maneje el maestro de SIESA — y queda arreglado para todos los
consumidores del dato, no solo para nuestro panel.

```sql
SELECT DISTINCT codigo_item, descripcion, factor, volumen,
       ROUND(volumen / NULLIF(factor,0), 4) AS volumen_unitario
FROM traslados_snapshot
WHERE volumen = 0
   OR (volumen > 0 AND volumen / NULLIF(factor,0) < 1)
ORDER BY volumen_unitario, codigo_item;
```

Si más adelante la basura crece o reaparece, ahí sí construimos el contador — pero
con datos que justifiquen el umbral, no eligiéndolo a ojo hoy.

**Con D1 puesto, mientras tanto, los 31 ceros pasan a contarse como `sinDato` y el
panel ya avisa por ellos.** Los 152 dudosos quedan entrando al total hasta que se
corrija el maestro; son chicos y no distorsionan tanto como un cero.

### Una salvedad honesta

El corte de "1 ml por unidad" es arbitrario. Los 64.890 "creíbles" **no están
verificados**, solo pasaron ese filtro: puede haber datos malos con valores
plausibles que ninguna consulta detecta. Lo único que sabemos con certeza es que los
outliers son pocos y están agrupados.

---

## 5. Qué queda

| # | Qué | Quién | Prioridad |
|---|-----|-------|-----------|
| D1 | `volumen = 0` → `null` en `volumenBase` (una línea) | Juan Manuel | 🔴 |
| — | Sacar el `⚠️ pendiente de verificar` de `volumenBase` | Juan Manuel | 🟢 |
| D2 | Cargar el volumen de **frescos** y **farmacia** en el maestro (53 productos, §4) | equipo de datos / SIESA | 🟡 |
| — | Contador `dudoso` en `volumenTotal` | **descartado por ahora** — ver §4 | — |

**No usar el total de volumen para elegir camión hasta que D1 esté desplegado.** No
porque falle ruidosamente, sino por lo contrario: un traslado de frescos va a decir
"datos completos, total 0" y el camión va a llegar chico.

Las alertas sí se pueden prender ya: B1 está verificado y nada de esto las toca.

---

## 6. Cierre

Lo del volumen no es un bug tuyo — la fórmula quedó bien y la verificación te dio la
razón. Es que el dato de origen no está a la altura de la fórmula.

De lo nuevo, lo único que toca código es D1, y es una línea. El resto se arregla en el
maestro de SIESA, agrupado por categoría.

Y sirve para lo mismo que veníamos diciendo todo el día: un número plausible que nadie
mira dos veces es más peligroso que un error que revienta. El `0` de los huevos no
rompe nada — solo hace que el camión llegue chico.
