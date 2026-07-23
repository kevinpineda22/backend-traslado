# Traslados — Contexto, estado y pendientes (handoff para IA/humano)

> Documento vivo. Objetivo: que cualquier IA (o persona) entienda TODA la lógica
> del módulo de Traslados, qué se hizo, qué está roto/pendiente, y cómo proceder.
> Última actualización: 2026-07-23.

---

## 0. Cómo usar este documento

- Si vas a tocar **datos** (consumo, inventario, clases, sugerido), leé primero la
  **sección 4** (integridad del snapshot). Es el problema más serio y todo lo demás
  depende de que los datos estén bien.
- Si vas a tocar **UI o cálculo de sugerido/días**, leé secciones 2 y 3.
- Antes de cualquier cambio revisá la **sección 9** (restricciones que NO se rompen).

---

## 1. Qué es el sistema

Panel administrativo de **traslados entre sedes** de Merkahorro. El admin arma un
despacho: elige una sede destino, el sistema le sugiere qué productos y cuánto
mandar (según inventario, consumo y reglas por flujo), y crea el despacho que luego
recolectan/auditan otras personas.

Dos repos separados (deploy independiente):

- **Backend**: `C:\Users\juan.isaza\Desktop\BACKENDS\Backend-traslados`
  Node/Express en Vercel (serverless). Auto-deploy en `git push` a `main`.
- **Frontend**: `C:\Users\juan.isaza\Desktop\merkaPage\Pagina-web_React`
  React 19 + Vite 7. Deploy con `npm run deploy` (build + scp a hosting Apache).

Backend en producción: `https://backend-traslado.vercel.app/api`.

---

## 2. Arquitectura y flujo de datos

### 2.1. Origen de los datos: SIESA vía Connekta (patrón snapshot)

SIESA (ERP) se consulta a través de **Connekta**, que solo expone **consultas
dinámicas registradas** (sin parámetros). Traer el dataset completo (~76k filas)
tarda minutos, así que **NO se consulta por request de usuario**. En su lugar:

1. Un **cron de Vercel corre cada 15 min** (`vercel.json`: `*/15 * * * *`) y llama
   a `/api/siesa/refresh`.
2. Ese refresh trae TODO desde Connekta, lo **agrega por (bodega, item)** y lo
   persiste en la tabla Supabase **`traslados_snapshot`**.
3. Los endpoints de usuario leen del snapshot en milisegundos.

Hay un segundo cron (`*/10`) para reintentar requisiciones a SIESA.

La consulta registrada se llama **`merkahorro_traslados_dev`** (configurable por env
`CONNEKTA_QUERY_TRASLADOS`). Filtra 7 bodegas: `PV001, 00301, 00201, 00701, 00801,
00601, 00401`.

### 2.2. Pipeline del snapshot (`src/services/snapshot.service.js`)

- `traerDeConnekta()`: pide la página 1, ve cuántas páginas hay (`totalPaginas`) y
  trae el resto **en paralelo con concurrencia 3** (más paralelismo deadlockeaba el
  SQL Server detrás de Connekta). Devuelve `{ filas, crudas, totalDeclarado }`.
- `agregarPorBodegaItem(rows)`:
  1. **Dedup** por `(bodega|item|instalación)` — el mismo ítem se repite por
     instalación y los JOINs de criterios lo duplican más.
  2. Entre instalaciones distintas: **suma** inventario/disponible/comprometido y
     **suma consumo**; período de cubrimiento con **MÁXIMO**.
     ⚠️ Ver punto pendiente P7: sumar `ConsumoPromedio` es sospechoso.
- `aRegistro()`: mapea al shape de la tabla. Los criterios van a un JSONB con claves
  `001,002,003,004,005,007,MUA,TLD,SP,CAT,TIP`. **La clase A/B/C del flujo Llano sale
  del criterio `CAT`** (`DescMayorCAT` = "CATEGORIA TIPO A/B/C").
- `refrescarSnapshot()`: **upsert + prune** (ver sección 4, tiene red de seguridad).
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
- La **capacidad** sale de la tabla `traslados_capacidad` (se carga por Excel o a mano
  en el módulo Capacidad·Llano).
- Cadencias por clase (días): `A:1, B:3, C:5` — configurables (`traslados_config`).
- `calcularSugeridoABC()` en `src/services/sugerido.service.js`.
- `sugerido = necesidad` (tampoco se topea por origen).

Ambos flujos recorren la **UNIÓN origen ∪ destino**, así aparecen ítems que el destino
necesita aunque el origen principal no tenga stock (para mandarlos desde otra sede).

### 2.4. Multi-UM por ítem

Un mismo ítem puede tener **varias UM** en `traslados_capacidad` (ej: CAJA + BULTO),
cada una como fila separada con su `factor` y `capacidad`. Identidad de fila:
`rowKey = ${codigo_item}|${unidad}`. En "Nuevo despacho" aparecen como filas
independientes (una por UM). Si el ítem tiene UM asignadas, NO se muestra la fila base
(UND). Clave: `mapaCapacidades()` devuelve `Map<codigoNormalizado, Array<{capacidad,
unidad, factor}>>`. `normCodigo()` quita ceros a la izquierda ("0000019" → "19").

---

## 3. Trabajo reciente (features implementados)

1. **Multi-UM por ítem** (backend + frontend). Migración SQL `007_capacidad_multi_um.sql`
   (PK compuesta `(codigo_item, unidad)`). ✅ Verificado.
2. **UM y factor editables inline** en Capacidad·Llano. Cambiar la UM "mueve" la fila
   (crea nueva `(codigo, UM)` + borra la vieja). Frontend:
   `components/CapacidadLlano.jsx`.
3. **Columna "Días inv." + alertas + filtro** (feature nuevo, ver 3.1).
4. **Header origen→destino en pantalla completa** (`AdminPanel.jsx`, clase
   `trl-fs-header`). Muestra Origen · código → Destino · código + etiqueta de flujo.
   Solo visible en fullscreen.

### 3.1. Días de inventario (detalle)

- **Fórmula elegida por el usuario**: `dias_inventario = capacidadBase / consumoDestino`.
  Backend: `getProductosLlano` (por variante de UM). En General va `null` (no hay
  capacidad). `consumo = 0` → `dias = null` → alerta "sin rotación".
- **Frontend** (`TablaProductosSiesa.jsx`, `celdaDias()`):
  - `consumo ≤ 0` → badge rojo **"sin rotación"** (funciona en ambos flujos).
  - `dias > umbral` → badge ámbar **▲** (muchos días de inventario).
  - sin capacidad (General) → "—".
- **Filtro** (solo Llano, en `AdminPanel.jsx`): "Excluir > N días inv." con umbral
  editable (default 30). El mismo umbral dispara el badge ▲ y el filtro.

⚠️ **CAVEAT DE COHERENCIA (punto pendiente P5)**: `capacidad/consumo` mide "cuántos
días cubre la capacidad meta", NO el sobre-stock actual del destino. Por eso un ítem
puede tener ▲ (muchos días) y a la vez sugerido alto. Evidencia real:
- SARDINAS 1024: invDestino 23, sugerido 57 (le falta) pero muestra ▲ 77 d.
- GARBANZO 1293: invDestino 53, sugerido 0 (está lleno) pero muestra 25 d, SIN alerta.
La alerta queda **invertida** respecto de "sobre-stock". Lo correcto para ese propósito
sería `inventario_destino / consumo` (además funcionaría en General). El usuario eligió
`capacidad/consumo` a conciencia; queda pendiente decidir si se cambia.

---

## 4. NOVEDAD CRÍTICA: integridad de datos del snapshot

### 4.1. Síntoma

Refrescando la página, el **mismo ítem** trae datos totalmente distintos entre un
refresh y otro. Ejemplo real (ítem 10550, COLCAFE):

| Campo | Pull A | Pull B |
|-------|--------|--------|
| Total ítems Llano | 9183 | 8618 |
| Inventario Origen | 1872 | 0 |
| Inventario Destino | 0 | 699 |
| Consumo | 0 | 37.15 |
| Clase | NINGUNO | A |

El total cambia en cientos de ítems. Eso NO es movimiento de inventario: son **filas
que faltan** en algunos pulls.

### 4.2. Causa raíz — paginación sin `ORDER BY`

La consulta `merkahorro_traslados_dev` **no tenía `ORDER BY`**. El snapshot se trae
**paginado** (77 páginas, cada una una consulta HTTP independiente, 3 en paralelo).
SQL Server **no garantiza el orden de filas entre ejecuciones separadas sin un
`ORDER BY`** sobre una clave única. Resultado: páginas que se **pisan** (filas
duplicadas) y filas que **no caen en ninguna página** (se pierden). Cada pull deja
afuera filas distintas → el total baila y algunos ítems pierden su fila de destino
(→ inventario 0, consumo 0, clase NINGUNO porque la clase sale del `CAT` del destino).

### 4.3. El prune destructivo (agravante)

`refrescarSnapshot` hacía **upsert + prune**: borraba de Supabase toda fila no vista en
ESE pull (`actualizado_at < inicio`). Combinado con la paginación inestable: una fila
que la paginación se saltó **se borraba** (no quedaba la vieja). Por eso los datos no
solo se veían mal: **se corrompían**.

### 4.4. Fix 1 (raíz): `ORDER BY` en la consulta Connekta — HECHO

Se agregó al final de la consulta registrada:
```sql
ORDER BY dbo.t150_mc_bodegas.f150_id,
         dbo.v121a.v121a_id_item,
         dbo.t400_cm_existencia.f400_id_instalacion
OFFSET 0 ROWS
```
- Ese orden = la misma llave con la que el snapshot agrupa → paginación determinística.
- **`OFFSET 0 ROWS` es obligatorio**: Connekta **envuelve la consulta en una subconsulta**
  (para contar/paginar) y SQL Server no permite `ORDER BY` en subconsulta salvo que haya
  `TOP/OFFSET/FOR XML`. Error original: *"The ORDER BY clause is invalid in views,
  inline functions, derived tables, subqueries... unless TOP, OFFSET or FOR XML is also
  specified"*.
- **Estado**: guardada en Connekta, sin error, trae datos. ✅ (vive en el server de
  Connekta, NO en este repo).

### 4.5. Fix 2 (contención): red de seguridad en el código — HECHO (sin desplegar)

En `src/services/snapshot.service.js` + `src/controllers/siesa.controller.js`. Protege
el dato **aunque la paginación vuelva a fallar** (fallos de red, páginas cortas, etc.):

1. **Prune con período de gracia**: ya NO borra un ítem por faltar en UN pull. Solo borra
   lo ausente por más de `GRACIA_PRUNE_MS` (default **180 min**). Una omisión transitoria
   reaparece y conserva sus últimos valores buenos. **Esta es la pieza clave.**
2. **Guarda de completitud**: si `crudas < totalDeclarado × 0.95` → aborta sin tocar el
   snapshot (`PullIncompletoError`).
3. **Guarda de regresión**: si `registros < prevCount × 0.8` → aborta.
- Un pull abortado responde `{ ok: true, saltado: true, motivo }` (200), no es un crash.
- Envs: `SNAPSHOT_MIN_COMPLETITUD` (0.95), `SNAPSHOT_MIN_REGRESION` (0.8),
  `SNAPSHOT_GRACIA_PRUNE_MIN` (180).

### 4.6. Estado de verificación (2026-07-23)

- Después del `ORDER BY`, el total pasó de ~9000 a **12.947 ítems** (pull completo) y el
  ítem 10550 quedó estable en su estado bueno (**clase A, consumo 37.15, sugerido 69**).
  Fuerte indicio de que el `ORDER BY` funcionó.
- **FALTA CONFIRMAR ESTABILIDAD**: comparar el ítem 10550 y el total entre DOS refreshes
  consecutivos (deben quedar iguales). Estaba corriendo un refresh manual cuando se pausó.
- ⚠️ **Observación nueva a investigar**: en una lectura, el último snapshot exitoso quedó
  de **~70 min atrás con `en_progreso: true`**. Posible **lock trabado** (el TTL del lock
  es 300s; ver `lock.service.js` y `refreshEnProgreso`/`lockTomado`) que estaría
  impidiendo que el cron refresque → snapshot viejo. Conecta con el pedido de UX de
  frescura (P6).

---

## 5. Estado de despliegue

| Cambio | Dónde vive | ¿Desplegado? |
|--------|-----------|--------------|
| `ORDER BY` + `OFFSET 0 ROWS` | Connekta (server) | ✅ SÍ (guardado en Connekta) |
| Red de seguridad (grace-prune + guardas) | backend local | ❌ NO — falta `git push` |
| Campo `dias_inventario` (backend) | backend local | ⚠️ Verificar (ver P3) |
| UI Días inv. + filtro + header fullscreen | frontend local | ⚠️ Verificar (`npm run deploy`) |
| UM/factor editable + multi-UM (frontend) | frontend local | ⚠️ Verificar |

---

## 6. Puntos pendientes de revisar

- **P1. Confirmar estabilidad del `ORDER BY`**: comparar ítem 10550 + total entre 2
  refreshes consecutivos. Si sigue bailando, Connekta impone su propio orden afuera y hay
  que apoyarse solo en la red de seguridad.
- **P2. Desplegar la red de seguridad**: `git push` del backend. Es la garantía de que un
  pull malo nunca vuelve a corromper el dato.
- **P3. `dias_inventario` se revirtió DOS veces** del archivo `siesa.service.js` (entre
  sesiones, por `git checkout`/otra rama). Confirmar que la lógica está presente en la
  rama que se despliega y que no se vuelve a caer. Piezas: cálculo en el loop de variantes
  y el campo en el `push` (Llano), y `dias_inventario: null` en General.
- **P4. Re-verificar el consumo con usuarios**: el reporte original de "consumo no
  concuerda" muy probablemente era ESTE bug de paginación (filas faltantes → consumo 0 o
  parcial). Ahora que el `ORDER BY` está, re-chequear con usuarios si el consumo cuadra.
- **P5. Decidir fórmula de "Días inv."**: `capacidad/consumo` (actual, elección del
  usuario) vs `inventario_destino/consumo` (recomendado, alerta de sobre-stock correcta
  y sirve en General). Ver caveat en 3.1.
- **P6. UX de frescura de datos**: dejar claro cuándo se actualizó el snapshot y desde
  cuándo se puede trasladar tranquilo (dato "pegado" a la realidad). Endpoint
  `/api/siesa/estado` ya da `actualizado_at` + `en_progreso`. Falta comunicarlo mejor en
  la UI (ej: "datos de hace X min, listos para despachar" vs "actualizando…"). Incluir la
  investigación del posible lock trabado (obs. en 4.6).
- **P7. Revisar la suma de `ConsumoPromedio`** (`snapshot.service.js`, `agregarPorBodega
  Item`): el consumo se **suma** entre instalaciones pero el período usa **MÁXIMO**. Si
  `ConsumoPromedio` viene a nivel de ítem repetido por instalación, sumarlo lo infla ×N.
  Confirmar con un ítem que exista en varias instalaciones si el valor debe sumarse o
  tomarse representativo (MAX/promedio).

---

## 7. Cómo vamos a proceder (orden sugerido)

1. **Confirmar P1** (estabilidad del ORDER BY): 2 refreshes, comparar 10550 y total.
2. **Desplegar backend (P2 + P3)**: `git push` con la red de seguridad y verificando que
   `dias_inventario` esté presente. Vercel redespliega solo.
3. **Investigar P6 (lock/frescura)** y mejorar el indicador de "última actualización /
   listo para trasladar" en la UI.
4. **Re-verificar consumo con usuarios (P4)** ahora que la paginación está sana. Si aún
   no cuadra, atacar P7.
5. **Decidir fórmula de días (P5)**: si se quiere alerta real de sobre-stock, cambiar a
   `inventario_destino/consumo` (una línea en backend).
6. **Desplegar frontend** si falta (`npm run deploy`).

---

## 8. Archivos clave (mapa)

**Backend** (`Backend-traslados`):
- `src/services/snapshot.service.js` — pull + agregación + persistencia + **red de
  seguridad** (grace-prune, guardas, `PullIncompletoError`, `contarSnapshot`).
- `src/config/connekta.js` — `ejecutarConsulta` (paginación `numPag|tamPag`, reintentos).
- `src/services/siesa.service.js` — `getProductosLlano` / `getProductosTraslado`
  (pivote origen/destino, sugerido, `dias_inventario`).
- `src/services/sugerido.service.js` — `calcularSugeridoABC`, `calcularSugeridoGeneral`.
- `src/models/Capacidad.model.js` — capacidad multi-UM (`mapaCapacidades`, `normCodigo`).
- `src/controllers/siesa.controller.js` — endpoints (`refrescar`, `estado`,
  `listarProductos`, etc.).
- `src/config/flujos.js` — SEDES, flujos, `bodegasInvolucradas`.
- `src/config/unidadesForzadas.js` — UM forzadas/seleccionables por ítem.
- `vercel.json` — crons (`*/15` refresh, `*/10` requisiciones), `maxDuration 300`.

**Frontend** (`Pagina-web_React`):
- `src/pages/Traslados/AdminPanel.jsx` — orquestador (carrito, filtros, envío,
  fullscreen, filtro de días).
- `src/pages/Traslados/components/TablaProductosSiesa.jsx` — tabla de productos
  (columna Días inv., `celdaDias`, orden).
- `src/pages/Traslados/components/CapacidadLlano.jsx` — CRUD de capacidad multi-UM.
- `src/pages/Traslados/AdminPanel.css` — estilos (`trl-fs-header`, `trl-dias-*`, etc.).

---

## 9. Restricciones operativas (NO romper)

- **NUNCA** correr `siesa-pos-sync`: inserta en la producción real de SIESA.
- **NUNCA** `npm run build` automático desde IA (lento, consume memoria). El deploy del
  frontend lo hace el usuario con `npm run deploy`.
- **NUNCA** poner secretos en variables `VITE_*` (quedan en el bundle del cliente).
- Migraciones SQL: las corre el usuario en Supabase ANTES de desplegar backend que
  dependa del esquema.
- Commits: conventional commits, SIN atribución de IA / "Co-Authored-By".
- El `refresh` manual (`POST /api/siesa/refresh`) hace un pull pesado (~2 min) contra
  SIESA. Es una LECTURA (seguro), pero no abusar; el cron ya lo hace cada 15 min.
