# Handoff Backend — Traslados (para Juan Manuel)

> **Para:** Juan Manuel (backend).
> **De:** Johan (frontend — paneles Despachador y Auditor).
> **Objetivo:** que apuntemos al mismo lado. Acá tenés (1) lo que YA dejamos listo del lado del
> frontend, y (2) lo concreto que falta de tu lado, con el contrato exacto. Nada te pide rehacer
> lo que ya hiciste bien (flujos + snapshot + UUID + tope 422); es lo que falta para cerrar el
> flujo de punta a punta.
>
> Detalle completo del sistema: [`SISTEMA_TRASLADOS.md`](./SISTEMA_TRASLADOS.md).
> **Última actualización:** 2026-07-03.

---

## 0. Estado de un vistazo

| # | Tarea | Estado |
|---|-------|--------|
| B1 | Sincronizar migraciones (drift) | ✅ Hecho — `sql/002_uuid_snapshot.sql` espeja la base (UUID + snapshot + `agotado`). |
| B2 | Persistir `agotado` + tope duro | ✅ Código hecho (422 si `cantidad > cantidad_admin`). ⏳ **Falta correr 1 ALTER en la base viva.** |
| B3 | `findAll` con `estado` array | ✅ Hecho — `.in` para arrays, `.eq` para string. |
| B4 | Auditoría en dos tiempos (`comparar`/`confirmar`) | ✅ **Hecho** — endpoints `POST /auditor/despachos/:id/comparar` y `/confirmar` implementados según tu contrato. Estado `Recibido_con_inconsistencia` en enum + transiciones. Usa `id` (no `item_id`). ⏳ Falta el ALTER `auditor_id` en la base viva. |
| B5 | Normalizar `items` | 🟢 Opcional (ya lo manejamos en el front). |

**Camino crítico para vos ahora:** correr los 2 ALTER (§3.1) e implementar B4 (§3.2).

---

## 1. Lo que YA dejamos listo nosotros (frontend)

Para que sepas contra qué se va a conectar tu backend. Todo probado con Vitest (**46 tests
verde**, `npm test`).

### Despachador — LISTO (Fase 2)
- Registra **cantidad real por ítem**, marca **agotado** (checkbox) y detecta **incompleto**.
- **Tope duro** en el front (no deja pasar de `cantidad_admin`) — tu 422 es el segundo cerrojo.
- **Alerta permanente** de faltantes (incompletos/agotados) siempre visible.
- Botón **"Iniciar recolección"** → `PATCH /despachos/:id/estado` a `En_recoleccion`.
- Finalizar → `POST /despachos/:id/recolectar` (cantidades por ítem) + `PATCH estado` a
  `Recolectado` con firma.
- **Payload que te manda a `/recolectar`:**
  ```json
  { "items": [ { "id": "<uuid item>", "cantidad": 5, "agotado": false } ] }
  ```

### Auditor — LISTO pero ESPERANDO B4 (Fase 3)
- **Recepción ciega por escaneo**: usa `GET /auditor/despachos` y `GET /auditor/despachos/:id`
  (los ciegos, sin `cantidad_despachador`). El auditor escanea y cuenta por ítem.
- Botón **"Comparar"** → `POST /auditor/despachos/:id/comparar` (tu backend revela diferencias).
- Si hay diferencias: **Recontar** / **Recibir con inconsistencia** / **Rechazar** →
  `POST /auditor/despachos/:id/confirmar` + firma.
- ⚠️ Estos dos endpoints (`comparar`/`confirmar`) **todavía no existen** → hoy el panel da 404.
  Es lo que implementás en B4.

### Ajustes de contrato que ya resolvimos del lado front
- Leemos `items` aunque devuelvas `traslados_items` (normalizador propio).
- Mandamos `firma_data` (no `firma`).
- Leemos tus errores como `{ ok:false, error }` (antes leíamos `.message` y no se veían — ya
  se ven, incluido tu 422).

---

## 2. Contratos que ya implementaste (verificados en código) ✅

`POST /api/despachos/:id/recolectar`
```json
{ "items": [ { "id": "<uuid item>", "cantidad": 5, "agotado": false } ] }
```
Si `cantidad > cantidad_admin` → **422** con el mensaje del tope. `agotado` opcional (default `false`). 👍

---

## 3. Lo que falta de tu lado

### 3.1 — Operativo: correr 2 ALTER en la base viva 🔴

La base viva ya existe sin estas columnas. Corré una vez en Supabase (y dejalos también en
`sql/002` para que la migración siga siendo el espejo de la base):

```sql
-- Para B2 (agotado del despachador)
alter table public.traslados_items
  add column if not exists agotado boolean not null default false;

-- Para B4 (quién auditó)
alter table public.traslados_despachos
  add column if not exists auditor_id varchar(100);
```

> Sin el primero, el guardar `agotado` falla contra la base viva aunque el código esté OK.

### 3.2 — B4: auditoría en dos tiempos 🟡 (lo que desbloquea la Fase 3)

Hoy `POST /auditor/despachos/:id/auditar` exige la firma de una vez y **auto-decide**
(cualquier diferencia ⇒ `Rechazado`). El proceso real es en dos tiempos: primero **comparar**
(ver diferencias), después **decidir + firmar**. Separalo en dos endpoints:

**1) `POST /auditor/despachos/:id/comparar`** — sin firma, sin cambiar estado.
```
body: { "items": [ { "id": "<uuid item>", "cantidad_auditor": 8 } ] }
resp: { "ok": true, "data": {
          "match": false,
          "differences": [
            { "id": "<uuid item>", "codigo_item": "...", "descripcion": "...",
              "cantidad_despachador": 10, "cantidad_auditor": 8, "diferencia": -2 }
          ] } }
```
- `match: true` cuando ninguna `diferencia` es distinta de 0.
- `diferencia = cantidad_auditor − cantidad_despachador`.

**2) `POST /auditor/despachos/:id/confirmar`** — decisión + firma, finaliza.
```
body: { "decision": "aprobado" | "inconsistencia" | "rechazado",
        "auditor_id": "...", "firma_data": "data:image/png;base64,...",
        "items": [ { "id": "<uuid item>", "cantidad_auditor": 8 } ] }
resp: { "ok": true, "data": { "estado": "<estado final>" } }
```
Mapa `decision → estado`:
- `aprobado` → `Auditado`
- `inconsistencia` → **`Recibido_con_inconsistencia`** (estado nuevo, terminal)
- `rechazado` → `Rechazado`

**Convenciones acordadas:**
- Usar **`id`** (PK del ítem) en el body, igual que en `/recolectar`. No `item_id`.
- Agregar `Recibido_con_inconsistencia` al enum de `cambiarEstadoSchema` y al mapa de
  transiciones (`Recolectado`/`En_recepcion` → ese estado).
- Guardá `cantidad_auditor` y `diferencia` por ítem, y la firma con `rol: "auditor"`.

### 3.3 — B5 (opcional, sin urgencia) 🟢

Si algún día `findById` devuelve `items`/`firmas` en vez de `traslados_items`/`traslados_firmas`,
borramos nuestro normalizador. No corre prisa.

---

## 4. Contrato de estados (una sola verdad)

```
Creado → En_recoleccion → Recolectado → { En_recepcion, Auditado }
En_recepcion → { Auditado, Rechazado }
(nuevo) Recolectado/En_recepcion → Recibido_con_inconsistencia   [terminal]
```
- **Despachador:** `Creado → En_recoleccion` (iniciar) y `En_recoleccion → Recolectado` (firmar).
- **Auditor:** cierra en `Auditado` / `Rechazado` / `Recibido_con_inconsistencia`.

---

## 5. Resumen de una línea

Ya está: B1, B2 (código), B3. Falta: **2 ALTER** (`agotado`, `auditor_id`) y **B4** (los
endpoints `comparar` + `confirmar` con el estado `Recibido_con_inconsistencia`). Con eso, el
Despachador y el Auditor del frontend —que ya están listos— cierran el flujo de punta a punta.
Cuando tengas B4, avisá y lo probamos juntos en vivo.

