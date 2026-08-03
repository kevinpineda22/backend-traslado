# API de Novedades de Inventario — Traslados

Consulta de solo lectura sobre las novedades que reporta el despachador al recolectar un traslado: productos agotados, inventario fantasma y surtidos parciales. Devuelve el **detalle renglón por renglón** (producto, sede, cantidades, fecha, estado del traslado), para que cada área filtre y cruce contra su propia información sin depender de los correos automáticos.

Es una superficie **solo lectura y versionada**: ningún consumidor externo puede modificar despachos.

---

## Ruta base

```
https://<host-del-backend-traslados>/api/integraciones
```

Toda petición requiere el header `X-API-Key` con la clave entregada a su área.

> **Si prueba desde PowerShell:** escriba `curl.exe`, no `curl`. En PowerShell, `curl` es un alias de `Invoke-WebRequest`, que no acepta los parámetros `-s` ni `-H` y devuelve un error de argumentos que no tiene nada que ver con esta API. Los ejemplos de abajo usan `curl.exe`, que funciona igual en PowerShell, en CMD y en Git Bash.

## Camino rápido

1. Verifique que su clave quedó bien configurada:

```bash
curl.exe -H "X-API-Key: SU_CLAVE" https://<host>/api/integraciones/ping
```

2. Traiga las novedades del mes:

```bash
curl.exe -H "X-API-Key: SU_CLAVE" "https://<host>/api/integraciones/v1/novedades?fecha_desde=2026-08-01&limit=100"
```

3. Confirme el resultado: la respuesta trae `paginacion.total` con el número de novedades que cumplen el filtro, y `paginacion.hay_mas` en `true` si falta traer páginas.

---

## Endpoints

| Método | Ruta | Devuelve |
|--------|------|----------|
| `GET` | `/ping` | Confirma que la clave es válida y de qué consumidor es. |
| `GET` | `/v1/novedades` | Detalle paginado de novedades. |
| `GET` | `/v1/novedades/tipos` | Catálogo de tipos de novedad. |

Consulte `/v1/novedades/tipos` en lugar de fijar los valores en su código: si a futuro se agrega un cuarto tipo de novedad, su integración lo descubre sola.

## Tipos de novedad

| `tipo` | Etiqueta | Qué significa |
|--------|----------|---------------|
| `AGOTADO` | Agotado | No había existencias en la bodega de origen. |
| `INVENTARIO_FANTASMA` | Inventario Fantasma | El sistema mostraba stock, pero físicamente no estaba. **Este es el caso que hoy se envía por correo a Inventarios.** |
| `SURTIDO_PARCIAL` | Surtido parcial en PV | La bodega quedó incompleta porque parte de la cantidad ya se surtió en el punto de venta. |

## Filtros

Todos son opcionales y se combinan entre sí (se aplican con AND).

| Parámetro | Ejemplo | Notas |
|-----------|---------|-------|
| `tipo` | `INVENTARIO_FANTASMA` | Acepta varios: `tipo=AGOTADO,INVENTARIO_FANTASMA`. Un valor mal escrito devuelve `400`, no una lista vacía. |
| `destino` | `00301` | Código de sede que recibe. |
| `origen` | `PV001` | Código de la bodega que despacha. |
| `codigo_item` | `0005312` | Un producto puntual, en todo su histórico. |
| `estado` | `Auditado` | Estado del traslado. |
| `fecha_desde` | `2026-08-01` | Inclusivo. Ver *Sobre las fechas*. |
| `fecha_hasta` | `2026-08-31` | Inclusivo: una fecha sin hora cubre el día completo. |
| `limit` | `100` | Por defecto `100`, máximo `1000`. |
| `offset` | `200` | Para paginar. |

Códigos de sede válidos para `origen` y `destino`:

| Código | Sede |
|--------|------|
| `PV001` | Principal Copacabana |
| `00201` | Villahermosa |
| `00301` | Girardota Parque |
| `00401` | Girardota Llano |
| `00601` | Vegas |
| `00701` | Barbosa |
| `00801` | San Juan |

### Sobre las fechas

`fecha_desde` y `fecha_hasta` filtran por la **fecha de creación del traslado**, no por el momento exacto en que se registró la novedad. Se eligió así porque es la única fecha que no se mueve: el renglón se vuelve a tocar cuando el auditor hace la recepción, así que filtrar por su última modificación daría resultados distintos según cuándo se consulte.

Cada novedad trae además `traslado.recoleccion_finalizada_at` (cuándo terminó la recolección) y `actualizada_at` (última modificación del renglón) si necesita mayor precisión en un análisis puntual.

---

## Respuesta

```json
{
  "ok": true,
  "paginacion": { "total": 348, "limit": 100, "offset": 0, "hay_mas": true },
  "data": [
    {
      "novedad_id": "ff747a71-4252-48ef-9ef8-8f14a224c2a5",
      "tipo": "INVENTARIO_FANTASMA",
      "tipo_etiqueta": "Inventario Fantasma",
      "producto": {
        "codigo": "25588",
        "descripcion": "HUEVO TIPO AA X UND",
        "grupo": "HUEVOS",
        "categoria": "HUEVOS"
      },
      "unidad_medida": "P30",
      "factor": 30,
      "cantidad_solicitada": 40,
      "cantidad_despachada": 0,
      "cantidad_despachada_und": 0,
      "cantidad_auditada_und": null,
      "faltante_und": 40,
      "no_recibido": false,
      "agregado_por_auditor": false,
      "traslado": {
        "id": "c46038f8-c8fe-4b9e-a92b-9e1f76e538a5",
        "estado": "En_recoleccion",
        "origen": { "codigo": "00301", "nombre": "Girardota Parque" },
        "destino": { "codigo": "00401", "nombre": "Girardota Llano" },
        "creado_at": "2026-08-03T08:00:25.432441-05:00",
        "recoleccion_finalizada_at": "2026-08-03T08:14:56.978-05:00"
      },
      "actualizada_at": "2026-08-03T08:15:35.111047-05:00"
    }
  ]
}
```

> **`novedad_id` y `traslado.id` son UUID (texto), no números.** Declare esas columnas como texto en su modelo o su tabla de destino. `producto.codigo` también es texto: hay códigos con ceros a la izquierda, y tratarlos como número los pierde.

Un mismo `traslado.id` aparece en varias novedades: son los distintos renglones de un mismo despacho. Si necesita agrupar por traslado, use ese campo.

### Cantidades: lea esto antes de sumar

Un mismo producto puede aparecer en **varios renglones del mismo traslado**, uno por unidad de medida, y cada unidad tiene su propio factor de conversión.

| Campo | Unidad | Cuándo usarlo |
|-------|--------|---------------|
| `cantidad_solicitada` | UND | Lo que pidió el administrador. |
| `cantidad_despachada` | La del renglón (`unidad_medida`) | Solo para mostrar tal como lo registró el despachador. |
| `cantidad_despachada_und` | UND | **Para sumar, comparar o cruzar contra su stock.** |
| `cantidad_auditada_und` | UND | Conteo del auditor en recepción. `null` si aún no auditó. |
| `faltante_und` | UND | `cantidad_solicitada - cantidad_despachada_und`, con piso en 0. |

Regla práctica: **si va a sumar o comparar, use los campos que terminan en `_und`.** Sumar `cantidad_despachada` entre renglones de distinta unidad da un número sin significado.

## Paginación

`limit` y `offset`, con orden fijo por fecha descendente. Para recorrer todo el resultado:

1. Pida con `offset=0`.
2. Mientras `paginacion.hay_mas` sea `true`, repita sumando `limit` al `offset`.
3. Deténgase cuando `hay_mas` sea `false`.

El orden es estable entre páginas, así que no verá registros repetidos ni saltados.

## Errores

| Código | Significado | Qué hacer |
|--------|-------------|-----------|
| `400` | Parámetro inválido (fecha mal formada, `tipo` inexistente). | Corregir el parámetro; el mensaje dice cuál. |
| `401` | Falta el header `X-API-Key`, o la clave no es válida. | Verificar el header con `GET /ping`. |
| `503` | Integraciones no configuradas en el entorno. | Avisar al equipo de Traslados. |

Los errores siempre responden `{ "ok": false, "error": "<mensaje>" }`.

---

## Checklist de integración

- [ ] `GET /ping` responde `ok: true` con el nombre de su área en `consumidor`.
- [ ] Su código lee los tipos desde `/v1/novedades/tipos`, no de una lista fija.
- [ ] Sus sumas y cruces usan los campos `_und`, no `cantidad_despachada`.
- [ ] Su recorrido pagina hasta que `hay_mas` sea `false`.
- [ ] Su clave está en una variable de entorno o secreto, no en el código fuente.
- [ ] Si consulta periódicamente, lo hace con `fecha_desde` acotada y no trae el histórico completo cada vez.

---

## Para el equipo de Traslados

### Alta de un consumidor

1. Genere una clave:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

2. Agréguela a la variable de entorno `INTEGRACIONES_API_KEYS` en Vercel. Acepta dos formatos equivalentes:

```
INTEGRACIONES_API_KEYS={"inventarios":"a1b2...","compras":"c3d4..."}
```

```
INTEGRACIONES_API_KEYS=inventarios:a1b2...,compras:c3d4...
```

3. Redeploye y entregue la clave por un canal privado — nunca por correo abierto ni en un chat de grupo.

### Revocar un acceso

Borre la entrada de ese consumidor de `INTEGRACIONES_API_KEYS` y redeploye. Los demás consumidores no se ven afectados: por eso cada área tiene clave propia y no una compartida.

### Nota de seguridad

Si `INTEGRACIONES_API_KEYS` no está configurada, estos endpoints responden `503` y **no** dejan pasar. Es deliberado: un deploy con la variable olvidada no debe convertirse en una API pública.

El resto del backend (`/api/despachos`, `/api/auditor`, …) sigue **sin autenticación**. Esta migración no lo resuelve — solo evita que la integración nueva amplíe el problema. Ver `docs/PENDIENTES_BACKEND.md`.

## Siguiente paso

Ejecute `sql/022_index_novedades.sql` en Supabase antes de habilitar el primer consumidor: sin esos índices, cada consulta recorre la tabla completa de ítems.
