# Handoff — Modelo Pool de Despachador (para Johan)

> **De:** backend. **Para:** Johan (panel Despachador).
> **Qué es:** ahora el admin puede crear un despacho **sin asignar** despachador. Ese
> despacho queda en un **pool** y cualquier despachador lo puede **reclamar** al iniciar
> la recolección. El modelo asignado de siempre **sigue funcionando** — esto solo agrega
> el caso "sin dueño".

---

## Qué cambió en el backend (ya está desplegado)

- `despachador_id` es **opcional** al crear el despacho. Si el admin no asigna, se crea con
  `despachador_id = null` (queda en el pool).
- Nuevo endpoint **`POST /api/despachos/:id/iniciar`** que reclama el despacho de forma
  **atómica**: solo avanza `Creado → En_recoleccion` si sigue en `Creado`, y setea el
  `despachador_id` de quien lo toma. Si otro ya lo reclamó, responde **409**.
- `GET /api/despachos` ahora acepta **`?sin_asignar=true`** para listar los despachos libres
  (`despachador_id IS NULL`).

---

## Lo que necesitás cambiar en el panel Despachador (3 cosas)

### 1. Iniciar recolección → usar el endpoint nuevo 🔴

Hoy tu panel hace:
```js
PATCH /despachos/:id/estado   { estado: "En_recoleccion" }
```
Cambialo por:
```js
POST /despachos/:id/iniciar   { despachador_id: "<el del despachador logueado>" }
```
- Esto es lo que **reclama** el despacho (le pone dueño) de forma atómica.
- Respuesta OK: `{ ok: true, data: <despacho actualizado> }`.
- Respuesta **409** (`{ ok: false, error: "El despacho ya fue tomado o cambió de estado" }`)
  → otro despachador lo agarró primero. **Refrescá la lista** y avisá al usuario.

> Los demás cambios de estado (finalizar recolección → `Recolectado`, con firma) siguen igual
> con `PATCH /despachos/:id/estado`. Solo cambia el **iniciar**.

### 2. Listar los despachos del pool 🟡

Para que el despachador vea los libres, además de los asignados a él:
```js
// asignados a mí (como ya lo hacías)
GET /despachos?despachador_id=<mío>&estado=['Creado','En_recoleccion']

// + los del pool (libres, sin dueño)
GET /despachos?sin_asignar=true&estado=Creado
```
Podés hacer dos llamadas y unir las listas, o mostrar dos secciones ("Míos" / "Disponibles").
Decidí vos la UX; el backend te da ambas.

### 3. Manejar el 409 al reclamar 🟡

Si dos despachadores tocan "Iniciar" sobre el mismo despacho del pool, **solo el primero gana**.
El segundo recibe **409** → mostrale un aviso tipo *"Este despacho ya fue tomado por otro
despachador"* y refrescá la lista.

---

## Contratos exactos

**Crear (admin, ya lo maneja el panel admin):**
```json
POST /api/despachos
{ "flujo": "...", "origen": "...", "destino": "...",
  "despachador_id": "d1" | null,   // null u omitido = pool
  "criterios": [...], "items": [...] }
```

**Reclamar / iniciar (tu panel):**
```json
POST /api/despachos/:id/iniciar
{ "despachador_id": "d1" }        // el del despachador logueado
→ 200 { "ok": true, "data": {...} }
→ 409 { "ok": false, "error": "El despacho ya fue tomado o cambió de estado" }
```

**Listar libres:**
```
GET /api/despachos?sin_asignar=true&estado=Creado
→ { "ok": true, "data": [ ...despachos con despachador_id null... ] }
```

---

## Resumen de una línea

Cambiá el "iniciar" de `PATCH /estado` a **`POST /:id/iniciar`** (con `despachador_id`), sumá
la lista **`?sin_asignar=true`** para el pool, y manejá el **409** cuando dos toman el mismo.
Nada más. El resto del flujo queda igual.
