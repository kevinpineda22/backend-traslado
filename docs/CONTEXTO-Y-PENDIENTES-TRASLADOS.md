# Traslados — Contexto, estado y pendientes (handoff para IA/humano)

> Documento vivo. Objetivo: que cualquier IA (o persona) entienda TODA la lógica
> del módulo de Traslados, qué se hizo, qué está roto/pendiente, y cómo proceder.
> Última actualización: 2026-07-24.

---

## 0. Cómo usar este documento

- Si vas a tocar **datos** (consumo, inventario, clases, sugerido), leé primero la
  **sección 4** (integridad del snapshot) y la **4.7** (inventario = CantidadDisponible).
  Es el problema más serio y todo lo demás depende de que los datos estén bien.
- Si vas a tocar **el refresh / actualización**, leé la **sección 5** (migración a
  GitHub Actions). El cron de Vercel se **eliminó** por el límite de 300s.
- Si vas a tocar **UI o cálculo de sugerido/días**, leé secciones 2, 3 y 6.
- Antes de cualquier cambio revisá la **sección 10** (restricciones que NO se rompen).

---

## 1. Qué es el sistema

Panel administrativo de **traslados entre sedes** de Merkahorro. El admin arma un
despacho: elige una sede destino, el sistema le sugiere qué productos y cuánto
mandar (según inventario, consumo y reglas por flujo), y crea el despacho que luego
recolectan/auditan otras personas.

Dos repos separados (deploy independiente):

- **Backend**: `C:\Users\juan.isaza\Desktop\BACKENDS\Backend-traslados`
  Node/Express en Vercel (serverless). Auto-deploy en `git push` a `main`.
  Repo GitHub: `kevinpineda22/backend-traslado`.
- **Frontend**: `C:\Users\juan.isaza\Desktop\merkaPage\Pagina-web_React`
  React 19 + Vite 7. Deploy con `npm run deploy` (build + scp a hosting Apache).

Backend en producción: `https://backend-traslado.vercel.app/api`.

---

## 2. Arquitectura y flujo de datos

### 2.1. Origen de los datos: SIESA vía Connekta (patrón snapshot)

SIESA (ERP) se consulta a través de **Connekta**, que solo expone **consultas
dinámicas registradas** (sin parámetros). Traer el dataset completo tarda minutos,
así que **NO se consulta por request de usuario**. En su lugar:

1. Un **workflow de GitHub Actions** (no el cron de Vercel — ver sección 5) trae TODO
   desde Connekta, lo **agrega por (bodega, item)** y lo persiste en Supabase
   (**`traslados_snapshot`**).
2. Los endpoints de usuario leen del snapshot en milisegundos.

La consulta registrada se llama **`merkahorro_traslados_dev`** (configurable por env
`CONNEKTA_QUERY_TRASLADOS`). Filtra 7 bodegas: `PV001, 00301, 00201, 00701, 00801,
00601, 00401`.

⚠️ **Connekta topea `tamPag` en 1000**. Pedir páginas más grandes da error
*"El valor de tamPag no puede superar los 1000 registros"*. `CONNEKTA_TAM_PAG` default
= 1000 (`snapshot.service.js`).

### 2.2. Pipeline del snapshot (`src/services/snapshot.service.js`)

- `traerDeConnekta()`: pide la página 1, ve cuántas páginas hay y trae el resto **en
  paralelo con concurrencia 3** (más paralelismo deadlockeaba el SQL Server detrás de
  Connekta). Devuelve `{ filas, crudas, totalDeclarado }`.
- `agregarPorBodegaItem(rows)`:
  1. **Dedup** por `(bodega|item|instalación)` — el mismo ítem se repite por
     instalación y los JOINs de criterios lo duplican más.
  2. Entre instalaciones distintas: **suma** inventario/disponible/comprometido y
     **suma consumo**; período de cubrimiento con **MÁXIMO**.
     ⚠️ Ver punto pendiente P7: sumar `ConsumoPromedio` es sospechoso.
- `aRegistro()`: mapea al shape de la tabla. Los criterios van a un JSONB con claves
  `001,002,003,004,005,007,MUA,TLD,SP,CAT,TIP`. **La clase A/B/C del flujo Llano sale
  del criterio `CAT`** (`DescMayorCAT` = "CATEGORIA TIPO A/B/C").
- `refrescarSnapshot()`: **upsert + prune** con red de seguridad (ver sección 4).
- `leerBodegas()` / `leerBodegasItems()`: lectura paginada (Supabase corta en 1000).

### 2.3. Los dos flujos (`src/services/siesa.service.js`)

El destino define el flujo (ver `src/config/flujos.js`):

**General** (`getProductosTraslado`): sugerido por **stock de seguridad**.
`necesidad = consumoDestino × periodoCubrimiento − inventarioDestino` (topeado en 0).
`sugerido = necesidad` (el MÁXIMO a mandar, NO se topea por el inventario del origen).
`faltante = necesidad − disponibleOrigen`.

**Llano** (`getProductosLlano`): sugerido por **clasificación A/B/C**.
- Destino = `00401` (Girardota Llano), origen por defecto = `00301` (Girardota Parque).
- La **clase** sale del `CAT` del **destino**.
- La **capacidad** sale de la tabla `traslados_capacidad` (Excel o a mano en Capacidad·Llano).
- Lógica del sugerido ABC (ver 3.2 — es la fórmula que el usuario confirmó).
- `sugerido = necesidad` (tampoco se topea por origen).
- **Exclusión CAT vacío**: en Llano, si `criterios.CAT` viene vacío el ítem se **omite**
  (`if (!catLlano) continue;`). Solo se muestran A / B / C / SIN CLASIFICACION.

Ambos flujos recorren la **UNIÓN origen ∪ destino**, así aparecen ítems que el destino
necesita aunque el origen principal no tenga stock (para mandarlos desde otra sede).

### 2.4. Multi-UM por ítem

Un mismo ítem puede tener **varias UM** en `traslados_capacidad` (ej: CAJA + BULTO),
cada una como fila separada con su `factor` y `capacidad`. Identidad de fila:
`rowKey = ${codigo_item}|${unidad}`. En "Nuevo despacho" aparecen como filas
independientes (una por UM). Si el ítem tiene UM asignadas, NO se muestra la fila base
(UND). Clave: `mapaCapacidades()` devuelve `Map<codigoNormalizado, Array<{capacidad,
unidad, factor}>>`. `normCodigo()` quita ceros a la izquierda ("0000019" → "19").

`buildUnidades(row, umExtra)` devuelve **siempre objetos** `[{unidad, factor}]` en todas
sus ramas. Ver P8 (mismatch de deploy que sirve strings).

---

## 3. Lógica de sugerido y días (el corazón del cálculo)

### 3.1. Días: DOS métricas distintas (¡no confundir!)

En Llano el backend calcula y envía **dos** campos diferentes:

- **`dias_capacidad = capacidadBase / consumoDestino`** → "cuántos días cubre la
  **capacidad meta**". Se muestra en la columna **Capacidad** como "cubre X d".
- **`dias_inventario = inventarioDestino / consumoDestino`** → "cuántos días de stock
  **real** hay hoy en el destino". Es la columna **Días inv.** y la que alimenta el
  filtro/alerta de sobre-stock. En General también se calcula (`inventarioDestino/consumo`).

> Esto **resuelve el antiguo P5**: antes `dias_inventario` usaba `capacidad/consumo`
> (elección previa del usuario) y la alerta de sobre-stock salía invertida. Ahora
> `Días inv.` usa inventario real → la alerta ▲ es coherente y funciona en ambos flujos.

`consumo = 0` → días = `null` → alerta **"sin rotación"**.
`capacidadBase = capacidadUM × (factor || 1)`.

Frontend (`TablaProductosSiesa.jsx`):
- `celdaCapacidad(p)` → capacidad + "cubre X d" (usa `dias_capacidad`).
- `celdaDias(p, umbral)` → Días inv.; `consumo ≤ 0` → badge rojo "sin rotación";
  `dias > umbral` → badge ámbar ▲.

### 3.2. Sugerido ABC (Llano) — LA fórmula confirmada por el usuario

`sugerido = redondear(objetivo − inventarioDestino)`, donde el `objetivo` depende de la
clase y de la relación capacidad/consumo:

- **Clase A**: si `capacidad/consumo ≤ 1` → `objetivo = capacidad + consumo×1`
  (capacidad + 1 día de rotación). Si `capacidad/consumo > 1` → `objetivo = capacidad`.
- **Clase B**: si `capacidad/consumo < 3` → `objetivo = consumo×3`, si no → `capacidad`.
- **Clase C / ninguno**: si `capacidad/consumo < 5` → `objetivo = consumo×5`, si no → `capacidad`.

`redondear`: redondea hacia arriba si el decimal ≥ 0.2, si no trunca.

> El usuario validó explícitamente el caso clase A: "si capacidad/consumo>1 →
> capacidad−inventario". Ej: ítem 3427 con sugerido 103 era **correcto** (era clase A con
> capacidad/consumo>1, así que objetivo=capacidad y sugerido=cap−inventario).

**General** (`sugerido.service.js`, `calcularSugeridoGeneral`): stock de seguridad,
`consumo × periodoCubrimiento − inventarioDestino`.

---

## 4. Integridad de datos del snapshot

### 4.1. Bug histórico: paginación sin `ORDER BY` (RESUELTO)

Refrescando, el mismo ítem traía datos distintos entre pulls (total bailaba en cientos de
ítems, clases cambiaban). **Causa**: la consulta `merkahorro_traslados_dev` no tenía
`ORDER BY` → SQL Server no garantiza orden entre las ~77 consultas HTTP paginadas → páginas
que se pisan y filas que se pierden. Combinado con el prune destructivo, los datos se
**corrompían**.

**Fix raíz** (vive en Connekta, NO en este repo): se agregó al final de la consulta
```sql
ORDER BY dbo.t150_mc_bodegas.f150_id,
         dbo.v121a.v121a_id_item,
         dbo.t400_cm_existencia.f400_id_instalacion
OFFSET 0 ROWS
```
- El orden = la misma llave con la que el snapshot agrupa → paginación determinística.
- **`OFFSET 0 ROWS` es obligatorio**: Connekta envuelve la consulta en una subconsulta y
  SQL Server no permite `ORDER BY` en subconsulta salvo con `TOP/OFFSET/FOR XML`.
- ✅ Verificado: total subió de ~9000 a ~13.000 (pull completo) y los ítems quedaron estables.

### 4.2. Red de seguridad en el código (grace-prune + guardas)

`src/services/snapshot.service.js`. Protege el dato **aunque la paginación vuelva a fallar**:

1. **Prune con período de gracia** (`GRACIA_PRUNE_MS`, default 180 min): ya NO borra un
   ítem por faltar en UN pull. Una omisión transitoria reaparece conservando sus últimos
   valores buenos. **Pieza clave.**
2. **Guarda de completitud** (`UMBRAL_COMPLETITUD` 0.95): si `crudas < totalDeclarado×0.95`
   → aborta sin tocar el snapshot (`PullIncompletoError`).
3. **Guarda de regresión** (`UMBRAL_REGRESION` 0.8): si `registros < prevCount×0.8` → aborta.
- Un pull abortado responde `{ ok:true, saltado:true, motivo }` (200), no es un crash.

### 4.3. Inventario = `CantidadDisponible` + clamp de negativos (RESUELTO)

Regla de negocio confirmada por el usuario: **el inventario a usar es `CantidadDisponible`**
directamente (NO restar contra existencia). Pero ~37-38 ítems venían con `CantidadDisponible`
**negativa** (cuando `cant_pos_1 > existencia`), lo que **inflaba el sugerido**.

**Fix**: clamp `Math.max(0, num(disponible))` aplicado en:
- `getProductosTraslado` (inventario/disponible origen y destino).
- `getProductosLlano` (ídem).
- `getDisponibilidadItem`.

Con el clamp, un inventario negativo se trata como 0 y el sugerido deja de inflarse.

---

## 5. El refresh: migración de Vercel cron → GitHub Actions

### 5.1. Por qué se movió

El pull completo contra Connekta tarda **~5 min**. Vercel serverless tiene un límite
**duro de 300s** (`FUNCTION_INVOCATION_TIMEOUT`) → el refresh se cortaba a la mitad.
Subir el `tamPag` no ayuda (Connekta topea en 1000). Solución: **sacar el pull de Vercel**.

### 5.2. Cómo funciona ahora

- **GitHub Actions** (`.github/workflows/snapshot-refresh.yml`, repo `kevinpineda22/backend-traslado`):
  `schedule: */15 * * * *` + `workflow_dispatch`. Sin límite de 300s. Corre
  `node scripts/refresh-snapshot.js` (`refrescarSnapshotUnico("github-actions")`).
  - **`node-version: 22`** (obligatorio: `@supabase/supabase-js` necesita WebSocket nativo;
    Node 20 daba *"Node.js 20 detected without native WebSocket support"*).
  - 7 secrets en el repo: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `CONNEKTA_BASE_URL`,
    `CONNEKTA_ID_COMPANIA`, `CONNI_KEY`, `CONNI_TOKEN`, `CONNEKTA_QUERY_TRASLADOS`.
  - Runs verdes en ~4-5 min.
- **Botón "Actualizar ahora" del panel**: ya NO hace el pull inline (se colgaba). Ahora
  `dispararRefreshRemoto()` hace `POST` a la API de GitHub para **disparar el workflow**
  (`workflow_dispatch`). Responde en ~1s con **202** `{ disparado: true }` y el mensaje
  "Actualización disparada. El inventario se refresca en ~5 minutos." Si no hay token/repo,
  cae al refresh inline como fallback.
  - Envs en Vercel: `GITHUB_REPO=kevinpineda22/backend-traslado`, `GITHUB_DISPATCH_TOKEN`
    (PAT classic con scope de Actions), opcional `GITHUB_WORKFLOW`, `GITHUB_REF_SNAPSHOT`.
- **`vercel.json`**: se **eliminó** el cron `/api/siesa/refresh`. Queda solo el cron
  `*/10` de reintentos de requisiciones.

### 5.3. UX del refresh en el panel (`AdminPanel.jsx`)

- Al disparar: toast "Actualizando inventario… tarda ~5 min. Te aviso cuando esté." y se
  marca `esperandoRefresh`.
- `useEstadoSnapshot` hace polling con `refetchInterval` dinámico (10s si `en_progreso`,
  60s si no).
- Un `useEffect` observa el cambio de `actualizado_at`: cuando cambia y estábamos
  esperando, invalida `productos` y muestra "✅ Inventario actualizado con los últimos datos."
- Topbar muestra "Actualizando inventario… (~5 min)" mientras `en_progreso || isRefrescando
  || esperandoRefresh`.

---

## 6. UI del panel — reorganización de filtros (trabajo reciente)

Objetivo del usuario: la zona de filtros se veía **colapsada/invasiva**; aprovechar espacio
y agrandar la tabla.

- **Filtros facetados**: se mantienen **todos los criterios visibles** (`FiltrosFacetados.jsx`,
  fila `trl-facetas-tipos` con un botón por criterio + panel de valores + chips). Los chips
  con >3 valores colapsan a un chip resumen "N seleccionados".
- **Botón "Filtros extras" + modal** (NUEVO): para aligerar la barra, los dos filtros menos
  usados se movieron a un modal:
  - "Solo sugeridos > 0" (toggle `soloSugeridos`).
  - "Excluir ítems con mucho inventario" (solo Llano, `excluirMuchosDias`) con input inline
    del umbral de días (`umbralDias`, default 30).
  - El botón (`trl-tool-btn--extras`) muestra un punto indicador (`trl-extras-dot`) cuando hay
    algún filtro extra activo. Estado: `showFiltrosExtras`.
- **Botón de pantalla completa**: reubicado a `trl-productos-cabecera` (arriba a la derecha,
  junto a los facetados), fuera de la fila de herramientas.
- **`LIMITE_RENDER = 2000`** (antes 300): "Mostrando X de N productos" ahora llega hasta 2000.
- Tabla más alta (`max-height: 68vh`).
- **Limpieza**: se eliminó el CSS muerto del intento de "botón único Filtros"
  (`.trl-filtros-wrap/-btn/-menu/...`) que se descartó al volver a los criterios visibles.

### 6.1. Otros features de UI ya integrados

- Header origen→destino en pantalla completa (`trl-fs-header`, solo fullscreen).
- Columna "Días inv." con badges (ver 3.1).
- Selector de UM por fila cuando el ítem tiene multi-UM (ver 2.4).

---

## 7. Capacidad·Llano — Excel multi-UM (RESUELTO)

`src/models/Capacidad.model.js`, `upsertBulk`: al subir un Excel con ítems repetidos pero
**UM distintas**, antes se pisaban (dedup solo por `codigo_item`). **Fix**: dedup por
`${codigo_item}|${unidad}`, lee `unidad = String(i.unidad ?? i.um ?? "").trim()`,
`factor = unidad ? (Number(i.factor)>0?Number(i.factor):1) : null`, y `onConflict:
"codigo_item,unidad"`. Requiere la migración `007_capacidad_multi_um.sql` (PK compuesta).

---

## 8. Estado de despliegue

| Cambio | Dónde vive | ¿Desplegado? |
|--------|-----------|--------------|
| `ORDER BY` + `OFFSET 0 ROWS` | Connekta (server) | ✅ SÍ |
| GitHub Actions workflow (Node 22) | repo `kevinpineda22/backend-traslado` | ✅ SÍ (runs verdes) |
| Envs Vercel (`GITHUB_REPO`, `GITHUB_DISPATCH_TOKEN`) | Vercel | ✅ SÍ (usuario) |
| Clamp `Math.max(0, disponible)` | backend local | ⚠️ Verificar `git push` |
| `dias_capacidad` / `dias_inventario` | backend local | ⚠️ Verificar en la rama que despliega |
| Red de seguridad (grace-prune + guardas) | backend | ✅ desplegada con GHA / verificar en Vercel |
| Excel multi-UM (`upsertBulk`) | backend local | ⚠️ Verificar `git push` |
| UI Filtros extras + fullscreen + LIMITE 2000 | frontend local | ❌ falta `npm run deploy` |

> **Acción inmediata**: `git push` del backend (clamp + días + Excel) y `npm run deploy`
> del frontend (toda la UI de filtros).

---

## 9. Puntos pendientes de revisar

- **P4. Re-verificar el consumo con usuarios**: el reporte de "consumo no concuerda" era muy
  probablemente el bug de paginación (ya resuelto). Re-chequear con usuarios si cuadra.
- **P7. Revisar la suma de `ConsumoPromedio`** (`snapshot.service.js`, `agregarPorBodegaItem`):
  el consumo se **suma** entre instalaciones pero el período usa **MÁXIMO**. Si
  `ConsumoPromedio` viene a nivel de ítem repetido por instalación, sumarlo lo infla ×N.
  Confirmar con un ítem multi-instalación si debe sumarse o tomarse representativo (MAX/promedio).
- **P8. Mismatch de deploy en `unidades` (UM ×undefined)** — NO RESUELTO. El código commiteado
  hace que `buildUnidades` devuelva objetos `[{unidad, factor}]`, pero el backend en producción
  sirve **strings** `["UND","P3"]` para ~261 ítems Llano (huevos, etc.) → el selector de UM no
  aparece. Es un desajuste de deploy (Vercel sirviendo código distinto) que no se pudo resolver
  remotamente. **Mitigación activa**: red de seguridad en el frontend (`TablaProductosSiesa.jsx`)
  que oculta el selector si `unidades` no son objetos válidos → esos ítems se despachan en UND.
  Pendiente: forzar redeploy limpio del backend y confirmar que sirve objetos.
- **P9. Schedule de GitHub Actions es best-effort**: el `*/15` real corre cada ~30-45 min (GHA no
  garantiza puntualidad en cron). El usuario lo aceptó por ahora. El botón "Actualizar ahora"
  cubre la necesidad de frescura inmediata.

---

## 10. Restricciones operativas (NO romper)

- **NUNCA** correr `siesa-pos-sync`: inserta en la producción real de SIESA.
- **NUNCA** `npm run build` automático desde IA (lento, consume memoria). El deploy del
  frontend lo hace el usuario con `npm run deploy`.
- **NUNCA** poner secretos en variables `VITE_*` (quedan en el bundle del cliente).
- Migraciones SQL: las corre el usuario en Supabase ANTES de desplegar backend que dependa
  del esquema.
- Commits: conventional commits, SIN atribución de IA / "Co-Authored-By".
- El refresh pesado ya NO corre en Vercel — vive en GitHub Actions. El botón solo **dispara**
  el workflow (respuesta rápida), no hace el pull inline salvo fallback.

---

## 11. Archivos clave (mapa)

**Backend** (`Backend-traslados`):
- `src/services/snapshot.service.js` — pull + agregación + persistencia + red de seguridad
  (grace-prune, guardas, `PullIncompletoError`, `dispararRefreshRemoto`, `contarSnapshot`,
  `TAM_PAG`).
- `src/services/siesa.service.js` — `getProductosLlano` / `getProductosTraslado` (pivote
  origen/destino, sugerido, `dias_capacidad`, `dias_inventario`, clamp `Math.max(0)`,
  exclusión CAT vacío, `buildUnidades`).
- `src/services/sugerido.service.js` — `calcularSugeridoABC`, `calcularSugeridoGeneral`.
- `src/models/Capacidad.model.js` — capacidad multi-UM (`upsertBulk`, `mapaCapacidades`, `normCodigo`).
- `src/controllers/siesa.controller.js` — endpoints (`refrescar` con dispatch remoto, `estado`,
  `listarProductos`, etc.).
- `src/config/flujos.js` — SEDES, flujos, `bodegasInvolucradas`.
- `scripts/refresh-snapshot.js` — entrypoint del refresh para GitHub Actions.
- `.github/workflows/snapshot-refresh.yml` — cron `*/15` + `workflow_dispatch`, Node 22.
- `vercel.json` — solo cron `*/10` de requisiciones (el de refresh se eliminó), `maxDuration 300`.
- `docs/GITHUB-ACTIONS-SNAPSHOT.md` — guía de setup (secrets + envs de Vercel).

**Frontend** (`Pagina-web_React`):
- `src/pages/Traslados/AdminPanel.jsx` — orquestador (carrito, filtros, envío, fullscreen,
  modal Filtros extras, UX de refresh con `esperandoRefresh`).
- `src/pages/Traslados/components/FiltrosFacetados.jsx` — filtros facetados (todos los criterios visibles).
- `src/pages/Traslados/components/TablaProductosSiesa.jsx` — tabla (`celdaCapacidad`, `celdaDias`,
  `LIMITE_RENDER=2000`, red de seguridad de UM).
- `src/pages/Traslados/components/CapacidadLlano.jsx` — CRUD de capacidad multi-UM.
- `src/pages/Traslados/hooks/useSiesaApi.js` — `useEstadoSnapshot` (refetchInterval dinámico),
  `useRefrescarSnapshot`.
- `src/pages/Traslados/AdminPanel.css` — estilos (`trl-productos-cabecera`, `trl-tool-btn--extras`,
  `trl-modal--extras`, `trl-extras-*`, `trl-fs-header`, `trl-dias-*`).
