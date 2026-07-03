# Pendientes del Backend — Traslados

> **Para:** el equipo de backend (Kevin).
> **De:** equipo de frontend (Johan) — paneles Despachador y Auditor.
> **Objetivo de este archivo:** que ambos apuntemos al mismo lugar. Primero te explico QUÉ
> estamos construyendo del lado del frontend y por qué, y después la lista concreta de lo que
> necesitamos de tu lado, con el contrato esperado. Nada acá te pide rehacer lo que ya hiciste
> (flujos + snapshot están muy bien) — es lo que falta para que el flujo cierre punta a punta.
>
> El detalle completo del sistema vive en [`SISTEMA_TRASLADOS.md`](./SISTEMA_TRASLADOS.md).

---

## 1. Qué estamos construyendo nosotros (para que se entienda el todo)

El proceso real tiene tres actores. Vos ya cubriste el **Admin** (crear despacho con snapshot
de inventario) y la infra de datos (snapshot SIESA + flujos). Nosotros hacemos los dos pasos
siguientes:

### Despachador (sede origen) — **en construcción ahora (Fase 2)**
Recibe la lista de productos con `cantidad_admin`. Va a bodega y por cada producto registra:
- **Completo** — recogió lo pedido.
- **Incompleto** — hay stock pero no alcanza → registra **cuánto** recogió (`0 < x < admin`).
- **Agotado** — no hay stock (recoge 0, pero es distinto de "no lo toqué").

Reglas: **nunca** puede exceder `cantidad_admin`, y lo incompleto/agotado se ve SIEMPRE en
pantalla (alerta permanente). Al finalizar, firma y pasamos el estado a `Recolectado`.

### Auditor (sede destino) — **Fase 3**
Recibe la mercancía y **escanea a ciegas** (sin ver lo que envió el origen). Al final se
compara. Si no coincide: recuenta, y si sigue mal, contacta origen y marca **recibido con
inconsistencia**. Firma y queda almacenado. De ahí sale el push al ERP (tu conector).

---

## 2. Lo que necesitamos de tu lado — checklist

| # | Tarea | Prioridad | Bloquea |
|---|-------|-----------|---------|
| B1 | Sincronizar migraciones (schema drift) | 🔴 Alta | Deploy / onboarding |
| B2 | Persistir "agotado" en `traslados_items` | 🔴 Alta | Fase 2 (despachador) |
| B3 | `findAll` debe aceptar `estado` como array (`.in`) | 🟡 Media | Listados de paneles |
| B4 | Rediseñar el flujo de auditoría (comparar antes de firmar) | 🟡 Media | Fase 3 (auditor) |
| B5 | (Opcional) normalizar respuesta a `items` | 🟢 Baja | — (ya lo manejamos) |

---

## 3. Detalle de cada pendiente

### B1 — Sincronizar migraciones (schema drift) 🔴

**Problema:** cambiaste la base viva pero `sql/001_create_tables.sql` no refleja la realidad:
- Dice `id BIGINT` — la base viva es `uuid DEFAULT gen_random_uuid()`.
- Le faltan las columnas nuevas de `traslados_items` (`flujo` en despachos; `factor`,
  `rotacion`, `stock_origen`, `stock_destino`, `consumo_destino`, `stock_seguridad`).
- La tabla **`traslados_snapshot` no tiene NINGUNA migración** — solo existe en la base viva.

**Por qué importa:** el archivo de migración es el espejo de la base. Si alguien despliega de
cero o entra al equipo, la base y el repo no coinciden y se rompe.

**Acción:** subí un `sql/002_sync_uuid_snapshot.sql` (o corregí el `001`) con el estado real:
`uuid`, columnas nuevas, y el `CREATE TABLE traslados_snapshot (...)` tal como está en Supabase.

### B2 — Persistir "agotado" en `traslados_items` 🔴

**Problema:** hoy solo existe `cantidad_despachador`. Si el despachador recoge 0 porque el
producto está **agotado**, se guarda igual que si simplemente no lo hubiera tocado. Para el
auditor y para el ERP, "agotado" es información distinta a "no recolectado".

**Acción propuesta:** agregar a `traslados_items`:
```sql
alter table public.traslados_items
  add column agotado boolean not null default false;
-- (opcional, más rico) add column motivo_faltante varchar(30); -- 'agotado' | 'incompleto' | null
```
Y en el endpoint de recolección (ver contrato abajo) aceptar ese dato por ítem.

**Contrato que vamos a mandar** a `POST /api/despachos/:id/recolectar`:
```json
{ "items": [
  { "id": "<uuid item>", "cantidad": 5, "agotado": false },
  { "id": "<uuid item>", "cantidad": 0, "agotado": true }
]}
```
Regla de servidor sugerida: **rechazar** cualquier `cantidad > cantidad_admin` (tope duro).
Hoy el `recolectarSchema` valida `cantidad >= 0`, pero no el tope superior — agregalo.

### B3 — `findAll` con `estado` como array 🟡

**Problema:** los paneles filtran por varios estados a la vez, ej. el despachador pide
`['Creado','En_recoleccion']`. Axios lo serializa como `?estado=Creado&estado=En_recoleccion`,
y `req.query.estado` llega como **array**. Hoy `Despacho.model.findAll` hace
`.eq("estado", filters.estado)` → con un array no matchea nada.

**Acción:**
```js
if (Array.isArray(filters.estado))      query = query.in("estado", filters.estado);
else if (filters.estado)                query = query.eq("estado", filters.estado);
```

### B4 — Rediseñar el flujo de auditoría 🟡

**Problema (choque de flujo, no de nombres):** hoy `POST /auditor/despachos/:id/auditar` exige
la firma de una vez y **auto-decide** (cualquier diferencia ⇒ `Rechazado`). El proceso real
del auditor es en dos tiempos: primero **comparar** (ver diferencias), después **decidir**
(aprobar con diferencias / rechazar / recibido-con-inconsistencia) y recién ahí firmar.

**Acción propuesta — separar en dos endpoints:**

1. `POST /auditor/despachos/:id/comparar` — recibe cantidades del auditor, NO firma, NO cambia
   estado. Devuelve la comparación:
   ```json
   { "match": false, "differences": [
     { "item_id": "<uuid>", "codigo_item": "...", "descripcion": "...",
       "cantidad_despachador": 10, "cantidad_auditor": 8, "diferencia": -2 }
   ]}
   ```
2. `POST /auditor/despachos/:id/confirmar` — recibe la decisión + firma y finaliza:
   ```json
   { "decision": "aprobado" | "rechazado" | "inconsistencia",
     "auditor_id": "...", "firma_data": "data:image/png;base64,...",
     "items": [{ "item_id": "<uuid>", "cantidad_auditor": 8 }] }
   ```
   Mapea `decision` → estado. Sugerimos un estado nuevo terminal **`Recibido_con_inconsistencia`**
   para el caso en que se recibe pese a que no cuadró (hoy no existe en la máquina de estados).

> Cuando definas esto, avisanos y alineamos el `AuditorPanel` al contrato exacto. No adaptamos
> el front al flujo viejo de una-sola-firma porque perderíamos "aprobar con diferencias", que
> es un requisito del negocio.

### B5 — (Opcional) normalizar respuesta a `items` 🟢

`findById` devuelve `traslados_items` / `traslados_firmas` (nombres crudos de Supabase). El
front espera `items` / `firmas`. **Ya lo resolvimos de nuestro lado** con un normalizador, así
que esto es opcional — pero si algún día el service mapea a `items`, borramos ese parche.

---

## 4. Contrato de estados (para que quede una sola verdad)

```
Creado → En_recoleccion → Recolectado → { En_recepcion, Auditado }
En_recepcion → { Auditado, Rechazado }
(propuesto nuevo) → Recibido_con_inconsistencia   [terminal]
```

El **despachador** mueve `Creado → En_recoleccion` (al iniciar) y `En_recoleccion → Recolectado`
(al firmar). El **auditor** cierra en `Auditado` / `Rechazado` / `Recibido_con_inconsistencia`.

---

## 5. Resumen de una línea

Vos tenés la boca del pipe (datos + creación) muy bien. Nos falta: **migraciones al día (B1)**,
**persistir agotado (B2)**, **filtro por array (B3)** y **auditoría en dos tiempos (B4)**. Con
eso, el flujo cierra de punta a punta y apuntamos todos al mismo objetivo.
