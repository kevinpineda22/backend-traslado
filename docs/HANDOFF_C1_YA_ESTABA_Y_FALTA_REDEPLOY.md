# Handoff — C1 ya estaba mergeado, y lo que falta es otra cosa

> **Para:** Juan Manuel (backend).
> **De:** Johan.
> **Fecha:** 2026-07-30.
> **Responde a:** `RESPUESTA_D1_Y_C1.md`.
>
> **Resumen:** D1 quedó bien de los dos lados y el razonamiento que le pusiste es el
> correcto. Pero dos cosas de tu respuesta se basan en un estado de mi repo que ya
> cambió: **C1 está mergeado desde hace una hora** y **la `014` ya la corrí**.
>
> Y hay un pendiente real que no está en tu lista: **tu cambio de D1 en el frontend
> no llegó a mi rama**, y **el D1 del backend quedó fuera del deploy**. Hoy, en
> producción, el `0` de los huevos sigue entrando al total como dato bueno.

---

## 0. Estado real

| # | Tarea | Tu doc dice | Estado real |
|---|-------|-------------|-------------|
| D1 backend | `volumen = 0` → null | Hecho | ✅ En `main`, ❌ **sin desplegar** (§3) |
| D1 frontend | guard en `volumenDeItem` | Hecho | ⬜ **No llegó a mi rama** (§2) |
| C1 | Front de volumen | Falta merge | ✅ **Ya mergeado** (§1) |
| Migración `014` | "que todavía no corriste" | Pendiente | ✅ **Corrida** (§1) |
| D2 | Maestro de SIESA | Equipo de datos | ⬜ Sin cambios |

---

## 1. Dos cosas que ya no aplican

### C1 está mergeado

El front de volumen entró a mi rama hace una hora:

```
642ba5c1  se sube lo del volumen (#883)   ← Johan
515ff436  se sube lo del volumen          ← el commit que citás
2e3644f6  se agrega nuevos cambios en el panel traslado…
```

`utils/volumenTraslado.js` y su test están en mi working tree, y ya salieron en el
deploy junto con la sección de Alertas y el listado semanal.

Miraste `origin/Johan` antes de que entrara ese merge. **No hay nada que coordinar
ahí** — no mergees nada, no hace falta.

### La `014` ya corrió

Escribís "la `014` —que todavía no corriste—". Corrí las tres: `014`, `015` y `012`,
y las verifiqué contra la base (columnas presentes, y el backfill de `012` da 0 filas
inconsistentes).

Tu edición al archivo es comentario + la consulta de auditoría, así que **no hay que
re-correr nada**. Buena la decisión de dejar la consulta adentro de la migración, al
lado del dato que audita.

---

## 2. Lo que sí falta mergear: tu D1 del frontend

Decís que aplicaste el guard también en `volumenDeItem` y que los tests pasaron de 11
a 13. En mi copia eso no está:

| | En mi rama (`Johan`) | Vos decís |
|---|---|---|
| Guard en `volumenDeItem` | `if (!Number.isFinite(v) \|\| v < 0) return null;` | `if (!(v > 0)) return null;` |
| Tests en `volumenTraslado.test.js` | **11** | 13 |

O sea: lo que falta traer **no es el volumen** (ese ya está), **es tu cambio de D1**.
Se mezclaron los dos en el diagnóstico.

**¿Podés pushearlo?** Decime a qué rama y lo traigo.

---

## 3. Falta redesplegar — D1 no está en producción 🔴

Esto es lo importante.

El D1 del backend entró en `0058079 respuesta a la documentacion`, que es
**posterior a mi deploy**. Verifiqué:

```
git log -S "if (!(v > 0)) return null;" -- src/services/siesa.service.js
→ 0058079  respuesta a la documentacion
```

El código está en `main`, pero **lo que corre en Vercel todavía tiene el `volumenBase`
viejo**. Así que ahora mismo, en producción:

- el `0` de los frescos sigue pasando como dato bueno,
- `sinDato` sigue valiendo siempre 0,
- y un traslado de pollo y huevos mostraría **total 0 con el cartel de completo**.

Lo mismo del lado del front en cuanto llegue tu cambio.

**No es urgente-urgente** —nadie está usando todavía el volumen para elegir camión—
pero conviene que quede claro que D1 está *escrito*, no *desplegado*.

---

## 4. Sobre poner el guard en las dos capas

De acuerdo, y me gusta el argumento:

> es una función pura con sus propios tests, y no debería depender de una garantía
> que se establece en otro sistema

Eso es lo correcto. Si mañana `volumenDeItem` la llama otro consumidor —o si alguien
la testea aislada— tiene que dar bien sola. No es redundancia por las dudas, es que
cada capa se sostenga sin suponer nada de la otra.

Y la generalización que dejaste en `ARQUITECTURA.md` §6.5 es la parte que más va a
servir a futuro:

> Cuando un sistema externo puede expresar "no sé" con un valor del mismo tipo que un
> dato válido (`0`, `""`, `1900-01-01`), traducilo a `null` **en el borde**.

Eso ya no es sobre volumen. Es la lección de todo el día escrita para el próximo.

---

## 5. Qué queda

| # | Qué | Quién |
|---|-----|-------|
| 1 | Pushear tu D1 del frontend y decirme la rama | **Juan Manuel** |
| 2 | Traer ese cambio a `Johan` y verificar 13 tests | Johan |
| 3 | **Redesplegar backend y frontend** (D1 quedó fuera del deploy) | Johan |
| 4 | Cargar volumen de frescos y farmacia en el maestro | equipo de datos |
| — | C1 y migraciones | ✅ nada que hacer |

Hasta el paso 3, el total de volumen no sirve para elegir camión.

---

## 6. Cierre

Coincido con tu cierre: los cuatro problemas del día tenían el mismo perfil — nada
reventaba. El `await` andaba en local, el `× factor` solo fallaba en multi-UM, la
señal del auditor era invisible desde el backend, y el `0` de los huevos devolvía un
número perfectamente plausible.

Y este handoff agrega un quinto del mismo tipo, aunque sea de proceso y no de código:
**"está hecho" y "está desplegado" no son lo mismo**, y desde tu lado los dos se ven
igual.
