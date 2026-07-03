# Arquitectura — Backend Traslados

> Documento vivo. Explica **qué** hace el módulo, **cómo** está construido y —sobre todo— **por qué** cada decisión es así. Si vas a tocar el código, leé esto primero.

---

## 1. Qué resuelve el módulo

Merkahorro traslada mercadería entre sedes. Un **admin** arma un despacho (elige destino, filtra productos, define cantidades), un **despachador** recolecta físicamente, y un **auditor** verifica a ciegas. Este backend expone la API que alimenta esos tres paneles del frontend.

### Dos flujos de traslado

| Flujo | Origen | Destinos | Lógica de sugerido |
|---|---|---|---|
| **General** | `PV001` (Copacabana) | `00301`, `00201`, `00701`, `00801`, `00601` | Stock de seguridad |
| **Llano** | `00301` (Girardota) | `PV004` (Llano) | Clasificación A/B/C (con Excel) |

La asignación sede → flujo **no está hardcodeada en la lógica**: vive en `src/config/flujos.js`. Para reasignar una sede o agregar una nueva, se edita ese archivo (y el `WHERE` del query en Connekta).

> **Estado actual:** el flujo **General** está implementado (backend + frontend). El flujo **Llano** tiene la lógica de cálculo lista (`sugerido.service.js`) pero falta la carga del Excel y su pantalla.

---

## 2. El problema central: cómo se consulta SIESA

No tenemos acceso SQL directo a SIESA (el ERP). Todo pasa por **Connekta**, una API que ejecuta consultas registradas en su plataforma. Entender sus límites explica **casi todas** las decisiones de arquitectura.

### 2.1. Connekta tiene dos tipos de consulta

| Endpoint | Acepta parámetros | ¿Podemos crearlas? |
|---|---|---|
| `ejecutarconsulta` (dinámica) | ❌ No | ✅ Sí |
| `ejecutarconsultaestandar` (estándar) | ✅ Sí (`parametros=campo=valor`) | ❌ No (sin permisos) |

El módulo **Domicilios** filtra en tiempo real porque usa el endpoint **estándar** (su consulta `API_v2_Inventarios_InvFecha` acepta `parametros=f120_id=X`). Nosotros **solo podemos crear consultas dinámicas**, que **no aceptan parámetros**.

**Consecuencia directa:** no podemos pedirle a SIESA "traé solo la bodega X" ni "solo el grupo LACTEOS". La consulta trae un bloque fijo y **el filtrado por criterios y por bodega se hace de nuestro lado.**

### 2.2. El query registrado (`merkahorro_traslados_dev`)

Trae, por cada `(bodega, item, instalación)`: inventario, disponible, comprometido, consumo promedio, período de cubrimiento, unidad de medida + factor, proveedor y los 9 criterios de agrupación (Grupo, Subgrupo, Proveedor, Marca, Rotación, etc.).

**Filtro de bodega:** el query filtra las 7 bodegas de los flujos con `OR` en el `WHERE`. Detalles frágiles aprendidos a los golpes:

- ❌ **No usar `IN (...)`** → Connekta lo interpreta como "múltiples consultas" y rechaza la paginación.
- ✅ **Usar `OR`** encadenado (`f150_id='PV001' OR f150_id='00301' OR ...`).
- ❌ **Sin comentarios `--`**, sin `;` final, sin `ORDER BY` (Connekta envuelve el query en una subconsulta y SQL Server prohíbe `ORDER BY` ahí sin `TOP/OFFSET`).
- ⚠️ Al copiar/pegar el query es fácil comerse líneas y romper los JOINs de criterios → da el mismo error genérico de "múltiples consultas".

El query completo y validado está en `sql/` (o pedirlo a quien mantiene Connekta).

### 2.3. El volumen

Aun filtrando a 7 bodegas, el query devuelve **~76.000 filas** (`total_registros`). ¿Por qué tantas? Porque **el mismo item se repite** por cada `IdInstalacion`, y los `LEFT JOIN` de criterios/proveedor multiplican filas.

Traer 76k filas tarda **2-3 minutos** (≈77 páginas a `tamPag=1000`, ~1-2s cada una).

---

## 3. Por qué NO se consulta en cada request (la decisión clave)

El backend corre en **Vercel serverless**. Eso significa:

- **No hay proceso siempre vivo.** Cada request levanta una función, responde y se apaga. La memoria **no** persiste entre requests → un caché en memoria casi nunca "pega".
- **Las funciones tienen límite de tiempo.** 60s en Hobby, **300s en Pro** (nuestro plan).

Si tratáramos de traer las 76k filas **en cada request de usuario**, la función haría **timeout** antes de terminar. Es aritmética, no opinión: 2-3 min de fetch no caben en el tiempo de un request, y el resultado no sobrevive para el siguiente.

**Alternativas descartadas y por qué:**

| Opción | Por qué no |
|---|---|
| Filtrar por bodega/criterios en SIESA y traer poco | Connekta dinámico no acepta parámetros (§2.1) |
| Caché en memoria + disco (lo que había) | No sobrevive en serverless; el disco de Vercel es de solo lectura |
| Traer todo al navegador y filtrar en el cliente | 76k filas = minutos de descarga, inviable |

---

## 4. La solución: Snapshot en Supabase + Cron

Separamos **traer de SIESA** (lento, en segundo plano) de **responder al usuario** (rápido). Nunca ocurren en el mismo request.

```
┌─ CADA 3 HORAS — Vercel Cron ───────────────────────────┐
│  GET /api/siesa/refresh   (maxDuration 300s → Pro)     │
│    1. Trae ~76k filas de Connekta (2-3 min)            │
│    2. Agrega por (bodega, item): dedup + suma stock    │
│    3. Guarda en Supabase → tabla `traslados_snapshot`  │
└────────────────────────────────────────────────────────┘

┌─ REQUEST DEL USUARIO — milisegundos ───────────────────┐
│  GET /api/siesa/productos?destino=00201                │
│    → LEE de `traslados_snapshot` (no toca SIESA)       │
│    → pivotea origen/destino + calcula sugerido         │
│    → responde al instante                              │
└────────────────────────────────────────────────────────┘
```

**Por qué es la correcta:**

- El refresh de 2-3 min **entra en los 300s** de Vercel Pro. En Hobby sería imposible → por eso el plan importa.
- El usuario **lee una tabla ya agregada** (~4.000 filas) → milisegundos.
- **Persiste de verdad:** Supabase es la base de datos, sobrevive cold starts.
- **Queda 100% en Vercel**, sin host externo.
- **Resiliente:** si SIESA falla, se sigue sirviendo el último snapshot bueno.
- **Es el patrón que ya usa Merkahorro:** Domicilios hace lo mismo con su tabla `items_siesa`.

**Tradeoff aceptado:** los datos tienen hasta 3h de antigüedad. Para reposición de inventario entre sedes es perfectamente aceptable; la frecuencia del cron se ajusta en `vercel.json`.

### 4.1. Upsert + prune (por qué no delete-all + insert)

El refresh hace **upsert** de las filas actuales y luego **borra** las que no se refrescaron (items que desaparecieron de SIESA). Así evitamos la ventana en que la tabla quedaría **vacía** entre el `delete` y el `insert` —durante la cual un usuario vería cero productos—. El corte se hace por `actualizado_at < inicio_del_refresh`.

---

## 5. Lógica de negocio del sugerido

### 5.1. Flujo General — Stock de seguridad

```
stock_seguridad = ConsumoPromedio(destino) × PeriodoCubrimiento
sugerido        = max(0, stock_seguridad − Inventario(destino))
                  topeado por el Disponible(origen)   ← no se envía más de lo que Copacabana tiene
```

**Por qué estos campos:** la "rotación" (criterio 005) parecía el indicador, pero en los datos reales viene como `"PARETOS"` o `null` en la mayoría de items → inservible para clasificar. En cambio `ConsumoPromedio` y `PeriodoCubrimiento` **sí están poblados** y son, por definición, la demanda y la cobertura objetivo por sede.

### 5.2. Flujo Llano — Clasificación A/B/C

Con `dias = capacidad / consumoDiario` (la capacidad viene de un Excel que sube el admin):

| Clase | Cadencia | Objetivo |
|---|---|---|
| **A** | 1 día | `dias ≤ 1` → `capacidad + consumo×1`; si no → `capacidad` |
| **B** | 3 días | `dias < 3` → `consumo×3`; si no → `capacidad` |
| **C / Ninguno** | — | `capacidad` |

`sugerido = max(0, objetivo − inventario)`. Las cadencias (1/3/5) son configurables. Implementado en `sugerido.service.js`; falta el upload del Excel y la pantalla.

### 5.3. Switch de unidad de medida (UM)

El admin puede elegir la presentación del item (ej. `P6`). El sugerido y la cantidad se dividen por el `factor` de esa unidad (P6 → ÷6), redondeando hacia arriba a paquete entero. **Pendiente:** hoy SIESA nos da 1-2 unidades por item; para ofrecer todas las presentaciones (P6/P12/…) hay que verificar en `t122_mc_items_unidades` si el item tiene varias filas de unidad, y de ser así ampliar el query.

---

## 6. Modelo de datos (Supabase)

Las PKs son **UUID** (no bigint). Razón: los validators ya exigían `z.string().uuid()` y el frontend hace `id.slice(0,8)` (solo funciona con string). Con UUID se alinean ambos lados cambiando solo el schema, y para un sistema multi-sede un id opaco es más profesional que un autoincremental expuesto.

### `traslados_despachos`
Cabecera del despacho. Incluye `flujo` (`general`/`llano`), `origen`, `destino`, `estado`, `criterios` (jsonb).

### `traslados_items`
Un renglón por producto del despacho. Además de cantidades (`cantidad_admin`, `cantidad_despachador`, `cantidad_auditor`), guarda un **snapshot de lo que el admin vio al decidir**: `stock_origen`, `stock_destino`, `consumo_destino`, `stock_seguridad`, `rotacion`, `factor`. **Por qué:** son datos de SIESA en un instante; sin guardarlos, mañana nadie podría reconstruir *por qué* el admin pidió esa cantidad. Para un módulo de auditoría, ese contexto es clave.

### `traslados_firmas`
Firmas digitales (base64) de despachador y auditor.

### `traslados_snapshot`
Espejo agregado de SIESA (§4). PK `(bodega, codigo_item)`. Lo llena el cron; los endpoints leen de acá.

---

## 7. Estructura del código

```
src/
├── config/
│   ├── connekta.js        # Cliente Connekta (ejecutarConsulta con paginación)
│   ├── supabase.js        # Cliente Supabase (service_role)
│   └── flujos.js          # ⭐ Config editable de flujos (origen/destinos/lógica)
├── services/
│   ├── snapshot.service.js # ⭐ Refresh (Connekta→Supabase) + lectura del snapshot
│   ├── siesa.service.js    # Lectura: criterios + productos pivoteados (lee snapshot)
│   ├── sugerido.service.js # Cálculo de sugerido (General + A/B/C)
│   └── despacho.service.js # Negocio de despachos + planillas Excel
├── controllers/            # siesa · despacho · auditor
├── models/                 # Despacho · Item · Firma (Supabase)
├── routes/                 # /siesa · /despachos · /auditor
├── middleware/             # validators (Zod) · errorHandler
└── server.js               # Entry Express (export default app para Vercel)
```

⭐ = piezas de la arquitectura snapshot.

---

## 8. Endpoints SIESA

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/siesa/flujos` | Config de flujos (origen + destinos) |
| GET | `/api/siesa/sedes` | Sedes destino disponibles |
| GET | `/api/siesa/criterios?origen=PV001` | Criterios para los filtros facetados |
| GET | `/api/siesa/productos?destino=00201` | Productos pivoteados origen/destino + sugerido |
| GET | `/api/siesa/refresh?token=…` | **Refresca el snapshot** (lo dispara el cron; protegido con `REFRESH_TOKEN`) |

---

## 9. Variables de entorno

```bash
# Connekta
CONNEKTA_BASE_URL=https://servicios.siesacloud.com/api/connekta/v3
CONNEKTA_ID_COMPANIA=7375
CONNEKTA_QUERY_TRASLADOS=merkahorro_traslados_dev
CONNEKTA_TAM_PAG=1000
CONNI_KEY=...
CONNI_TOKEN=...

# Supabase (service_role — nunca exponer al cliente)
SUPABASE_URL=...
SUPABASE_SERVICE_KEY=...

# Refresh / Cron
REFRESH_TOKEN=<clave larga>   # debe coincidir con CRON_SECRET
CRON_SECRET=<misma clave>     # Vercel envía "Authorization: Bearer $CRON_SECRET" al cron
```

Frontend: `VITE_TRASLADOS_API_URL=https://backend-traslado.vercel.app/api`

---

## 10. Puesta en marcha

1. Correr la migración de las tablas (`traslados_despachos`, `_items`, `_firmas`) con PKs UUID.
2. Crear la tabla `traslados_snapshot`.
3. Setear las env vars en Vercel y redeploy.
4. **Primer refresh manual:** `GET /api/siesa/refresh?token=<REFRESH_TOKEN>` (~2-3 min). Puebla Supabase.
5. Verificar: `GET /api/siesa/productos?destino=00201` responde al instante.
6. El cron mantiene el snapshot fresco cada 3h.

---

## 11. Pendientes

- [ ] **Flujo Llano:** upload del Excel (item, unidades, capacidad, clase A/B/C) + pantalla. Lógica ya lista en `sugerido.service.js`.
- [ ] **Switch de UM completo:** verificar `t122_mc_items_unidades` y, si hay varias presentaciones por item, ampliar el query.
- [ ] **Autenticación:** hoy `admin_id`/`despachador_id` son strings libres; los despachadores están hardcodeados en el frontend (`d1`, `d2`).
- [ ] **Limpieza:** `SelectorCriterios.jsx` y `SelectorSedeDestino.jsx` (frontend) quedaron huérfanos; `conni.js` (backend) es código muerto que duplica `connekta.js`.
- [ ] **README:** desactualizado respecto a esta arquitectura.

---

## 12. Glosario de gotchas (para no repetir errores)

- Connekta dinámico **no acepta parámetros** → filtramos de nuestro lado.
- En el query: **`OR` sí, `IN` no**; sin `--`, sin `;`, sin `ORDER BY`.
- Editar un query en Connekta **resetea sus permisos** → hay que re-asignarlos.
- Vercel serverless **no persiste memoria** entre requests y su disco es **read-only**.
- El mismo item se **repite por instalación** → siempre agregar antes de mostrar.
- Rotación (`DescMayor5`) viene `PARETOS`/`null` → **no** sirve para clasificar; usar `ConsumoPromedio` + `PeriodoCubrimiento`.
- Strings de SIESA vienen con **espacios al final** → siempre `.trim()`.
- `CodigoItem` viene como **número**, no string → normalizar a string para las claves.
```
