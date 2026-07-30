# Handoff — Alertas: falta la señal de "el auditor está trabajando" (para Juan Manuel)

> **Para:** Juan Manuel (backend — sistema de alertas).
> **De:** Johan.
> **Fecha:** 2026-07-29.
> **Sobre:** commits `e2ab803` (panel alertas + listado general) y `7a9f118` (alertas al correo).
>
> **Resumen:** el sistema de alertas está bien armado y las tres reglas son correctas.
> Hay **un solo problema**, y las dos reglas de auditoría dependen de él: el backend no
> tiene forma de saber que el auditor está contando. Cuando prendas las alertas, la
> regla 3 va a **inactivar traslados que alguien está auditando en ese momento**.
>
> Nada está roto hoy: las tres alertas arrancan apagadas. Esto es un "antes de prenderlas".

---

## 0. Estado de un vistazo

| # | Tarea | Prioridad | Estado |
|---|-------|-----------|--------|
| A1 | Estampar la señal de "auditor abrió el traslado" | 🔴 Bloqueante | ⬜ Pendiente |
| A2 | Decidir qué hacer con el estado `En_recepcion` | 🟡 Media | ⬜ Pendiente |
| A3 | Correr migración `013` en Supabase | 🔴 Bloqueante | ⬜ Pendiente |
| A4 | Correr migración `012` en Supabase (backfill, no es tuya) | 🟢 Baja | ⬜ Pendiente |
| A5 | Prender las alertas desde el panel, de a una | 🟡 Media | ⬜ Después de A1 |

**A1 es lo único que bloquea.** El resto es secuencia de despliegue.

---

## 1. El problema (A1)

### Qué pasa

`auditoria_iniciada_at` se sella **recién en el primer "Comparar"**:

```js
// src/services/despacho.service.js — dentro de compararAuditoria
await DespachoModel.marcarAuditoriaIniciada(despachoId)
```

Pero el auditor **no toca el backend mientras cuenta**. Todo el conteo vive en
localStorage hasta que aprieta Comparar:

```js
// Pagina-web_React — src/pages/Traslados/hooks/useAuditoriaOffline.js
// "A diferencia del despachador, el auditor no envía incrementos al backend
//  (la auditoría es un solo 'commit' al final cuando compara y firma), por lo
//  que este hook es puramente local."
```

Y `GET /auditor/despachos/:id` (`obtenerDetalle`) es una **lectura pura**: no estampa nada.

**Resultado:** el auditor abre un traslado, escanea 300 ítems durante hora y media, y para
el backend `auditoria_iniciada_at` sigue en `NULL` y el estado sigue en `Recolectado`.

### Por qué importa

Las dos reglas de auditoría filtran por `auditoriaSinIniciar: true`, o sea
`auditoria_iniciada_at IS NULL`:

| Regla | Qué hace hoy mientras el auditor cuenta |
|-------|------------------------------------------|
| 2 — aviso de auditoría | Manda "nadie inició la auditoría" — es mentira |
| 3 — inactivar | **Inactiva el traslado a mitad de conteo** |

Y después de la regla 3, cuando el auditor quiere confirmar, `updateStatus` le responde:

```
409 — "Este traslado está inactivo. Reactivalo desde el panel de alertas para continuar."
```

El conteo no se pierde (está en localStorage), pero queda trabado hasta que alguien lo
reactive desde el panel.

### Esto es justo lo que quisiste evitar

Tu propio comentario en `correrReglaInactivar` lo dice:

> "Solo se congela lo que NADIE empezó a trabajar. Si el auditor ya abrió el traslado y
> contó unidades, inactivarlo le borraría el trabajo de la pantalla a mitad de camino —
> eso lo decide una persona, no un cron."

La intención está bien. La señal que necesita todavía no existe.

### Qué tan probable es

El reloj (`disponible_at`) corre desde que **cerró la recolección**, no desde que el
auditor abrió. Con los umbrales por defecto (auditoría 5 h, inactivar 8 h), alcanza con:

```
09:00  el despachador cierra la recolección  → disponible_at = 09:00
16:30  el auditor abre y empieza a contar    → auditoria_iniciada_at sigue NULL
17:00  barrido: 8 h vencidas                 → INACTIVADO mientras cuenta
17:10  el auditor firma                      → 409, trabado
```

---

## 2. Cómo arreglarlo (A1)

Hay que estampar algo cuando el auditor **abre** el traslado. Dos caminos.

### Opción A — que `obtenerDetalle` selle `auditoria_iniciada_at` ✅ recomendada

Una línea en `src/controllers/auditor.controller.js`, dentro de `obtenerDetalle`:

```js
// El auditor abrió el traslado: desde acá está trabajando, aunque el conteo viva
// en el navegador y no vuelva al backend hasta el primer Comparar. Sin esta marca,
// el barrido de alertas lo trata como "nadie lo tocó" y lo inactiva a mitad de conteo.
// Idempotente (.is null) y best-effort: nunca frena la lectura.
await DespachoModel.marcarAuditoriaIniciada(req.params.id).catch(() => {});
```

Dos cosas que ya están resueltas y no tenés que tocar:

- `auditor.controller.js` **ya importa** `DespachoModel` (línea 2), así que el snippet entra
  tal cual, sin agregar imports.
- `marcarAuditoriaIniciada` **ya es idempotente** (`.is("auditoria_iniciada_at", null)`), así
  que solo estampa la primera vez.

**A favor:** una línea, sin migración, sin cambios en el front. Y probablemente mejora la
métrica de trazabilidad: el trabajo del auditor empieza cuando abre, no cuando compara.

**En contra:** un auditor que abre para mirar y se va deja el traslado sellado, y la alerta
de auditoría ya no sale nunca para ese traslado.

### Opción B — transicionar a `En_recepcion` al abrir

Le da sentido al estado que hoy está muerto (ver A2) y deja `auditoria_iniciada_at`
significando "empezó a contar de verdad".

**En contra:** es una escritura de estado dentro de un `GET`, y hay que revisar los paneles
que muestran el estado.

### Recomendación

**Opción A.** Es peor inactivar a alguien que está trabajando que no avisar de un traslado
que alguien miró de reojo. El falso negativo es recuperable, el falso positivo traba a una
persona en el piso.

Si querés cubrir los dos casos más adelante, el camino es una columna propia
(`auditoria_abierta_at`) separada del hito de trazabilidad — pero para arrancar no hace falta.

---

## 3. El estado `En_recepcion` (A2)

**Ningún flujo lo setea hoy.** Está declarado en tres lados:

| Dónde | Qué dice |
|-------|----------|
| `Despacho.model.js` → `TRANSICIONES` | `Recolectado → En_recepcion` está permitida |
| `middleware/validators.js` | lo acepta como estado válido |
| `alertas.service.js` → `ESTADOS_ESPERA_AUDITOR` | lo incluye en el barrido |

Pero no hay ningún `updateStatus(id, "En_recepcion")` en el backend, ni el panel del auditor
lo manda. El flujo real es `Recolectado → Auditado / Rechazado / Recibido_con_inconsistencia`.

Tu comentario asume que existe:

```js
// 'En_recepcion' entra acá porque el auditor puede haberlo abierto sin contar nada;
// el filtro fino es `auditoria_iniciada_at IS NULL`, no el estado.
const ESTADOS_ESPERA_AUDITOR = ["Recolectado", "En_recepcion"];
```

La entrada no molesta (no hay filas en ese estado), pero **la red de seguridad que parece
dar no existe**. Es la misma raíz que A1.

**Qué hacer:** si vas por la Opción A, dejalo como está y ajustá el comentario para que no
prometa algo que no pasa. Si vas por la B, el estado pasa a ser real y el comentario queda bien.

---

## 4. Orden de despliegue (A3, A4, A5)

Correr **en este orden**:

1. **Migración `013`** en el SQL Editor de Supabase (`sql/013_alertas_y_borrador.sql`).
   Va **antes** de desplegar el backend: el código nuevo lee columnas que todavía no existen.
2. **Migración `012`** (`sql/012_backfill_diferencia_und.sql`) — no es tuya, es de un fix de
   `diferencia`. Corré primero el `SELECT` de preview que está comentado arriba del `UPDATE`.
3. **Desplegar el backend** con el arreglo de A1 incluido.
4. **Prender las alertas de a una** desde el panel, en este orden:
   - `recoleccion` primero (la más inofensiva: solo manda correo).
   - `auditoria` después, cuando confirmes que A1 funciona.
   - `inactivar` al final, y mirando los números un par de días antes.

> ⚠️ No prendas `inactivar` antes de A1. Es la regla que traba gente.

---

## 5. Cómo verificar que A1 quedó bien

- [ ] Abrir un traslado en `Recolectado` desde el panel del auditor, **sin comparar nada**.
- [ ] Consultar en Supabase: `auditoria_iniciada_at` quedó con fecha.

```sql
SELECT id, estado, disponible_at, auditoria_iniciada_at, inactivo
FROM traslados_despachos
WHERE id = '<id-del-traslado>';
```

- [ ] Volver a abrirlo y confirmar que `auditoria_iniciada_at` **no cambió** (idempotencia).
- [ ] Con `inactivar` prendida y umbral bajo (ej. 1 h), correr `GET /api/alertas/barrer` a
      mano y confirmar que **no** lo inactiva.
- [ ] Repetir con un traslado que nadie abrió: ese **sí** se tiene que inactivar.

---

## 6. Lo que revisé y está bien (no tocar)

Para que no gastes tiempo re-verificando:

| Área | Veredicto |
|------|-----------|
| `disponible_at` como columna aparte del hito `recoleccion_finalizada_at` | Correcto, y bien explicado en la 013 |
| Re-sellado del reloj en cada entrega de posta | Completo: `create`, `finalizarBorrador`, `→Recolectado`, `abandonarRecoleccion`, `setActivo` |
| Limpieza de `alerta_*_at` al re-sellar | Correcta — cada etapa mide su propia espera |
| Filtro `inactivo` | Oculto por defecto en paneles, bloqueado en `updateStatus` y al reclamar |
| Idempotencia de los correos (`alerta_*_at` + lock) | Correcta |
| Marcar la alerta **después** de que el correo salió | Correcto — una caída de SMTP no consume el aviso |
| Orden: avisar y después inactivar | Correcto |
| Cron de SIESA **no** filtra `inactivo` | Correcto — la mercancía ya salió, el movimiento es real |
| Alertas apagadas por defecto en la migración | Correcto para una base con despachos viejos |
| Saneamiento de la config en lectura y escritura | Correcto |

---

## 7. Contexto que puede que no tengas

Estos cambios están en el repo y tocan lo mismo:

| Qué | Dónde |
|-----|-------|
| Trazabilidad de tiempos (`auditoria_iniciada_at` y compañía) | migración `010` — es de la que dependen tus alertas |
| "No recibido" del auditor | migración `011` + `ItemModel.marcarNoRecibido` |
| Fix de `diferencia` en UND + backfill | `ItemModel.despachadoEnUnd` + migración `012` |
| Subida a SIESA volvió al despachador | se dispara en `cambiarEstado` al pasar a `Recolectado` |
| JSON crudo de SIESA en el correo de error | `enviarRequisicion` devuelve `siesaData`; helper `conSiesaData` |

---

## 8. Siguiente paso

Arrancar por **A1 con la Opción A** (una línea en `obtenerDetalle`), desplegar, y recién ahí
prender las alertas en el orden de §4.

Si preferís la Opción B o ves algo que se me escapó, hablémoslo antes — el resto del sistema
de alertas quedó bien y no quiero que toquemos de más.
