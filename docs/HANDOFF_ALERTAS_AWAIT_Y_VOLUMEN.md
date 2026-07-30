# Handoff — Dos cosas y cerramos alertas (para Juan Manuel)

> **Para:** Juan Manuel (backend — alertas).
> **De:** Johan.
> **Fecha:** 2026-07-30.
> **Responde a:** `RESPUESTA_ALERTAS_SENAL_AUDITOR.md`.
>
> **Resumen:** la variante con frescura es mejor que la Opción A que te propuse, y
> tenías razón en el agujero que yo no vi. A1 y A2 quedan cerrados.
>
> Quedan **dos cosas**. Una es bloqueante y anula el arreglo justo en producción
> (`B1`); la otra es de la feature de volumen, y la respuesta estaba en tu propia
> migración (`B2`).

---

## 0. Estado de un vistazo

| # | Tarea | Prioridad | Estado |
|---|-------|-----------|--------|
| A1 | Señal del auditor | — | ✅ Cerrado — tu variante es mejor |
| A2 | `En_recepcion` | — | ✅ Cerrado |
| **B1** | **Falta `await` en el estampado** | 🔴 Bloqueante | ⬜ Pendiente |
| **B2** | **`× factor` de más en el volumen** | 🟡 Media | ⬜ Pendiente |
| A4 | Migración `012` (backfill) | 🟢 Baja | ⬜ Mía, la corro yo |
| A5 | Prender alertas de a una | 🟡 Media | ⬜ Después de B1 |

---

## 1. Tenías razón en dos cosas

Antes de los pendientes, que quede escrito:

**El agujero de la Opción A era más grande de lo que puse en el handoff.** Yo listé
solo que la regla 2 dejaba de avisar. No vi que la regla 3 filtra por la *misma*
condición, así que un traslado abierto y abandonado quedaba invisible para las dos,
de por vida. Medir **frescura en vez de existencia** lo resuelve bien, y la columna
separada era el camino correcto: `auditoria_iniciada_at` sigue siendo el hito limpio
de trazabilidad.

**Y tenías razón en lo del GET.** Lo listé como contra de la Opción B cuando la A
también escribe en un `GET`. La diferencia real es timestamp vs transición de estado,
como decís vos.

Lo de refrescar la señal también en `compararAuditoria` no estaba en mi propuesta y
es necesario: sin eso un recuento largo entre Comparar y Confirmar se caía de la
ventana. Buena esa.

---

## 2. B1 — Falta `await` en el estampado 🔴

### Dónde

`src/controllers/auditor.controller.js`, dentro de `obtenerDetalle`:

```js
// Como está hoy:
DespachoModel.marcarAuditoriaAbierta(req.params.id).catch(() => {});
```

### Por qué rompe

La llamada arranca la escritura y **no la espera**. Justo después, el handler arma la
respuesta —que es todo síncrono, microsegundos— y llama a `res.json()`.

La escritura a Supabase es un viaje de red: 50-200 ms. O sea que la respuesta sale
mucho antes de que la escritura termine.

Esto corre en Vercel. **Cuando la función responde, la instancia se puede congelar, y
el trabajo asíncrono que no se esperó no tiene garantía de completarse.** La marca se
pierde seguido, el barrido vuelve a ver el traslado como abandonado, y volvemos al
bug que estamos arreglando.

Lo peor es el perfil de falla:

| Entorno | Qué pasa |
|---------|----------|
| Local (`node --watch`) | El proceso sigue vivo → la escritura siempre termina → **anda perfecto** |
| Vercel | La instancia se congela al responder → la escritura se pierde **de a ratos** |

Se valida OK y aparece en el piso a la semana, sin patrón claro.

### El arreglo

```js
await DespachoModel.marcarAuditoriaAbierta(req.params.id).catch(() => {});
```

Ya tiene el `.catch(() => {})`, así que **no puede tirar nunca** — el `await` no
compromete la lectura. Cuesta ~100 ms en un `GET` que el auditor hace una vez al abrir.
Comparado con dejar a alguien trabado con el conteo hecho, es gratis.

### Nota

En el otro call site ya lo hacés bien: `compararAuditoria`
(`despacho.service.js:335`) sí tiene `await`. Es una inconsistencia entre los dos
lugares, no un criterio distinto.

---

## 3. B2 — El volumen se multiplica de más 🟡

Preguntaste si `f122_volumen` es el volumen de una unidad base o del paquete.

**La respuesta está en tu propia migración `014`:**

> `f122_volumen` sale de la fila de `t122_mc_items_unidades` correspondiente a la
> UNIDAD DE ORDEN del ítem (el JOIN es por `v121a_id_unidad_orden`), **la misma fila
> de la que sale `f122_factor`**. O sea: es el volumen de UN paquete de la unidad de
> orden, no necesariamente el de UNA unidad base.

Si sale de la misma fila que el `factor`, es el volumen **del paquete**. Y `cantidad`
ya está expresada en esa misma unidad (`cantidad_admin` y `cantidad_despachador` viven
en la UM del renglón; la que está en UND es `cantidad_auditor`).

Entonces:

```
volumen × cantidad            ✅ correcto
volumen × cantidad × factor   ❌ infla el total por el factor
```

### Cuánto importa

| Ítem | Fórmula actual | Correcto |
|------|----------------|----------|
| `factor = 1` (la mayoría) | igual | igual |
| P48, 2 paquetes | **96 volúmenes** | 2 volúmenes |

Para elegir camión, un ítem en P48 solo ya te pide 48 veces más espacio del real.
Tenías bien identificado que se rompe solo en los multi-UM — que es exactamente donde
nos mordió el cálculo de `diferencia` la semana pasada. Mismo patrón, misma causa:
cruzar una cantidad en UM de renglón con algo que está en otra unidad.

### Aclaración

No pude verificar la fórmula en el código: `utils/volumenTraslado.js` no llegó a mi
copia del front (no está en el repo de mi lado). Si al mirarlo resulta que ya
multiplica bien, ignorá este punto — pero el comentario de la `014` sugiere que no.

---

## 4. Lo que revisé de tu implementación y está bien

Para que no gastes tiempo:

| Punto | Veredicto |
|-------|-----------|
| Migración `015` + índice, sin backfill | Correcta — `NULL` = nadie lo abrió, que es la verdad |
| `marcarAuditoriaAbierta` no idempotente | Deliberado y correcto: acá se quiere que se pise |
| `findEstancados` con `.or(is.null, lt)` | Lógica correcta — nunca abierto **o** abierto hace rato |
| Ventana de gracia 4 h + `ALERTAS_GRACIA_AUDITOR_HORAS` | Bien, y bien que solo aplique a las reglas del auditor (`respetaAuditor`) |
| Refresco en `compararAuditoria` | Necesario, no estaba en mi propuesta |
| Comentario de `En_recepcion` corregido | Ya no promete una red que no existe |
| `POST /barrer` sin token | De acuerdo. Está documentado, el barrido es idempotente y como mucho adelanta 10 min lo que el cron hacía igual. El resto de la API tampoco tiene auth — que entre con la auth real, como decís |

---

## 5. Cómo verificar B1

El `await` no se puede verificar en local: **ahí funciona igual con o sin él.** Hay que
probarlo contra el deploy.

- [ ] Desplegar con el `await` puesto.
- [ ] Desde el **frontend desplegado** (no local), abrir un traslado en `Recolectado`
      con el panel del auditor. Sin comparar nada.
- [ ] Confirmar en Supabase que la marca quedó:

```sql
SELECT id, estado, auditoria_abierta_at, auditoria_iniciada_at, inactivo
FROM traslados_despachos
WHERE id = '<id-del-traslado>';
```

- [ ] Repetirlo **5 o 6 veces con traslados distintos**. Con el bug la marca se escribe
      a veces sí y a veces no; una sola prueba exitosa no prueba nada.
- [ ] `auditoria_iniciada_at` tiene que seguir en `NULL` — confirma que el hito quedó limpio.

---

## 6. Orden de despliegue final

1. ~~`013_alertas_y_borrador.sql`~~ ✅ ya corrida
2. `014_volumen_item.sql`
3. `015_auditoria_abierta.sql`
4. `012_backfill_diferencia_und.sql` — mía, la corro yo con el `SELECT` de preview
5. **Arreglar B1** (el `await`) y desplegar el backend
6. Refrescar el snapshot (para que aparezca el volumen)
7. Prender alertas de a una: `recoleccion` → `auditoria` → `inactivar`

> ⚠️ No prendas `inactivar` sin B1 desplegado y verificado contra el deploy. Es la
> regla que traba gente, y sin el `await` la protección del auditor funciona a medias.

---

## 7. Cierre

Alertas quedó bien. B1 es una línea y B2 es sacar un `× factor`; con eso cerramos.

Lo del volumen lo tenías escrito vos mismo en la `014` — vale la pena que ese
comentario no se pierda, porque es la tercera vez que el `factor` nos muerde en un
lugar distinto. Capaz merece quedar en `ARQUITECTURA.md` como regla general: **qué
unidad guarda cada columna, y que cruzar dos unidades distintas siempre pide el factor.**
