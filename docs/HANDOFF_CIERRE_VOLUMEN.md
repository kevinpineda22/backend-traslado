# Handoff — Cierre: una prueba decisiva para B2b y dos notas

> **Para:** Juan Manuel (backend).
> **De:** Johan.
> **Fecha:** 2026-07-30.
> **Responde a:** `RESPUESTA_AWAIT_Y_VOLUMEN.md`.
>
> **Resumen:** tenías razón en la corrección de B2 — lo verifiqué contra
> `buildUnidades` y mi fórmula rompía el caso más común. B1 y B2 quedan cerrados.
>
> Van **tres cosas, ninguna es un bug**: una forma de cerrar B2b sin depender de
> comparar magnitudes, una nota de por qué tu arreglo es mejor de lo que lo
> justificás, y una coordinación de frontend antes de desplegar.

---

## 0. Estado

| # | Tarea | Estado |
|---|-------|--------|
| A1, A2 | Señal del auditor, `En_recepcion` | ✅ Cerrados |
| B1 | `await` en el estampado | ✅ Cerrado — verificado en código |
| B2 | Volumen | ✅ Cerrado — con tu arreglo, no con el mío |
| **B2b** | Verificar `f122_volumen` contra datos | ⬜ **Hay forma decisiva (§2)** |
| **C1** | **Frontend de volumen no llegó a mi copia** | ⬜ **Bloquea el deploy (§3)** |

---

## 1. Tenías razón, y el círculo era real

Verifiqué `buildUnidades` (`siesa.service.js:507`): efectivamente arranca con
`{ unidad: base, factor: 1 }`. Mi `volumen × cantidad` arreglaba el caso de la unidad
de orden y **rompía el caso por defecto**, que es el más común. Tu normalización a
unidad base es lo correcto.

Y tenés razón en lo otro, que es lo más importante de tu respuesta: **te devolví tu
propio comentario especulativo como si fuera evidencia.** Habías escrito "no
necesariamente" justamente porque no lo sabías, y yo lo leí como confirmación. Fue un
círculo, no un dato. Bien marcado — y por eso va la §2.

---

## 2. B2b — Hay una prueba decisiva, sin comparar magnitudes

Tu plan es buscar un ítem con `factor > 1` y compararlo contra uno "físicamente
parecido" con `factor = 1`. Funciona, pero pide criterio: si el resultado queda en el
medio, no cierra.

**Hay una comparación exacta disponible.** `t122_mc_items_unidades` tiene **varias
filas por ítem**, una por unidad de medida — por eso la consulta hace JOIN por
`v121a_id_unidad_orden`: para quedarse con una. Vos mismo lo anotaste en
`ARQUITECTURA.md:142`:

> "hoy SIESA nos da 1-2 unidades por item; para ofrecer todas las presentaciones
> (P6/P12/…) hay que verificar en `t122_mc_items_unidades` si el item tiene varias
> filas de unidad"

Entonces: consultá esa tabla **sin filtrar por unidad**, para UN ítem que tenga varias
presentaciones, y traé `f122_factor` y `f122_volumen` de cada fila.

| Lo que se ve | Qué significa | Qué hacer |
|---|---|---|
| El volumen **escala con el factor** (la fila de factor 48 tiene ~48× el de la fila de factor 1) | Es por paquete | Nada — `volumenBase` está bien |
| El volumen es **igual en todas las filas** | Viene por unidad base | Sacar la división en `volumenBase` |

Es el mismo ítem contra sí mismo: no hay que juzgar si dos productos son
"comparables", ni conocer las unidades físicas del campo, ni saber cuánto ocupa una
caja de verdad. La respuesta sale sola.

**Por qué no sirve mirarlo en `traslados_snapshot`:** esa tabla tiene
`primary key (bodega, codigo_item)` — una sola fila por ítem, con un solo `volumen` y
un solo `um_orden`. Las filas por UM las arma `buildUnidades` después. La comparación
solo existe del lado de SIESA.

Esto lo podés correr vos contra Connekta; yo no tengo acceso a esa consulta.

---

## 3. C1 — El frontend de volumen no llegó (bloquea el deploy)

Decís que "el frontend no cambió", y es cierto que su fórmula ya era
`volumen_base × cantidad × factor`. Pero **en mi copia del frontend no hay nada de
volumen**: no existe `utils/volumenTraslado.js` ni aparece el campo en
`TablaProductosSiesa.jsx`.

O quedó sin pushear, o está en otra rama. Si desplegamos el backend así, manda
`volumen` y no lo consume nadie.

¿Podés confirmar que esté pusheado antes del paso 5 del despliegue?

---

## 4. Nota — tu arreglo es más robusto de lo que lo justificás

Vale la pena que quede escrito, porque el argumento con el que lo defendés es más
débil que el arreglo.

Lo justificás con "la unidad por defecto del carrito es la base". Eso es cierto en la
rama general de `buildUnidades`, pero hay **dos ramas más** donde la primera unidad NO
es la base:

- `umExtra` (UM asignada en Capacidad·Llano) → devuelve `[{umExtra, factor: N}, {base, factor: 1}]`
- `unidadForzadaDe(row.codigo_item)`

En esos ítems, `umDetalle(p)[0]` es la unidad asignada con factor N, no la base con
factor 1.

**Tu fórmula igual da bien en los dos casos**, y no por casualidad: al normalizar a
unidad base en el backend, queda **agnóstica a qué unidad se elija**. Ese es el
argumento fuerte, y es el que conviene dejar en el comentario — si queda solo "la
default es la base", alguien la puede "simplificar" el día que esa premisa cambie.

---

## 5. Orden de despliegue, con dueños

| # | Paso | Quién |
|---|------|-------|
| 1 | `014_volumen_item.sql` | Johan |
| 2 | `015_auditoria_abierta.sql` | Johan |
| 3 | `012_backfill_diferencia_und.sql` (con el `SELECT` de preview antes) | Johan |
| 4 | **Confirmar que el front de volumen esté pusheado** | **Juan Manuel** |
| 5 | Desplegar backend + frontend | Johan |
| 6 | Refrescar snapshot | Johan |
| 7 | **Verificar B1 contra el deploy, 5-6 veces** | Johan |
| 8 | **Cerrar B2b (§2)** antes de confiar en el total de volumen | **Juan Manuel** |
| 9 | Prender alertas: `recoleccion` → `auditoria` → `inactivar` | Johan |

---

## 6. Sobre `ARQUITECTURA.md` §6.5

Quedó mejor de lo que propuse. Lo de **"la conversión se hace UNA vez, en el borde que
conoce el factor"** es la parte que va a evitar la próxima, más que la tabla misma.

Y encontraste un cuarto desajuste que yo no tenía: en `traslados_items`,
`cantidad_admin` y `sugerido` están en la UM del renglón mientras `stock_origen`,
`stock_destino` y `consumo_destino` están en UND — **en la misma fila**. Para un ítem
en P30, `sugerido: 7` y `stock_destino: 210` dicen lo mismo con números distintos.
Eso no lo teníamos escrito en ningún lado y es exactamente el tipo de cosa que se
descubre tarde.

---

## 7. Cierre

En código no queda nada abierto. B2b es una consulta y C1 es confirmar un push.

Buen ida y vuelta este — de los cuatro problemas que salieron, dos eran míos y dos
tuyos, y ninguno se hubiera visto en pruebas.
