# Consulta de tránsito en Connekta

El backend necesita **leer** de SIESA qué documentos de tránsito existen. Sin esto
la entrada automática no arranca.

Sirve para dos cosas:

1. **Recuperar el consecutivo de la salida** cuando el conector no lo devuelve.
   La entrada lo necesita sí o sí (`CONSECUTIVO` del documento base). Ese agujero
   dejó el par abierto dos semanas.
2. **Preguntar si la entrada ya existe** antes de crearla. Durante la transición
   hay personas creándolas a mano en el ERP; crear una segunda duplica el
   inventario en la tienda destino.

---

## 1. Registrar la consulta

Connekta **no recibe SQL por HTTP** — el endpoint `ejecutarconsulta` solo acepta el
*nombre* de una consulta ya registrada. Hay que darla de alta en la pantalla de
consultas dinámicas de SIESA.

**Nombre sugerido:** `merkahorro_transito_docs_dev`

```sql
SELECT D.f350_id_co AS CO, LTRIM(RTRIM(D.f350_id_tipo_docto)) AS Tipo, D.f350_consec_docto AS Nro, D.f350_fecha AS Fecha, D.f350_notas AS Notas
FROM dbo.t350_co_docto_contable AS D
WHERE D.f350_fecha >= DATEADD(day, -60, GETDATE()) AND LTRIM(RTRIM(D.f350_id_tipo_docto)) IN ('CTS', 'CTE')
```

Reglas de forma que Connekta impone: **sin `;` final, sin `ORDER BY`, sin
comentarios**. Cualquiera de las tres devuelve un 500 de sintaxis.

### Por qué está escrita así

| Decisión | Motivo |
|---|---|
| Ventana **móvil** de 60 días (`DATEADD`) | La consulta anterior tenía `>= '2026-08-01' AND < '2026-09-01'` clavado. El 1 de septiembre empezó a devolver cero y lo iba a hacer para siempre. |
| **Sin** `HAVING cant_base_pendiente > 0` | Ese filtro devolvía cero registros: las salidas ya tenían su entrada, así que el pendiente era 0. Filtraba justo lo que buscábamos. |
| `f350_notas` en el SELECT | Es el **único** hilo que ata un documento de SIESA con un despacho nuestro. Dos despachos de la misma ruta el mismo día son indistinguibles sin esto. |
| `CTS` **y** `CTE` juntos | Una sola consulta, una sola autorización, una sola llamada HTTP para las dos preguntas. |
| Sin filtro de compañía | La nuestra es la `cia = 1`, pero el filtro no hace falta: el apareo es por uuid de las notas, y ningún uuid nuestro va a aparecer en otra compañía. |

Si `DATEADD`/`GETDATE` dieran problema, se puede volver a una fecha fija — pero
entonces **hay que acordarse de moverla**, y ese es exactamente el bug que ya nos
comimos.

## 2. Autorizar nuestro consumidor

El par `conniKey` / `conniToken` identifica a un **consumidor**, y cada consulta se
expone a consumidores puntuales. El `conniKey` del `.env` de este backend lee
`merkahorro_sedes_dev` y `merkahorro_costo_promedio_dev`, pero **no** tenía
asignadas las consultas de tránsito.

> ⚠️ Connekta devuelve el **mismo HTTP 401** para "no tenés permiso" y para "esa
> consulta no existe". El mensaje habla de permisos en los dos casos. Para
> distinguirlos, probá con un nombre inventado: si da el mismo error, el 401 no te
> está diciendo nada.

## 3. Configurar el backend

```bash
SIESA_CONSULTA_TRANSITO=merkahorro_transito_docs_dev
SIESA_SOLO_SALIDA=0
SIESA_ENTRADA_VERIFICAR=1
```

En Vercel hay que setear las tres. `SIESA_SOLO_SALIDA` estaba en `1`.

## 4. Verificar antes de soltarlo

```bash
node scripts/verificar-transito.js
```

Imprime cuántos documentos ve, cuántos aparea por uuid y qué despachos tienen la
salida sin entrada. **Si esto no corre limpio, no prendas la entrada automática.**

---

## Cómo se comporta si algo falla

| Situación | Qué hace |
|---|---|
| Falta `SIESA_CONSULTA_TRANSITO` | **Frena** el envío de la entrada, despacho `pendiente`. No manda a ciegas. |
| Connekta responde 401 o se cae | **Frena** igual, con el error en `siesa_error`. |
| La entrada ya existe en SIESA | La **adopta**: guarda su consecutivo y marca `siesa_entrada_externa = true`. No crea otra. |
| El conector no devolvió el consecutivo | Lo **busca** en esta consulta y sigue. |
| Aparecen dos documentos de la misma cara | Usa el primero y **avisa por log** — es un duplicado en el ERP que alguien tiene que mirar. |

El criterio detrás de todo esto: un traslado trabado se destraba en un minuto
desde la app; una entrada duplicada hay que ir a pedirle a SIESA que la borre.
