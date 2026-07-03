# Sistema de Traslados — Documento Maestro

> **Propósito de este archivo:** ser la única fuente de verdad del sistema de Traslados
> (frontend + backend). Si se pierde la sesión, el hilo, o cambia el equipo, se retoma
> desde acá sin arqueología. Cada avance importante se refleja aquí.
>
> **Última actualización:** 2026-07-03
> **Estado global:** 🟢 **FLUJO COMPLETO VERIFICADO END-TO-END en local (2026-07-03).**
> Despachador (recoge, marca faltantes, firma) → Auditor (recibe ciego, compara, decide, firma)
> → todo persistido, firmas en `traslados_firmas`. Fases 2 y 3 cerradas; backend B1–B4 OK; base
> viva al día. **Pendientes:** (1) fase de estética/UX del frontend (pospuesta a propósito),
> (2) desplegar el backend a Vercel (hoy probado en local, puerto 3001), (3) push al ERP (Fase 4,
> espera el conector).

---

## 0. Índice

1. [Qué es el sistema](#1-qué-es-el-sistema)
2. [Repositorios y rutas](#2-repositorios-y-rutas)
3. [Roles y flujo de negocio (el real, el que pidió Johan)](#3-roles-y-flujo-de-negocio)
4. [Dónde se almacena cada cosa](#4-dónde-se-almacena-cada-cosa)
5. [Contratos API — la realidad actual](#5-contratos-api--la-realidad-actual)
6. [Mismatches detectados (bloqueantes)](#6-mismatches-detectados-bloqueantes)
7. [Feature gaps vs. el proceso real](#7-feature-gaps-vs-el-proceso-real)
8. [Plan por fases](#8-plan-por-fases)
9. [Convenciones del proyecto](#9-convenciones-del-proyecto)
10. [Estrategia de testing](#10-estrategia-de-testing)
11. [Bitácora / dónde retomar](#11-bitácora--dónde-retomar)

---

## 1. Qué es el sistema

Traslados comerciales de mercancía entre sedes de Merkahorro. Una sede origen (bodega
Copacabana, `PV001`) despacha productos a una sede destino. El proceso tiene **tres roles**
y **doble verificación** (despachador en origen + auditor en destino) para no perder control
de inventario. El destino final de la información auditada es el **ERP (SIESA)**, vía un
conector que provee el backend.

**Alcance de ESTE equipo (Johan):** paneles **Despachador** y **Auditor**.
El **AdminPanel NO se toca** — lo mantiene el compañero de backend.

---

## 2. Repositorios y rutas

| Parte | Ruta local | Repo / deploy |
|---|---|---|
| Frontend | `Pagina-web_React/src/pages/Traslados/` | Repo web principal, rama `Johan`. Vite + React 19. |
| Backend | `BACKEND/backend-traslado/` | Repo propio, rama `main`. Express 4 + ESM. Deploy: Vercel (pendiente). |
| Base de datos | Supabase (Postgres) | Proyecto `pitpougbnibmfrjykzet`. Tablas `traslados_*`. |
| ERP | SIESA vía Connekta API | Solo lectura de catálogo/inventario hoy. Escritura (push del traslado) = pendiente del conector. |

**Conexión front→back:** `VITE_TRASLADOS_API_URL` (fallback `http://localhost:3000/api`).
Cliente axios centralizado en `services/trasladosApi.js`.

---

## 3. Roles y flujo de negocio

> Esta es la descripción del proceso REAL de Johan. Marca lo que el código todavía NO cubre.

### Admin (fuera de nuestro alcance)
Escoge productos SIESA, cantidades, sede origen→destino viendo inventario de cada una.
Genera el despacho → cae al panel del Despachador.

### Despachador (sede origen)
1. Recibe la lista de productos con cantidades pedidas por el admin.
2. Va a bodega y recoge físicamente.
3. Por cada producto puede marcar:
   - **Completo** — recogió lo pedido.
   - **Incompleto** — hay existencias pero no suficientes → registra **cuántas recogió**.
   - **Agotado** — no hay existencias.
4. **Regla dura:** nunca puede exceder la cantidad que pidió el admin.
5. **Regla de UX:** lo incompleto/agotado debe verse SIEMPRE, en todo momento, para no
   perderlo de vista.
6. Al finalizar → **firma digital** → el backend empuja al ERP vía conector.

### Auditor (sede destino)
1. Llega la mercancía en un carro.
2. Abre la app y **escanea las unidades que llegaron**, SIN saber cuántas envió el origen
   (auditoría **ciega**).
3. Al final se compara contra lo enviado:
   - **Coincide** → firma y recibido OK.
   - **No coincide** → alerta de inconsistencia por producto → **recontar**.
   - Si al recontar sigue mal → **contactar sede origen** → marcar **recibido con
     inconsistencia**.
4. Firma digital → queda almacenado.

---

## 4. Dónde se almacena cada cosa

**Decisión de arquitectura (confirmada):**

| Dato | Almacén | Estado |
|---|---|---|
| Cabecera, items, cantidades, diferencias, estado | **Supabase / Postgres** (`traslados_despachos`, `traslados_items`) | ✅ Modelado |
| Firmas digitales | `traslados_firmas` (base64 en `TEXT`) | ✅ MVP / ⚠️ ver nota |
| Resultado final auditado | Supabase → **push al ERP (SIESA)** vía conector | 🔜 Conector pendiente |
| Catálogo / inventario | SIESA (Connekta), cacheado en disco 30 min | ✅ |

**Supabase es la fuente de verdad. El ERP es el destino final, no el almacén primario.**

> ⚠️ **Nota de arquitecto sobre firmas:** guardarlas en base64 dentro de una columna `TEXT`
> funciona para el MVP, pero infla cada fila y penaliza toda query que traiga el despacho.
> **Evolución recomendada:** subir la imagen a **Cloudflare R2** (el repo web ya lo usa) y
> guardar en Postgres solo la **URL + un hash**. No es bloqueante ahora; queda como deuda
> técnica consciente.

---

## 5. Contratos API — la realidad actual

> Lo que el backend REALMENTE expone hoy (verificado en código, no en el README).
> Respuesta exitosa siempre: `{ ok: true, data }`. Error: `{ error }` o `{ ok:false, error, detalles }`.

### Despachos (`/api/despachos`)
| Método | Ruta | Body / Query | Devuelve |
|---|---|---|---|
| GET | `/` | `?estado=&despachador_id=` (string simple) | `data: [despachos]` |
| GET | `/:id` | `?auditor=true` oculta `cantidad_despachador` | `data: {..., traslados_items, traslados_firmas}` |
| POST | `/` | `{destino, despachador_id, admin_id?, criterios?, items:[{codigo_item, cantidad>0, ...}]}` | `data: despacho` |
| PATCH | `/:id/estado` | `{estado, firma_data?}` | `data: despacho` |
| POST | `/:id/recolectar` | `{items:[{id:uuid, cantidad>=0}]}` | `data: [items]` |
| GET | `/:id/planilla` | `?tipo=recoleccion\|final` | Excel binario |

### Auditor (`/api/auditor`)
| Método | Ruta | Body | Devuelve |
|---|---|---|---|
| GET | `/despachos` | — | `data: [despachos Recolectado/En_recepcion, ciegos]` |
| GET | `/despachos/:id` | — | `data: {..., traslados_items ciegos}` |
| POST | `/despachos/:id/auditar` | `{items:[{id:uuid, cantidad_auditor>=0}], firma_data (requerida)}` | `data: {estado, hayDiferencias, items}` |

### Máquina de estados (en `Despacho.model.js updateStatus`)
```
Creado → En_recoleccion → Recolectado → { En_recepcion, Auditado }
En_recepcion → { Auditado, Rechazado }
Auditado / Rechazado = terminales
```

### Modelo de datos (esquema VIVO en Supabase — fuente de verdad, 2026-07-02)
`traslados_despachos`, `traslados_items`, `traslados_firmas`.
**`id = uuid DEFAULT gen_random_uuid()`** en las tres; `despacho_id = uuid` (FK).

> ⚠️ **Schema drift:** el archivo `sql/001_create_tables.sql` del repo TODAVÍA dice `BIGINT`
> y no tiene las columnas nuevas de abajo. El compañero cambió la base viva sin actualizar la
> migración. **Acción pendiente:** sincronizar `001` (o crear `002`) para que la migración
> refleje la realidad. Hasta entonces, NO confiar en el archivo — confiar en la base viva.

**`traslados_despachos`** — nuevo campo: `flujo VARCHAR(20) DEFAULT 'general'` (tipo de traslado).

**`traslados_items`** — campos (incluye los NUEVOS de inventario/rotación):
`codigo_item`, `descripcion`, `unidad_medida VARCHAR(20)`, `factor NUMERIC(12,4)`,
`rotacion`, `stock_origen`, `stock_destino`, `consumo_destino`, `stock_seguridad`,
`sugerido`, `cantidad_admin`, `cantidad_despachador`, `cantidad_auditor`, `diferencia`,
`aceptado`.

**`traslados_firmas`** — `rol` ('despachador'|'auditor'), `firma_data TEXT` (base64).

---

## 6. Mismatches detectados (bloqueantes)

> Estos hacen que HOY el frontend y el backend no funcionen juntos. Cada uno con su fix.
> Estado: 🔴 sin resolver | 🟡 en progreso | ✅ resuelto.

| # | Problema | Dónde | Fix propuesto | Estado |
|---|---|---|---|---|
| 1 | **IDs esquizofrénicos.** SQL usa `BIGINT`; validators exigen `z.string().uuid()`; front hace `id.slice(0,8)`. | `sql/001`, `validators.js`, ambos paneles | **RESUELTO: canónico = UUID.** La base viva de Supabase ya está en `uuid DEFAULT gen_random_uuid()` (verificado 2026-07-02). Validators y front YA lo asumían → quedan alineados solos. ⚠️ Queda **schema drift**: `sql/001_create_tables.sql` sigue en BIGINT — sincronizar (ver #8). | ✅ |
| 2 | **Los items nunca aparecen.** Model devuelve `traslados_items`; front lee `.items`. | `Despacho.model.js` vs paneles | **RESUELTO (lado front):** módulo puro `utils/despachoTrasladoNormalizer.js` lee `items ?? traslados_items` en un solo lugar; aplicado en ambos paneles + test. | ✅ |
| 3 | **Auditoría dispara a 404.** Front hace `POST /despachos/:id/auditar`; la ruta real es `/auditor/despachos/:id/auditar`. | `AuditorPanel.jsx` | Apuntar el front a `/auditor/despachos/:id/auditar`. | 🔴 |
| 4 | **Choque de FLUJO, no solo de campos.** El front quiere: auditar → ver diferencias → decidir aprobar/rechazar → firmar. El back exige `firma_data` ANTES de auditar y **auto-decide** (cualquier diferencia ⇒ `Rechazado`, sin "aprobar con diferencias"). Además: front espera `{match, differences}`, back devuelve `{estado, hayDiferencias, items}`; front manda `item_id`, back valida `id`. | `AuditorPanel.jsx` ↔ `auditor.controller/service` | **Coordinar con backend.** El flujo del front (que coincide con el proceso real de Johan: recontar, contactar origen, recibir-con-inconsistencia) es el correcto. El back debe ofrecer un paso de comparación previo a la firma y permitir aprobación manual. NO adaptar el front hacia abajo. | 🔴 (backend) |
| 5 | **La firma nunca se guarda.** Front manda `{firma}`; back valida `{firma_data}`. Se descarta en silencio. | ambos paneles ↔ `validators/service` | **RESUELTO (lado front):** ambos paneles ahora mandan `firma_data` en `useActualizarEstado`. | ✅ |
| 6 | **`cantidad_despachador` queda null.** El panel es binario (Set de códigos), nunca llama `/recolectar`, nunca envía cantidades. Luego `diferencia = auditor - null`. | `DespachadorPanel.jsx` | Rediseñar recolección con cantidades reales + llamar `/recolectar` antes de `Recolectado` (ver Fase 2). | 🔴 |
| 7 | **Filtro de estado como array.** Front manda `estado:['Creado','En_recoleccion']`; back hace `.eq("estado", array)` → no matchea. | `DespachadorPanel/AuditorPanel` ↔ `Despacho.model.findAll` | **RESUELTO (backend, commit `11c5b53`):** `findAll` usa `.in` para arrays, `.eq` para string. | ✅ |
| 9 | **Mensajes de error del backend no se mostraban.** Back responde `{ ok:false, error }`; el front leía `data.message` → caía al genérico de axios (incl. el 422 del tope). | ambos paneles | **RESUELTO (front):** helper `mensajeErrorTraslado` lee `data.error` primero; aplicado en los 8 sitios. | ✅ |
| 8 | **El despachador nunca pasa a `En_recoleccion`.** Al finalizar salta `Creado → Recolectado`, transición inválida. | `DespachadorPanel.jsx` + `updateStatus` | **RESUELTO (front):** botón "Iniciar recolección" hace `Creado → En_recoleccion`; el finalizar hace `En_recoleccion → Recolectado`. | ✅ |

---

## 7. Feature gaps vs. el proceso real

Cosas del proceso de Johon que **no existen** todavía en código:

- **Despachador — estados por item:** no hay "agotado" ni "incompleto con cantidad". Hoy es
  checkbox. Falta también el tope (nunca exceder `cantidad_admin`) y la alerta permanente de
  lo incompleto/agotado.
- **Auditor — recepción por escaneo:** hoy es teclear números a mano. Falta el escaneo ciego
  de unidades, el conteo acumulado por producto, el loop de **recontar**, el estado
  **contactar origen** y **recibido con inconsistencia**.
- **Push al ERP:** pendiente del conector del compañero.
- **Autenticación:** `despachador_id` / `auditor_id` hoy son strings libres (localStorage /
  env / hardcode `d1`, `auditor1`). Falta integrarlo con la auth real de la app (Supabase).

---

## 8. Plan por fases

> Orden pensado para tener SIEMPRE algo que funcione end-to-end antes de agregar features.

- **Fase 0 — Documentación (este archivo).** ✅ en curso.
- **Fase 1 — Alinear contratos.** Que el flujo actual (aunque binario) funcione front↔back de
  punta a punta.
  - #1 (id) ✅ resuelto: canónico UUID. **Sub-tarea pendiente:** sincronizar `sql/001` (drift).
  - Restan #2 (items/traslados_items), #3 (ruta auditar 404), #4 (contrato auditoría),
    #5 (firma/firma_data), #7 (filtro estado array). Estos son los bloqueantes reales que quedan.
- **Fase 2 — Despachador real.** 🟢 **Frontend LISTO.** Cantidad por ítem, agotado, incompleto,
  tope duro por `cantidad_admin`, alerta permanente de faltantes, botón "Iniciar recolección"
  (`En_recoleccion`), finalizar = `POST /recolectar` + firma → `Recolectado`. Lógica pura en
  `utils/recoleccionDespacho.js` (+ tests). **Depende del backend B2** para persistir `agotado`
  (hoy el back descarta ese campo; la cantidad sí se guarda). Ver `PENDIENTES_BACKEND.md`.
- **Fase 3 — Auditor real.** 🟡 **Frontend LISTO (adelantado contra el contrato B4).** Escaneo
  ciego (endpoints `/auditor/despachos` y `/:id`), conteo por ítem, botón "Comparar" →
  `POST /comparar`, tabla de diferencias, decisiones **Recontar / Recibir con inconsistencia /
  Rechazar** → `POST /confirmar` + firma. Lógica pura en `utils/auditoriaDespacho.js` (+ tests),
  hooks en `hooks/useAuditoria.js`. **Bloqueado en runtime hasta que el backend implemente B4**
  (`/comparar` y `/confirmar` hoy dan 404). Estado nuevo esperado: `Recibido_con_inconsistencia`.
- **Fase 4 — Integración ERP.** Conectar el push cuando el compañero entregue el conector.
- **Fase 5 — Endurecimiento.** Auth real, firmas a R2, CSP (ver guía del repo web), tests e2e.

---

## 9. Convenciones del proyecto

- **Nombres NUNCA genéricos** (hay otros sistemas en el mismo repo). Prefijos ya usados y a
  respetar: tablas `traslados_*`, CSS BEM `desp-panel__*` y `aud-panel__*`, archivos con
  nombre del dominio (`DespachadorPanel`, `AuditorPanel`, `trasladosApi`).
- **Backend:** ESM puro, MVC (Routes→Controllers→Services→Models), Zod en middleware,
  errores centralizados en `errorHandler`.
- **Frontend:** React 19 (sin `useMemo`/`useCallback` innecesarios por el compiler),
  TanStack Query para datos, axios centralizado, CSS por panel.
- **Secretos:** nunca en variables `VITE_*` (quedan en el bundle). `service_role` de Supabase
  solo en backend.
- **Commits:** convencionales, sin atribución de IA.

---

## 10. Estrategia de testing

> Hoy NO hay tests. Se agregan a medida que construimos (no retroactivo masivo).

- **Backend:** unit sobre services y model helpers (transiciones de estado, cálculo de
  `diferencia`, reglas de tope). Runner a definir (node:test nativo encaja con ESM, cero deps).
- **Frontend:** los paneles con Vitest + Testing Library; lógica de comparación auditor y
  reglas del despachador como funciones puras testeables (extraerlas de los componentes).
- **Regla:** cada fix de mismatch y cada feature nueva entra con su test.

---

## 11. Bitácora / dónde retomar

> Append-only. Lo más reciente arriba. Al retomar, leer esto primero.

### 2026-07-03 (tarde 8) — ✅ FLUJO COMPLETO VERIFICADO END-TO-END
- Johan probó en local: firma se guarda y **el flujo cierra completo** (despachador → auditor,
  con firmas persistidas). Milestone: el sistema camina de punta a punta.
- **Cerrado:** Fases 0, 1, 2, 3. Los 9 mismatches. Contratos front↔back. Firmas. Base viva.
- **Lo que queda (nuevas fases, no bloqueantes del core):**
  1. **Estética/UX del frontend** — próxima fase acordada (funcionalidad primero, belleza después).
  2. **Deploy backend a Vercel** — hoy corre en local (3001); falta la URL productiva.
  3. **Fase 4 — push al ERP** — espera el conector de Juan.
  4. Endurecimiento: auth real (hoy `d1`/`auditor1` hardcodeados), firmas a R2.

### 2026-07-03 (tarde 7) — Fix bug de firma (bloqueaba finalizar)
- **Bug:** `SignatureModal.handleConfirm` usaba `getTrimmedCanvas()`, que arrastra el paquete
  `trim-canvas` → rompe con Vite (`import_trim_canvas.default is not a function`). Reventaba
  ANTES de generar el dataURL, por eso NO se guardaba ninguna firma.
- **Fix:** usar `getCanvas().toDataURL('image/png')` (no recorta bordes, pero captura la firma).
- **Aclaración de storage:** las firmas SÍ se guardan en `traslados_firmas` (base64, rol
  despachador/auditor) — el despachador vía `cambiarEstado`, el auditor vía `confirmarAuditoria`.
  No aparecían por el crash, no por falta de wiring. (Evolución futura: firmas a R2, ver §4.)
- **Nota de alcance:** la estética/UX del frontend se pospone a una fase aparte (acordado con
  Johan): primero funcionalidad end-to-end, después "belleza".

### 2026-07-03 (tarde 6) — Backend local levantado + smoke test OK
- Backend corriendo en **local, puerto 3001** (`/api/health` responde). CORS abierto (`cors()`).
- Frontend apuntado con **`.env.local`** → `VITE_TRASLADOS_API_URL=http://localhost:3001/api`
  (cubierto por `*.local` en `.gitignore`, no se commitea). **Requiere reiniciar `npm run dev`.**
- **Smoke test OK:** `GET /api/despachos` y `GET /api/auditor/despachos` responden
  `{ok:true,data:[]}` (200, conexión a Supabase viva). Vacíos porque aún no hay despachos creados.
- **Para ver el flujo:** falta un despacho de prueba (lo crea el AdminPanel de Juan, o un INSERT
  seed en Supabase).

### 2026-07-03 (tarde 5) — ALTERs corridos en la base viva
- Johan corrió los 2 `ALTER` en Supabase. Verificado por consulta a `information_schema`:
  `traslados_despachos.auditor_id` (character varying) y `traslados_items.agotado` (boolean) ✅.
- **Base viva al día.** Ya no hay pendientes de esquema ni de código.
- **Único pendiente:** levantar/desplegar el backend para la prueba end-to-end. Al correr local,
  ojo con el puerto: `trasladosApi` cae por defecto a `http://localhost:3000/api`, pero el backend
  usa `PORT` (README menciona 3001) → alinear `VITE_TRASLADOS_API_URL` con el puerto real.

### 2026-07-03 (tarde 4) — Juan Manuel implementó B4 (verificado en código)
- **B4 ✅ (commits hasta `135f79a`):** endpoints `/auditor/despachos/:id/comparar` y `/confirmar`
  implementados **exactamente al contrato acordado**:
  - `compararAuditoria` → `{ match, differences:[{id, codigo_item, descripcion,
    cantidad_despachador, cantidad_auditor, diferencia}] }`. Coincide 1:1 con lo que consume
    nuestro `AuditorPanel`.
  - `confirmarAuditoria` → mapea `aprobado→Auditado`, `inconsistencia→Recibido_con_inconsistencia`,
    `rechazado→Rechazado`; persiste cantidad_auditor+diferencia, firma (rol auditor) y `auditor_id`.
  - Validators usan `id` (no `item_id`); enum de estados incluye `Recibido_con_inconsistencia`;
    transiciones actualizadas en `updateStatus`.
- **Mismatch #4 RESUELTO.** Front y back del auditor ahora hablan el mismo idioma.
- **También subió:** flujo Llano (`productosLlanoSchema`), paginación SIESA, y su propio
  `docs/ARQUITECTURA.md` (snapshot/flujos). Todo de su carril (admin/datos).
- **Bloqueos restantes para probar end-to-end (NO de código):**
  1. Correr los 2 `ALTER` en la base viva: `agotado` (traslados_items) y `auditor_id`
     (traslados_despachos). Sin ellos, recolectar/confirmar fallan contra la base. No verificable
     desde acá.
  2. **Backend sin desplegar** (Vercel pendiente). El front necesita una URL viva.
- **Situación:** TODO el código (front + back) está completo y alineado. Falta solo lo operativo
  (2 ALTER + deploy) para la prueba en vivo.

### 2026-07-03 (tarde 3) — Fase 3 Auditor (frontend) adelantada contra contrato B4
- **`AuditorPanel` reescrito (Fase 3):** recepción **ciega por escaneo** (endpoints
  `/auditor/despachos` + `/:id`), conteo por ítem (escáner físico/cámara/manual), botón
  "Comparar" → `POST /comparar` (el backend revela diferencias), tabla comparativa Enviado vs
  Contado, y decisiones **Recontar** (vuelve a escanear) / **Recibir con inconsistencia** /
  **Rechazar** → `POST /confirmar` + firma.
- **Lógica pura nueva:** `utils/auditoriaDespacho.js` (decisiones, payloads, resumen de
  diferencias) con **9 tests**. Suite total del módulo: **46 tests verde**.
- **Hooks nuevos:** `useCompararAuditoria`, `useConfirmarAuditoria` en `hooks/useAuditoria.js`.
- **Bloqueo runtime:** los endpoints `/comparar` y `/confirmar` (B4) todavía no existen → 404
  hasta que Juan Manuel los implemente con el contrato acordado. Construido a propósito por adelantado.
- **Próximo paso:** Juan Manuel implementa B4 (y el `ALTER auditor_id` + estado
  `Recibido_con_inconsistencia`); apenas esté, conectamos y probamos end-to-end.

### 2026-07-03 (tarde 2) — Backend respondió B1/B2/B3 + fix #9
- **Verificado en código (commits `e0ea9c3`, `11c5b53`):**
  - **B1 ✅** `sql/002_uuid_snapshot.sql` autoritativo (UUID + snapshot + `agotado`). Drift cerrado.
  - **B2 ✅** `recolectar` acepta `agotado`; **tope duro** en `Item.model` → `422` si
    `cantidad > cantidad_admin`. Falta operativo: correr el `ALTER add column agotado` en la base viva.
  - **B3 ✅** `findAll` con `.in`/`.eq`.
  - **B4 ⏳** Juan Manuel de acuerdo; pidió definir (a) `item_id` vs `id`, (b) columna `auditor_id`.
    **Respondido en `PENDIENTES_BACKEND.md`:** usar `id`; agregar `auditor_id varchar(100)`;
    agregar estado `Recibido_con_inconsistencia`; contrato en 2 tiempos comparar→confirmar.
- **Mismatch #9 (nuevo) RESUELTO (front):** el backend responde `{ ok:false, error }` pero los
  paneles leían `data.message` → los errores del back (incl. 422) no se veían. Helper
  `mensajeErrorTraslado` + aplicado en 8 sitios. **37 tests verde.**
- **Pendiente operativo (DBA):** `ALTER traslados_items add column agotado` y (para B4)
  `ALTER traslados_despachos add column auditor_id` en la base viva.
- **Próximo paso:** que Juan Manuel implemente B4 con el contrato acordado → nosotros Fase 3.

### 2026-07-03 (tarde) — Fase 2 Despachador (frontend) + handoff al backend
- **`DespachadorPanel` reescrito (Fase 2):** cantidad real por ítem, checkbox "agotado",
  detección de incompleto, **tope duro** (nunca > `cantidad_admin`, con aviso), **alerta
  permanente sticky** de faltantes, botón "Iniciar recolección" (`Creado → En_recoleccion`, cierra
  el blocker #8). Finalizar = `POST /despachos/:id/recolectar` (cantidades) + `PATCH estado`
  (`Recolectado`) con firma.
- **Lógica pura nueva:** `utils/recoleccionDespacho.js` (estados, tope, resumen, payload) con
  **17 tests**. Suite total del módulo: **33 tests verde**.
- **Hook nuevo:** `useRegistrarRecoleccion` (POST /recolectar) en `hooks/useDespacho.js`.
- **Handoff creado:** `docs/PENDIENTES_BACKEND.md` — explica al compañero qué hacemos y le deja
  la lista B1–B5 (migraciones, persistir `agotado`, filtro array, auditoría en 2 tiempos).
- **Nota lint:** los `import React` sin usar son estilo del repo (288 archivos); no se tocan.
- **Próximo paso:** que el backend haga B2 (persistir `agotado`) y B3; nosotros → Fase 3 (auditor)
  cuando el compañero defina el contrato de auditoría en 2 tiempos (B4).

### 2026-07-03 — Revisión del backend del compañero (commit `1634a66`)
- **Aporte del compañero (alineado y BIEN):**
  - `config/flujos.js` — multi-flujo: `general` (origen PV001 → 5 sedes, lógica `stock_seguridad`)
    y `llano` (origen 00301 → PV004, lógica `abc`). Define SEDES, orígenes/destinos y helpers.
  - `services/snapshot.service.js` — trae SIESA (Connekta) por cron y lo persiste en
    `traslados_snapshot` (upsert + prune). Resuelve la lentitud de SIESA; mismo patrón que el
    módulo Domicilios. Lectura en ms.
  - Crear despacho ahora guarda **snapshot de inventario** por item: `flujo`, `factor`,
    `rotacion`, `stock_origen/destino`, `consumo_destino`, `stock_seguridad` (validators + model).
  - **Veredicto:** es la "boca del pipe" (datos + creación). Ortogonal a nuestro carril
    (recolección/auditoría). No choca con nuestros fixes; los complementa.
- **Lo que NO tocó (sigue abierto):**
  - **Higiene de migraciones (⚠️ empeoró):** `sql/001` sigue en BIGINT (live DB = uuid), le
    faltan las columnas nuevas, y **`traslados_snapshot` NO tiene migración** — vive solo en la
    base viva. La base y el repo están divergiendo. Esto muerde en deploy/onboarding.
  - #3 (ruta auditar), #4 (flujo auditor), #7 (filtro array), #8 (transición) — intactos.
- **Impacto para nosotros:** el `flujo` importa — hay DOS orígenes (PV001 y 00301), así que los
  paneles NO deben asumir PV001. El `sugerido` ya tiene fuente real (snapshot).
- **Próximo paso:** sigue siendo **Fase 2 (despachador real)**. #4 (auditor) requiere decisión
  conjunta. Pedir al compañero: sincronizar migraciones (drift + tabla snapshot).

### 2026-07-02 (tarde 2) — Fase 1 arrancada + tooling de tests
- **Vitest instalado** (no había NINGÚN test en el repo). Config en `vite.config.js` (`test`),
  scripts `test` / `test:watch` en `package.json`. Runner: `npm test`.
- **Mismatch #2 RESUELTO** (front): nuevo módulo puro
  `src/pages/Traslados/utils/despachoTrasladoNormalizer.js` — desempaqueta el sobre `{ok,data}`
  y lee `items ?? traslados_items`. Aplicado en Despachador y Auditor. **16 tests, todos verde.**
- **Mismatch #5 RESUELTO** (front): ambos paneles mandan `firma_data` (no `firma`).
- **Nuevo blocker #8 descubierto:** el despachador salta `Creado → Recolectado` (transición
  inválida). El finalizar fallará hasta resolverlo en Fase 2.
- **Mismatch #4 reclasificado:** no es cosmético, es choque de flujo. Queda para coordinar con
  el backend (no adaptar el front hacia abajo).
- **Pendientes de coordinación con el compañero:** sync de `sql/001` (drift), #3 (ruta), #4, #7.
- **Próximo paso:** Fase 2 (despachador real: cantidades, agotado, incompleto, tope,
  `En_recoleccion`) — es lo que desbloquea el flujo end-to-end de origen.

### 2026-07-02 (tarde) — id canonizado a UUID
- **Verificado contra el esquema VIVO de Supabase:** las tres tablas ya usan
  `id uuid DEFAULT gen_random_uuid()` y `despacho_id uuid`. El compañero lo cambió en la base,
  NO en el repo → **mismatch #1 RESUELTO** (canónico = UUID; validators y front ya lo asumían).
- Descubierto **schema drift**: `sql/001_create_tables.sql` sigue en BIGINT y le faltan columnas
  nuevas (`flujo` en despachos; `factor, rotacion, stock_origen, stock_destino, consumo_destino,
  stock_seguridad` en items; `unidad_medida` ahora varchar(20)). Sincronizar migración = pendiente.
- **Próximo paso:** seguir Fase 1 con los mismatches restantes (#2, #3, #4, #5, #7), o hacer
  primero la sync de `sql/001`. Sugerido: sync rápido de `001` y luego #2→#7 en orden.

### 2026-07-02 (mañana)
- Revisión completa de front + back. Se detectaron 7 mismatches bloqueantes (§6) y los
  feature gaps (§7). Se creó este documento maestro (Fase 0).
- **Decisión de almacenamiento** confirmada (§4): Supabase fuente de verdad, ERP destino final.
