# Respuesta — D1 puesto, C1 diagnosticado (no era lo que parecía)

> **Para:** Johan.
> **De:** Juan Manuel (backend).
> **Fecha:** 2026-07-30.
> **Responde a:** `HANDOFF_B2B_CERRADO_Y_VOLUMEN_SUCIO.md` y `HANDOFF_CIERRE_VOLUMEN.md`.
>
> **Resumen:** D1 hecho — y tenías razón en que era lo urgente, por una razón que
> ni vos ni yo habíamos puesto en palabras: la red de seguridad estaba **construida
> y desconectada**.
>
> **C1 no era un push perdido.** El front está pusheado desde hace rato — a
> `origin/juan`. Vos estás mirando `origin/Johan`. Es un merge, no un push (§2).

---

## 0. Estado

| # | Tarea | Estado |
|---|-------|--------|
| B2b | Verificar `f122_volumen` | ✅ Cerrado por vos, con datos. Comentario actualizado |
| **D1** | `volumen = 0` → sin dato | ✅ **Hecho** (§1) |
| **C1** | Front de volumen | ✅ **Diagnosticado — falta merge `juan` → `Johan`** (§2) |
| D2 | Volumen mal cargado en el maestro | ⬜ Equipo de datos. Consulta dejada en la `014` (§3) |
| — | Contador `dudoso` | ❌ Descartado — de acuerdo con tu desdicho (§3) |

---

## 1. D1 — hecho, y la razón de fondo es más fuerte que los 31 ceros

Aplicado en `volumenBase` (`siesa.service.js`): `if (!(v > 0)) return null;`

Lo hice **también** en `volumenDeItem` del frontend. No es redundancia por las
dudas: es una función pura con sus propios tests, y no debería depender de una
garantía que se establece en otro sistema. Si mañana la llama otro consumidor,
tiene que dar bien sola. Los tests pasaron de 11 a 13 — los dos nuevos son
exactamente tu caso: un despacho de puros frescos ya no puede declararse completo.

### Lo que más me convenció de tu handoff

No fue la lista de ítems, fue esto:

> `sin_dato = 0`. En 65.073 filas no hay un solo `NULL`. (…) La red de seguridad
> está bien construida y desconectada.

Eso es lo que lo vuelve urgente y lo que yo no había visto. Yo diseñé la distinción
`null` vs `0` en la migración `014` y la defendí con un argumento correcto — pero
sobre un supuesto que nunca verifiqué: que SIESA usaba `NULL` para "no sé". Nunca lo
usa. Así que la rama `null` de mi función jamás se ejecutaba y `sinDato` valía
siempre `0`. Escribí un contador que no podía contar.

**No era tapar 31 ceros: era enchufar el mecanismo.**

Lo generalicé en `ARQUITECTURA.md` §6.5, porque no es un problema del volumen:

> Cuando un sistema externo puede expresar "no sé" con un valor del mismo tipo que
> un dato válido (`0`, `""`, `1900-01-01`), traducilo a `null` **en el borde**. Si
> entra crudo, cualquier chequeo de completitud río abajo mide otra cosa.

### La columna del snapshot sigue guardando el crudo

A propósito. La traducción `0 → null` vive en `volumenBase`, no en la tabla:
`traslados_snapshot.volumen` conserva el valor de SIESA tal cual, que es lo que
permite **auditar el maestro** y sacar la lista de D2. Si lo normalizáramos al
guardar, perderíamos la evidencia de qué hay que cargar.

Actualicé el comentario de la `014` —que todavía no corriste— porque decía
`NULL = "SIESA no tiene el volumen"`, y ahora sabemos que eso no pasa nunca. Le
dejé adentro tu consulta de auditoría, comentada, para que quede al lado del dato
que audita.

---

## 2. C1 — está pusheado, en otra rama

Lo verifiqué:

```
commit 515ff436  "se sube lo del volumen"   →  origin/juan  ✅
origin/Johan     : volumenTraslado.js NO existe
origin/master    : NO existe
origin/stagingmk : NO existe
```

Está pusheado y el árbol local está limpio. Lo que falta es **traer `juan` a la
rama desde la que desplegás**, no que yo pushee algo.

Además de `utils/volumenTraslado.js` (+ su test), en esa rama viven todos los
cambios de esta tanda del front: la sección de Alertas, el listado semanal, la
columna Volumen en "Ver detalles", el export de Columnario y la corrección de
colores del panel. Si desplegás sin ese merge, el backend manda `volumen` y no lo
consume nadie — pero además faltan las pantallas nuevas.

**Ojo con el orden:** el merge tiene que entrar **antes** del paso 5 de tu lista
(desplegar backend + frontend), no después.

Decime desde qué rama desplegás y lo coordinamos. Si querés lo mergeo yo, avisame.

---

## 3. D2 — de acuerdo, y de acuerdo con tu desdicho

Coincido en las dos cosas:

**Que se arregla en el maestro, no en código.** Son 53 productos sobre 16.060
agrupados en dos categorías. Cargarlos en SIESA lo arregla para todos los
consumidores del dato, no solo para nuestro panel.

**Y que el contador `dudoso` era sobre-ingeniería.** Bien que te hayas desdicho.
Un umbral elegido a ojo para cazar el 0,3% de los casos es una perilla que alguien
tiene que mantener y nadie va a saber por qué vale lo que vale. Si la basura crece,
lo construimos con datos que justifiquen el corte.

Dejé la consulta de auditoría dentro de `sql/014_volumen_item.sql`, comentada al
final, con las dos familias anotadas. Ahí la va a encontrar quien vaya a mirar la
columna, que es más probable que en un handoff de hace un mes.

**Una salvedad sobre los 152 "dudosos":** con D1 no cambian, siguen entrando al
total. Y ojo con cómo fallan — un placeholder de `1` con factor 6 da 0,17 por
unidad, o sea que **no distorsionan el total: lo dejan corto en silencio**, igual
que el 0 pero menos. No es urgente, pero tampoco es inofensivo: si un traslado
fuera mayormente farmacia, el camión llegaría chico y el panel diría "completo".

Vale la pena que quien cargue el maestro empiece por **frescos** —que ya avisa como
faltante— y siga por farmacia.

---

## 4. Tu nota de §4 (`HANDOFF_CIERRE_VOLUMEN`) — la incorporé

Tenías razón: yo defendí el arreglo con "la unidad por defecto del carrito es la
base", y eso solo vale para la rama general de `buildUnidades`. En `umExtra`
(Capacidad·Llano) y en `unidadForzadaDe`, `umDetalle(p)[0]` tiene factor N.

El argumento fuerte es el otro, y es el que dejé en el comentario:

> Lo importante no es cuál sea la unidad por defecto, sino **que no importe**. Al
> normalizar a base, la cuenta queda agnóstica a qué unidad se elija. No la
> "simplifiques" apoyándote en la unidad por defecto.

Buena esa — con mi justificación original, el día que cambie la default alguien
"arregla" la función y la rompe.

---

## 5. Qué queda

| # | Qué | Quién |
|---|-----|-------|
| C1 | Mergear `origin/juan` a la rama de deploy | a coordinar (§2) |
| D2 | Cargar volumen de frescos y farmacia en el maestro | equipo de datos |
| — | Correr `014`, `015`, `012` y desplegar | Johan |

En código no queda nada abierto de mi lado.

---

## 6. Cierre

Cuatro problemas en el día, dos tuyos y dos míos, y **ninguno de los cuatro se
hubiera visto en pruebas**: el `await` andaba perfecto en local, el `× factor` solo
fallaba en multi-UM, la señal del auditor era invisible desde el backend, y el `0`
de los huevos devolvía un número perfectamente plausible.

Es el mismo patrón las cuatro veces: **nada revienta.** Por eso el ida y vuelta de
handoffs sirvió más que cualquier suite que hubiéramos podido correr.
