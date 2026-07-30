# Respuesta al handoff — Señal del auditor (A1) resuelta

> **Para:** Johan.
> **De:** Juan Manuel (backend — alertas).
> **Fecha:** 2026-07-30.
> **Responde a:** `HANDOFF_ALERTAS_SENAL_AUDITOR.md`.
>
> **Resumen:** el diagnóstico es correcto — lo verifiqué contra el código, no de
> palabra. El bug era mío. Implementé una variante de tu Opción A que cubre un
> caso que el handoff subestima: con la Opción A tal cual, un traslado abierto y
> abandonado quedaba invisible para **las tres** reglas, no solo para la 2.
>
> **Falta correr la migración `015`** antes de desplegar. Sin ella el barrido falla.

---

## 0. Estado actualizado

| # | Tarea | Estado |
|---|-------|--------|
| A1 | Señal de "el auditor está trabajando" | ✅ **Hecho** — variante con frescura (§2) |
| A2 | Qué hacer con `En_recepcion` | ✅ **Hecho** — se deja, comentario corregido (§4) |
| A3 | Correr migración `013` | ✅ Corrida |
| A4 | Correr migración `012` (backfill) | ⬜ Pendiente (tuya) |
| A5 | Prender las alertas de a una | ⬜ Pendiente — después de desplegar |
| **A6** | **Correr migraciones `014` y `015`** | ⬜ **Bloqueante** (§5) |

---

## 1. Verificación de tu diagnóstico

Chequeé las cuatro afirmaciones antes de tocar nada. Las cuatro se confirman:

| Afirmación | Verificado en |
|---|---|
| `marcarAuditoriaIniciada` se llama solo desde `compararAuditoria` | `despacho.service.js:327` — única llamada en todo `src/` |
| `obtenerDetalle` es lectura pura, no estampa nada | `auditor.controller.js` — no había ningún write |
| Nadie setea `En_recepcion` | Solo aparece en `TRANSICIONES`, el enum de validators y como etiqueta de UI |
| El conteo del auditor es 100% local | `useAuditoriaOffline.js` — "puramente local", confirmado |

El escenario `09:00 → 17:10` es realista y la regla 3 trababa a una persona con el
conteo hecho.

**El error fue mío:** escribí el filtro `auditoriaSinIniciar` asumiendo que
`auditoria_iniciada_at` significaba "el auditor está trabajando", cuando significa
"apretó Comparar" — que pasa al final. Y el comentario que puse en
`ESTADOS_ESPERA_AUDITOR` prometía una red de seguridad vía `En_recepcion` que no
existe. Bien cazado.

---

## 2. Lo que implementé, y por qué no fue la Opción A tal cual

### El agujero que deja la Opción A

Tu contra listada es que "la alerta de auditoría ya no sale nunca para ese
traslado". Es cierto, pero el efecto es más grande: **la regla 3 filtra por la
misma condición**. Entonces un traslado que alguien abrió y abandonó queda:

| Regla | Con Opción A, tras una apertura suelta |
|-------|----------------------------------------|
| 2 — aviso | No avisa nunca (filtra `IS NULL`) |
| 3 — inactivar | No inactiva nunca (mismo filtro) |

O sea: **invisible para las tres reglas, de por vida.** Cambiábamos "traba al que
trabaja" por "pierde al que abandonó", y el segundo es justo el caso que las
alertas existen para cazar.

### La variante: frescura, no un booleano

Columna nueva **`auditoria_abierta_at`** (migración `015`), separada del hito de
trazabilidad, que se **re-sella en cada apertura y en cada Comparar** — a
propósito no es idempotente. El barrido mira cuán **reciente** es, no si existe:

| Situación | Regla 3 (inactivar) | Regla 2 (aviso) |
|---|---|---|
| Nadie lo abrió | inactiva ✓ | avisa ✓ |
| Abierto hace 20 min (contando) | **no toca** ✓ | **no avisa** ✓ |
| Abierto anteayer, nunca confirmado | inactiva ✓ | avisa ✓ |

Ventana de gracia: **4 h**, override con `ALERTAS_GRACIA_AUDITOR_HORAS`. Generosa
a propósito — equivocarse para el lado de no molestar es barato; para el otro lado
deja a alguien trabado en el piso.

Es el mismo criterio de ventana de gracia que ya usa el prune del snapshot.

### Por qué columna nueva y no reusar `auditoria_iniciada_at`

Son dos cosas y mezclarlas rompe las dos:

- `auditoria_iniciada_at` es un **hito de negocio** — cuándo empezó a contarse de
  verdad. Alimenta métricas y no se toca una vez sellado.
- `auditoria_abierta_at` es una **señal de actividad** — "alguien está en esto
  ahora". Se pisa constantemente.

Sellar el hito al abrir ensuciaba la métrica (el trabajo empezaría a contar cuando
alguien mira de reojo) y dejaba al hito sin poder distinguir mirar de contar. Es el
camino que vos mismo proponías para más adelante; lo hice ahora porque ya había que
correr migraciones igual y el costo fue una columna.

### Sobre "escritura dentro de un GET"

Lo listaste como contra de la Opción B, pero la A también escribe en un `GET`. La
diferencia real es **timestamp vs transición de estado**, que es mucho menos grave
— no cambia el flujo ni lo que ven los paneles. Lo dejé, documentado con todas las
letras en `obtenerDetalle`: la pureza REST no vale que quede una persona trabada
con el conteo hecho. Pero conviene nombrarlo bien.

---

## 3. Archivos tocados

| Archivo | Cambio |
|---|---|
| `sql/015_auditoria_abierta.sql` | **Nueva** — columna + índice |
| `Despacho.model.js` | `marcarAuditoriaAbierta()` (no idempotente, best-effort) |
| `Despacho.model.js` | `findEstancados` ahora recibe `auditorInactivoDesde` en vez de `auditoriaSinIniciar` |
| `auditor.controller.js` | `obtenerDetalle` estampa la señal |
| `despacho.service.js` | `compararAuditoria` la refresca también |
| `alertas.service.js` | Ventana de gracia + comentarios corregidos |

Detalle de `compararAuditoria`: refresca la señal además de sellar el hito. Sin eso,
un recuento largo entre el Comparar y el Confirmar podía caerse de la ventana de
gracia y el traslado se inactivaba con la persona todavía contando.

---

## 4. Sobre `En_recepcion` (A2)

Fui por tu recomendación: **se deja como está y se corrige el comentario**. Ahora
dice la verdad — que ningún flujo lo setea, que no aporta red de seguridad hoy, y
que quien distingue "lo están atendiendo" de "está abandonado" es
`auditoria_abierta_at` y no el estado.

La entrada en `ESTADOS_ESPERA_AUDITOR` queda por si algún día el estado se usa de
verdad, pero ya no promete nada que no pase.

---

## 5. Orden de despliegue (actualizado)

El tuyo, con dos migraciones más que entraron en el medio:

1. ~~`013_alertas_y_borrador.sql`~~ ✅ ya corrida
2. **`014_volumen_item.sql`** — volumen por ítem (feature aparte, ver §7)
3. **`015_auditoria_abierta.sql`** ← la de esto
4. `012_backfill_diferencia_und.sql` — la tuya; corré primero el `SELECT` de preview
5. Desplegar backend
6. **Refrescar el snapshot** — necesario para que el volumen aparezca (§7)
7. Prender alertas de a una: `recoleccion` → `auditoria` → `inactivar`

> ⚠️ Sin la `015`, el barrido revienta con
> `column traslados_despachos.auditoria_abierta_at does not exist`.
> Lo verifiqué contra la base: hoy falla.

---

## 6. Cómo verificar

Tu checklist de §5 sigue valiendo, con la columna nueva y un caso más:

- [ ] Abrir un traslado en `Recolectado` desde el panel del auditor, **sin comparar**.
- [ ] `auditoria_abierta_at` quedó con fecha; `auditoria_iniciada_at` sigue en `NULL`
      (son cosas distintas — esto confirma que no se ensució el hito).

```sql
SELECT id, estado, disponible_at, auditoria_abierta_at, auditoria_iniciada_at, inactivo
FROM traslados_despachos
WHERE id = '<id-del-traslado>';
```

- [ ] Volver a abrirlo: `auditoria_abierta_at` **sí cambia** (es lo contrario de la
      idempotencia del hito — acá se quiere que se pise).
- [ ] Con `inactivar` prendida y umbral bajo (1 h), correr el barrido a mano y
      confirmar que **no** lo inactiva.
- [ ] Un traslado que nadie abrió: ese **sí** se inactiva.
- [ ] **Caso nuevo:** un traslado abierto hace más de 4 h y nunca confirmado —
      ese **vuelve a la cola** y se inactiva. Es el agujero que la Opción A dejaba
      abierto.

Para el barrido a mano ahora hay botón: **"Probar ahora"** en el panel de Alertas
(`POST /api/alertas/barrer`, sin token — el `GET` que usa el cron sí lo pide, porque
el front no puede llevar el secreto sin publicarlo en el bundle).

---

## 7. Lo que entró en paralelo (contexto para vos)

Además de las alertas, en esta tanda entraron:

| Qué | Dónde |
|-----|-------|
| Listado semanal del General (estado `Borrador`) | migración `013` + `POST /despachos/listado` |
| Volumen por ítem — total del traslado para elegir camión | migración `014` + `utils/volumenTraslado.js` (11 tests) |
| Filtro `MUA` (U. Medida) sacado de los criterios | `siesa.service.js` → `PLANES` |
| Paleta e identidad de marca en los correos | `services/emailMarca.js` — la usan los 5 correos |
| Logging de `accepted` / `rejected` / `messageId` en los envíos | `email.service.js` |
| Exportar Excel en Columnario · Sedes | `InventarioSedes.jsx` |

**Sobre el volumen — hay una duda abierta que te puede interesar.** La fórmula es
`volumen × cantidad × factor`, que asume que `f122_volumen` es el volumen de UNA
unidad base. Como el JOIN de la consulta es por `v121a_id_unidad_orden`, podría ser
el volumen del **paquete** — y ahí el total quedaría multiplicado de más por el
`factor`. En los ítems con `factor = 1` (la mayoría) las dos fórmulas dan igual; se
rompe solo en los multi-UM. Está aislado en `volumenDeItem` con el comentario
explicando el riesgo. Si sabés cómo viene ese campo, avisá.

---

## 8. Cierre

A1 y A2 cerrados. Lo que bloquea ahora es operativo: correr `014` y `015`, desplegar
y prender las alertas en orden.

Gracias por el handoff — el `auditoria_iniciada_at` sellado al final era un detalle
que desde mi lado no se veía, y la regla 3 iba a trabar gente el primer día.
