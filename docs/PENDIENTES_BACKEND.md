# Handoff Backend — Traslados (para Juan Manuel)

> **Para:** Juan Manuel (backend).
> **De:** Johan (frontend — paneles Despachador y Auditor).
> **Última actualización:** 2026-07-03.
>
> 🎉 **Hito:** el flujo completo **ya cierra de punta a punta en local** — despachador recoge,
> marca faltantes/agotados y firma → auditor recibe a ciegas, compara, decide y firma → todo se
> persiste, firmas incluidas. El core está funcionando. Este doc es el estado + lo que falta de
> cada lado para llevarlo a producción.
>
> Detalle completo del sistema: [`SISTEMA_TRASLADOS.md`](./SISTEMA_TRASLADOS.md).

---

## 0. Estado de un vistazo

| # | Tarea | Estado |
|---|-------|--------|
| B1 | Sincronizar migraciones (drift) | ✅ Hecho — `sql/002_uuid_snapshot.sql` espeja la base (UUID + snapshot + `agotado`). |
| B2 | Persistir `agotado` + tope duro | ✅ Hecho — 422 si `cantidad > cantidad_admin`; ALTER `agotado` corrido en la base viva. |
| B3 | `findAll` con `estado` array | ✅ Hecho — `.in` para arrays, `.eq` para string. |
| B4 | Auditoría en dos tiempos (`comparar`/`confirmar`) | ✅ Hecho — endpoints al contrato; estado `Recibido_con_inconsistencia` en enum + transiciones; ALTER `auditor_id` corrido. |
| B5 | Normalizar `items` | 🟢 Opcional (lo manejamos en el front). |

**Todo lo que pedimos para cerrar el flujo está hecho.** Lo que sigue (§3) es llevarlo a
producción: desplegar y el push al ERP.

---

## 1. Lo que YA dejamos listo nosotros (frontend)

Probado end-to-end contra tu backend local. Lógica pura con Vitest (**46 tests verde**).

### Despachador (Fase 2) ✅
- Cantidad real por ítem, **agotado** (checkbox), **incompleto** (detectado), **tope duro**
  (no pasa de `cantidad_admin`), **alerta permanente** de faltantes siempre visible.
- "Iniciar recolección" (`Creado → En_recoleccion`) → finalizar = `POST /recolectar` + firma
  (`En_recoleccion → Recolectado`).

### Auditor (Fase 3) ✅
- **Recepción ciega por escaneo** (`/auditor/despachos` + `/:id`), conteo por ítem.
- "Comparar" → `POST /comparar` → tabla de diferencias → decisiones **Recontar /
  Recibir con inconsistencia / Rechazar** → `POST /confirmar` + firma.

### Ajustes de contrato resueltos del lado front
- Leemos `items` aunque devuelvas `traslados_items`; mandamos `firma_data`; leemos tus errores
  como `{ ok:false, error }`.

---

## 2. Lo que hiciste vos (backend) ✅

- **B1–B4** (arriba). Verificado leyendo el código: `comparar`/`confirmar` al contrato,
  transiciones y estado nuevo correctos.
- **Infra de datos:** `config/flujos.js` (multi-flujo general/llano) y
  `services/snapshot.service.js` (snapshot SIESA por cron → `traslados_snapshot`).
- **Flujo Llano** (`productosLlanoSchema`) y paginación SIESA.

---

## 3. Lo que falta de TU lado (para producción)

### 3.1 — Desplegar el backend a Vercel 🔴
Hoy corre en local (puerto 3001) y el front lo apunta con `.env.local`. Para que funcione fuera
de tu máquina hace falta la **URL productiva**:
- Configurar las env vars en Vercel (Supabase `service_role`, Connekta, etc. — nunca en el repo).
- Confirmar `vercel.json` y `maxDuration` (el refresh de SIESA es largo).
- Pasarnos la URL final → la ponemos en `VITE_TRASLADOS_API_URL` del frontend productivo.

### 3.2 — Fase 4: push al ERP (SIESA) 🟡
Cuando un despacho llega a estado terminal del auditor (`Auditado` /
`Recibido_con_inconsistencia`), hay que **empujar el resultado al ERP** vía el conector.
- Definir el disparador (¿al confirmar la auditoría? ¿un job aparte?).
- Definir qué se envía (cantidades finales, diferencias, quién firmó).
- Es tu conector — cuando lo tengas, avisá y vemos si el front necesita mostrar algún estado de
  "sincronizado con ERP".

### 3.3 — B5 (opcional) 🟢
Si `findById` algún día devuelve `items`/`firmas` en vez de `traslados_items`/`traslados_firmas`,
borramos nuestro normalizador. Sin prisa.

---

## 4. Lo que falta de NUESTRO lado (frontend) — para que veas el cuadro completo

- **Estética / UX** — la funcionalidad está; falta el diseño (sistema de tokens, no pantalla por
  pantalla). Es nuestra próxima fase.
- **Auth real** — hoy `despachador_id`/`auditor_id` están hardcodeados (`d1`, `auditor1`).
  Falta integrarlos con la sesión real (Supabase). *Esto lo coordinamos con vos* porque define
  cómo asignás despachador/auditor a cada despacho.
- **Apuntar a la URL productiva** — apenas despliegues (§3.1).
- **Firmas a R2 (deuda técnica compartida)** — hoy base64 en `TEXT`; a futuro subir la imagen a
  Cloudflare R2 y guardar solo la URL. Toca a los dos (tú el modelo, nosotros el upload).

---

## 5. Contrato de estados (una sola verdad)

```
Creado → En_recoleccion → Recolectado → { En_recepcion, Auditado, Recibido_con_inconsistencia, Rechazado }
En_recepcion → { Auditado, Rechazado, Recibido_con_inconsistencia }
Auditado / Rechazado / Recibido_con_inconsistencia = terminales
```

---

## 6. Resumen de una línea

El core cierra de punta a punta. Del backend falta **deploy a Vercel** y el **push al ERP
(Fase 4)**. Del front, **estética** y **auth real** (esta última la coordinamos juntos). Todo lo
demás, hecho.

