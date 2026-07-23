# Refresh del snapshot en GitHub Actions (fuera de Vercel)

## Por qué

El pull de SIESA tarda ~4.5 min. En Vercel muere por el límite de **300s**
(`FUNCTION_INVOCATION_TIMEOUT`) → el snapshot quedaba viejo de forma intermitente.
GitHub Actions no tiene ese límite (hasta 6h), así que el pull corre tranquilo.

## Qué se cambió

- **`scripts/refresh-snapshot.js`** — corre el pull (reutiliza `refrescarSnapshotUnico`:
  lock distribuido + guardas de completitud + prune con gracia; misma lógica que el
  endpoint).
- **`.github/workflows/snapshot-refresh.yml`** — cron cada 15 min que ejecuta el script.
- **`vercel.json`** — se quitó el cron `/api/siesa/refresh` (ahora lo hace GitHub
  Actions). Quedó solo el de requisiciones.
- El endpoint `POST /api/siesa/refresh` (botón "Actualizar ahora") **sigue existiendo**
  como respaldo manual, pero la frescura garantizada la da GitHub Actions.

## Setup (una sola vez)

1. En el repo de GitHub del backend → **Settings → Secrets and variables → Actions →
   New repository secret**. Cargar los MISMOS valores que están en las Environment
   Variables de Vercel:

   | Secret | De dónde sale |
   |--------|---------------|
   | `SUPABASE_URL` | Vercel env |
   | `SUPABASE_SERVICE_KEY` | Vercel env |
   | `CONNEKTA_BASE_URL` | Vercel env |
   | `CONNEKTA_ID_COMPANIA` | Vercel env |
   | `CONNI_KEY` | Vercel env |
   | `CONNI_TOKEN` | Vercel env |
   | `CONNEKTA_QUERY_TRASLADOS` | Vercel env (el nombre de la consulta registrada; si en Vercel no está seteada, usa el default `merkahorro_traslados_dev`) |

2. `git push` (sube el workflow + el script + el cambio de `vercel.json`).

3. Verificar: pestaña **Actions** del repo → el workflow "Refrescar snapshot SIESA"
   debe aparecer. Se puede disparar a mano con **Run workflow** (workflow_dispatch)
   para probar sin esperar al cron.

## Botón "Actualizar ahora" (dispara el workflow)

Para que el botón manual del panel **no se cuelgue**, el endpoint
`POST /api/siesa/refresh` ahora **dispara el workflow de GitHub Actions** (vía
`workflow_dispatch`) y responde al instante (202). El pull corre por afuera y el
front muestra el avance por `/siesa/estado`. El dato tarda 1-2 min en reflejarse
(el pull es lento), pero el botón nunca se traba.

Para habilitarlo, cargar en **Vercel** (Environment Variables del backend) dos
variables nuevas:

| Variable (Vercel) | Valor |
|-------------------|-------|
| `GITHUB_REPO` | `owner/backend-traslados` (el dueño y nombre del repo) |
| `GITHUB_DISPATCH_TOKEN` | un **Personal Access Token** de GitHub con permiso para disparar workflows |

Token: en GitHub → **Settings → Developer settings → Personal access tokens**.
- Fine-grained: permiso **Actions: Read and write** sobre ese repo.
- O clásico: scope **`workflow`**.

Opcionales (tienen default): `GITHUB_WORKFLOW` (default `snapshot-refresh.yml`),
`GITHUB_REF_SNAPSHOT` (default `main`).

> Si NO se configuran estas variables, el botón cae al modo viejo (pull inline en
> Vercel, que puede tardar y llegar al timeout). Con ellas, el botón es instantáneo.

## Notas

- El scheduler de GitHub Actions es **best-effort**: bajo carga puede demorar el
  disparo algunos minutos (no es exacto cada 15). Para traslados alcanza de sobra.
- El **lock en Supabase** (`traslados_locks`) sigue protegiendo: si GitHub Actions y
  un refresh manual coinciden, el segundo recibe 202 y no duplica el pull.
- Si a futuro se quiere que el botón "Actualizar ahora" también corra fuera de Vercel,
  se puede repointar para que dispare el workflow vía `workflow_dispatch` de la API de
  GitHub (requiere un PAT como secret). Queda como mejora opcional.
