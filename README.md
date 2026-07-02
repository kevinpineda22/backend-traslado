# Backend Traslados — Merkahorro

API REST para el flujo de **Traslados Comerciales entre Sedes** de Merkahorro.

## Tabla de contenidos

- [¿Qué es Traslados Comerciales?](#qué-es-traslados-comerciales)
- [Arquitectura](#arquitectura)
- [Stack](#stack)
- [Estructura del proyecto](#estructura-del-proyecto)
- [Flujo de un despacho](#flujo-de-un-despacho)
- [API Endpoints](#api-endpoints)
- [Base de datos (Supabase)](#base-de-datos-supabase)
- [Máquina de estados](#máquina-de-estados)
- [Integración SIESA (Connekta)](#integración-siesa-connekta)
- [Caché persistente](#caché-persistente)
- [Frontend relacionado](#frontend-relacionado)
- [Setup local](#setup-local)
- [Despliegue](#despliegue)

---

## ¿Qué es Traslados Comerciales?

Merkahorro tiene múltiples sedes (Copacabana Plaza, Girardota Parque, Barbosa, etc.). Cuando una sede necesita productos que no tiene en stock, se genera un **traslado comercial** desde la bodega de Copacabana.

### Roles del sistema

| Rol | Responsabilidad |
|---|---|
| **Admin** | Crea despachos: selecciona criterios SIESA, productos y cantidades, asigna destino y despachador |
| **Despachador** | Recolecta físicamente los productos en bodega y registra las cantidades reales |
| **Auditor** | Revisa los despachos recolectados (auditoría ciega: no ve las cantidades del despachador), compara y aprueba/rechaza |

### ¿Por qué existe?

- Centralizar el proceso que antes se manejaba con planillas físicas o llamadas telefónicas
- Control de inventario: saber exactamente qué sale de Copacabana
- Auditoría: dos pares de ojos verifican cada traslado (despachador + auditor)

---

## Arquitectura

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Frontend (React + Vite)                       │
│  AdminPanel  │  DespachadorPanel  │  AuditorPanel                     │
└──────────────────────────┬──────────────────────────────────────────┘
                           │ HTTP (axios)
                           ▼
┌──────────────────────────────────────────────────────────────────────┐
│                   Backend Traslados (Express)                        │
│                                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐             │
│  │  Routes   │→ │Controllers│→ │ Services │→ │  Models   │            │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘             │
│       │                                                            │
│       ├── Middleware (Zod validators, error handler)                │
│       └── Config (Supabase client, Connekta client, cache)         │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
              ┌────────────┴────────────┐
              ▼                         ▼
     ┌────────────────┐      ┌──────────────────────┐
     │ Supabase (PG)   │      │ Connekta API (SIESA)  │
     │ Datos locales   │      │ Catálogo, Inventario  │
     └────────────────┘      └──────────────────────┘
```

### Principios

- **MVC clásico**: Routes → Controllers → Services → Models
- **ESM** puro (`import`/`export`, `"type": "module"`)
- **Validación** con Zod en el middleware antes de llegar a controllers
- **Manejo centralizado** de errores con `errorHandler`
- **Caché persistente** en disco para consultas lentas a SIESA

---

## Stack

| Capa | Tecnología |
|---|---|
| Runtime | Node.js 24+ (ESM) |
| Framework | Express 4 |
| Base de datos | Supabase (PostgreSQL) con `service_role` |
| API externa | Connekta API (SIESA) |
| Validación | Zod |
| Planillas Excel | ExcelJS |
| Seguridad | Helmet, CORS |
| Cache | Propia en memoria + disco (`cache-data/`) |

---

## Estructura del proyecto

```
Backend-traslados/
├── cache-data/             # Caché persistente en disco (JSON)
│   ├── siesa:productos.json
│   └── siesa:sedes.json
├── sql/
│   └── 001_create_tables.sql   # Migración Supabase
├── src/
│   ├── server.js               # Entry point Express
│   ├── config/
│   │   ├── cache.js            # Caché en memoria + disco con TTL
│   │   ├── connekta.js         # Cliente Connekta API (auth headers, paginación)
│   │   └── supabase.js         # Cliente Supabase (service_role)
│   ├── controllers/
│   │   ├── siesa.controller.js   # Endpoints SIESA (criterios, productos, sedes)
│   │   ├── despacho.controller.js # CRUD despachos + planillas
│   │   └── auditor.controller.js  # Auditoría ciega
│   ├── middleware/
│   │   ├── validators.js       # Schemas Zod
│   │   └── errorHandler.js     # Manejo centralizado de errores
│   ├── models/
│   │   ├── Despacho.model.js   # CRUD sobre traslados_despachos
│   │   ├── Item.model.js       # CRUD sobre traslados_items
│   │   └── Firma.model.js      # CRUD sobre traslados_firmas
│   ├── routes/
│   │   ├── index.js            # Router raíz
│   │   ├── siesa.routes.js     # /api/siesa/*
│   │   ├── despacho.routes.js  # /api/despachos/*
│   │   └── auditor.routes.js   # /api/auditor/*
│   └── services/
│       ├── siesa.service.js    # Lógica de consultas SIESA (criterios desde datos, filtrado)
│       ├── despacho.service.js # Lógica de negocio de despachos + planillas Excel
│       └── sugerido.service.js # Cálculo de cantidad sugerida
├── .env                       # Variables de entorno
├── .env.example               # Template de variables
└── package.json
```

---

## Flujo de un despacho

```
Admin                          Despachador                     Auditor
  │                                │                             │
  ├── 1. Selecciona criterios ─────┤                             │
  ├── 2. Consulta productos ───────┤                             │
  ├── 3. Define cantidades ────────┤                             │
  ├── 4. Asigna destino y ─────────┤                             │
  │    despachador                  │                             │
  ├── 5. Crea despacho ────────────┤                             │
  │    (estado: "Creado")           │                             │
  │                                │                             │
  │                   6. Recibe despacho ─────────────────────────┤
  │                   7. Recolecta productos ─────────────────────┤
  │                   8. Marca "En_recoleccion" ──────────────────┤
  │                   9. Registra cantidades reales ──────────────┤
  │                   10. Marca "Recolectado" ────────────────────┤
  │                                │                             │
  │                                              11. Ve despachos pendientes
  │                                              12. Auditoría ciega
  │                                              13. Compara cantidades
  │                                              14. Aprueba o Rechaza
  │                                │                             │
  │                   15. Si aprobado: "Auditado" ────────────────┤
  │                   16. Si rechazado: "Rechazado" ──────────────┤
  │                                │                             │
  │                   17. Descarga planilla Excel                 │
```

### Estados del despacho

```
Creado → En_recoleccion → Recolectado → Auditado ✅
                                          → Rechazado ❌
                            → En_recepcion → Auditado ✅
                                            → Rechazado ❌
```

---

## API Endpoints

### Salud

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/health` | Health check del servidor |

### SIESA (catálogo e inventario)

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/siesa/criterios` | Lista criterios de agrupación (grupo, subgrupo, proveedor, marca, etc.) extraídos desde los datos de Copacabana |
| GET | `/api/siesa/productos?criterios=...` | Productos filtrados por criterios (ej: `["001"]`, `["003:PROVEEDOR X"]`) |
| GET | `/api/siesa/sedes` | Sedes destino disponibles (excluye origen, averías, almacenes) |

### Despachos

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/despachos` | Listar despachos (filtros: `?estado=`, `?despachador_id=`) |
| GET | `/api/despachos/:id` | Detalle completo del despacho + items + firmas |
| POST | `/api/despachos` | Crear nuevo despacho `{ destino, despachador_id, admin_id, criterios, items[] }` |
| PATCH | `/api/despachos/:id/estado` | Cambiar estado `{ estado, firma_data? }` |
| POST | `/api/despachos/:id/recolectar` | Registrar cantidades recolectadas `{ items: [{id, cantidad}] }` |
| GET | `/api/despachos/:id/planilla?tipo=recoleccion` | Descargar planilla Excel (plano recolección o final) |

### Auditoría

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/auditor/despachos` | Listar despachos pendientes de auditoría (Recolectado, En_recepcion) |
| GET | `/api/auditor/despachos/:id` | Detalle para auditoría ciega (sin `cantidad_despachador`) |
| POST | `/api/auditor/despachos/:id/auditar` | Enviar cantidades del auditor `{ items: [{id, cantidad_auditor}], firma_data? }` |

---

## Base de datos (Supabase)

### Tablas

#### `traslados_despachos`

Cabecera del despacho.

| Columna | Tipo | Descripción |
|---------|------|-------------|
| `id` | BIGINT PK | Auto-generado |
| `origen` | VARCHAR(20) | Bodega origen (default: "PV001") |
| `destino` | VARCHAR(20) | Sede destino |
| `despachador_id` | VARCHAR(100) | ID del despachador asignado |
| `admin_id` | VARCHAR(100) | ID del admin que creó el despacho |
| `criterios` | JSONB | Criterios usados para filtrar productos |
| `estado` | VARCHAR(30) | Estado actual (ver máquina de estados) |
| `created_at` | TIMESTAMPTZ | Fecha de creación |
| `updated_at` | TIMESTAMPTZ | Última actualización (auto via trigger) |

#### `traslados_items`

Productos incluidos en un despacho.

| Columna | Tipo | Descripción |
|---------|------|-------------|
| `id` | BIGINT PK | Auto-generado |
| `despacho_id` | BIGINT FK | → traslados_despachos(id) ON DELETE CASCADE |
| `codigo_item` | VARCHAR(20) | Código del producto en SIESA |
| `descripcion` | TEXT | Descripción del producto |
| `unidad_medida` | VARCHAR(10) | UM (unidad, kilo, etc.) |
| `sugerido` | NUMERIC(12,2) | Cantidad sugerida por el sistema |
| `cantidad_admin` | NUMERIC(12,2) | Cantidad que pidió el admin |
| `cantidad_despachador` | NUMERIC(12,2) | Cantidad real recolectada (nullable) |
| `cantidad_auditor` | NUMERIC(12,2) | Cantidad verificada por el auditor (nullable) |
| `diferencia` | NUMERIC(12,2) | cantidad_auditor - cantidad_despachador |
| `aceptado` | BOOLEAN | Estado del item tras auditoría |
| `created_at` | TIMESTAMPTZ | |
| `updated_at` | TIMESTAMPTZ | |

#### `traslados_firmas`

Firmas digitales (base64 de la firma manuscrita).

| Columna | Tipo | Descripción |
|---------|------|-------------|
| `id` | BIGINT PK | Auto-generado |
| `despacho_id` | BIGINT FK | → traslados_despachos(id) ON DELETE CASCADE |
| `rol` | VARCHAR(30) | "despachador" o "auditor" |
| `firma_data` | TEXT | Imagen en base64 |
| `created_at` | TIMESTAMPTZ | |

### Seguridad

RLS deshabilitado — el backend se conecta con `service_role` (bypasses RLS automáticamente).

---

## Máquina de estados

```
┌─────────┐     ┌───────────────┐     ┌─────────────┐
│ Creado  │────→│ En_recoleccion│────→│ Recolectado │
└─────────┘     └───────────────┘     └──────┬──────┘
                                              │
                                     ┌────────┴────────┐
                                     ▼                 ▼
                               ┌──────────┐     ┌──────────┐
                               │ Auditado │     │Rechazado │
                               └──────────┘     └──────────┘

Transiciones permitidas:
- Creado          → En_recoleccion
- En_recoleccion  → Recolectado
- Recolectado     → En_recepcion, Auditado
- En_recepcion    → Auditado, Rechazado
- Auditado        → (terminal)
- Rechazado       → (terminal)
```

---

## Integración SIESA (Connekta)

### ¿Qué es Connekta?

Connekta es una API REST que expone consultas a la base de datos SIESA (ERP de Merkahorro). No tenemos acceso SQL directo a SIESA; todo pasa por queries registrados en la plataforma Connekta.

### Queries registradas

| Nombre en Connekta | Propósito |
|---|---|
| `merkahorro_traslados_dev` | Query general de productos (1M+ registros, todas las bodegas) |
| `merkahorro_traslados_bodega_dev` | Query filtrada por bodega 00101 (Copacabana) — ~608 productos, 4 páginas |
| `merkahorro_sedes_dev` | Query de bodegas/sedes |

### Auth

Toda llamada a Connekta requiere dos headers:

- `conniKey` — API key de integración
- `conniToken` — JWT de autenticación

### Comportamiento

- Paginación obligatoria: `GET /ejecutarconsulta?idCompania=7375&nomConsulta=...&numPag=1&tamPag=200`
- Cada página tarda ~1-2 segundos
- Los datos se cachean en disco por 30 minutos para evitar llamadas repetidas
- **IMPORTANTE**: si se modifica un query en la plataforma Connekta, se resetean los permisos y hay que re-asignarlos

### Extracción de criterios

Los criterios de filtrado (Grupo, Subgrupo, Proveedor, Marca, etc.) no vienen de un endpoint separado. Se extraen directamente desde los datos del query de bodega, recorriendo los campos `DescMayor1` a `DescMayorSP` y recopilando valores únicos.

---

## Caché persistente

Para evitar llamadas repetidas a Connekta (~5-10 segundos por carga), el backend implementa un sistema de caché propio:

1. **En memoria**: acceso instantáneo mientras el servidor corre
2. **En disco** (`cache-data/`)**: sobrevive reinicios del servidor
3. **TTL**: 30 minutos por defecto, configurable por clave

El caché se implementa en `src/config/cache.js` con la función `getOrSet(key, fn, ttlMs)`.

---

## Frontend relacionado

El frontend de este backend vive en el repositorio principal de la página web:

```
Pagina-web_React/src/pages/Traslados/
├── AdminPanel.jsx              # Panel de administración (crear despachos)
├── DespachadorPanel.jsx        # Panel del despachador (recolectar)
├── AuditorPanel.jsx            # Panel del auditor (auditoría ciega)
├── AdminPanel.css
├── DespachadorPanel.css
├── AuditorPanel.css
├── components/
│   ├── SelectorCriterios.jsx   # Selección de criterios SIESA
│   ├── SelectorSedeDestino.jsx # Selección de sede destino
│   ├── TablaProductosSiesa.jsx # Tabla de productos con cantidades
│   └── SignatureModal.jsx      # Modal de firma digital
├── hooks/
│   ├── useSiesaApi.js          # Hooks TanStack Query para SIESA
│   └── useDespacho.js           # Hooks TanStack Query para despachos
└── services/
    └── trasladosApi.js          # Cliente Axios (base URL desde VITE_TRASLADOS_API_URL)
```

### Conexión frontend ↔ backend

El frontend se conecta al backend mediante axios. La URL base se configura con la variable de entorno:

```
VITE_TRASLADOS_API_URL=http://localhost:3001/api
```

En producción, apuntará al dominio del backend desplegado (Vercel).

---

## Setup local

### Prerrequisitos

- Node.js 24+
- Proyecto Supabase con las tablas creadas (`sql/001_create_tables.sql`)
- Credenciales Connekta (CONNI_KEY, CONNI_TOKEN)
- Queries de Connekta registradas (merkahorro_traslados_dev, merkahorro_traslados_bodega_dev, merkahorro_sedes_dev)

### Instalación

```bash
cd Backend-traslados
cp .env.example .env   # Configurar variables
npm install
npm run dev            # Arranca con --watch (reinicio automático en cambios)
```

### Variables de entorno (`.env`)

```
PORT=3001
NODE_ENV=development

# Supabase (service_role — ¡nunca exponer al cliente!)
SUPABASE_URL=https://pitpougbnibmfrjykzet.supabase.co
SUPABASE_SERVICE_KEY=...

# Connekta API — conexión a SIESA
CONNEKTA_BASE_URL=https://servicios.siesacloud.com/api/connekta/v3
CONNEKTA_ID_COMPANIA=7375
CONNEKTA_QUERY_TRASLADOS=merkahorro_traslados_dev
CONNEKTA_QUERY_BODEGA=merkahorro_traslados_bodega_dev
CONNEKTA_QUERY_SEDES=merkahorro_sedes_dev

# Credenciales Connekta/Conni
CONNI_KEY=...
CONNI_TOKEN=...
```

---

## Despliegue

El backend está diseñado para desplegarse en **Vercel** como serverless function, o en cualquier hosting que soporte Node.js.

### Build

```bash
npm ci --production
```

La configuración de Vercel requiere un `vercel.json` en la raíz con la configuración de rutas hacia Express.

---

## Notas para IA que lea esto

- El backend usa **ESM puro** (`import`/`export`), no CommonJS
- Las consultas a SIESA son **lentas** (~5-10s la primera vez) — el caché en disco las hace instantáneas después
- `service_role` de Supabase **bypasses RLS** — no configurar políticas RLS para estas tablas
- El frontend espera que el backend responda con `{ ok: true, data: ... }` en todas las respuestas exitosas
- Los errores se devuelven como `{ error: "mensaje" }` con códigos HTTP apropiados
- No hay autenticación en el backend aún — los IDs de usuario (admin_id, despachador_id) son strings libres
- Los despachadores están hardcodeados en el frontend (`d1`, `d2`) — falta endpoint real de usuarios
- Endpoints de SIESA (`/api/siesa/*`) están validados con caché de 30 minutos
