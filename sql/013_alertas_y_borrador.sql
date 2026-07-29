-- =============================================================================
-- Migration 013: sistema de alertas por inactividad + despacho en BORRADOR
-- Ejecutar en el SQL Editor de Supabase (una sola vez), ANTES de desplegar el
-- backend que depende de estas columnas.
--
-- Depende de la 010 (trazabilidad de tiempos): la alerta de auditoría usa
-- `auditoria_iniciada_at` para distinguir "nadie empezó a contar" de "el auditor
-- ya está contando y todavía no firmó".
-- =============================================================================

-- ---------------------------------------------------------------------------
-- PARTE 1 — Alertas por inactividad
--
-- Tres reglas, todas con las horas configurables desde el panel (ver PARTE 3):
--   1. El traslado quedó disponible y NADIE inició la recolección → correo.
--   2. La recolección cerró y NADIE inició la auditoría → correo.
--   3. Lleva demasiado tiempo estancado → se marca INACTIVO y desaparece de los
--      paneles del despachador y del auditor (reversible desde el panel).
--
-- QUÉ MIDE `disponible_at`: "desde cuándo este traslado espera que alguien lo
-- tome". Una sola columna cubre las tres reglas porque se re-sella en cada
-- entrega de posta:
--   → Creado       (nuevo, borrador finalizado, o abandonado): espera despachador
--   → Recolectado  (el despachador cerró):                     espera auditor
-- Mientras alguien trabaja (En_recoleccion / En_recepcion) no hay reloj: el
-- traslado no está estancado, está en curso.
--
-- POR QUÉ NO SIRVE `created_at`
-- Con los despachos en borrador (PARTE 2) un traslado puede abrirse el lunes y
-- finalizarse el jueves: medir desde la creación dispararía la alerta con 3 días
-- de atraso, por un traslado que el despachador recién puede ver el jueves.
--
-- POR QUÉ NO SIRVE `updated_at`
-- Lo pisan efectos que no son entregas de posta (reasignar despachador, marcar
-- el estado de la requisición a SIESA). Un reloj que se reinicia solo, sin que
-- nadie haya tomado el traslado, es un reloj que nunca dispara la alerta.
--
-- POR QUÉ NO ALCANZA `recoleccion_finalizada_at` (migración 010)
-- Ese es un HITO de auditoría: cuándo cerró la recolección, y no se toca nunca
-- más. `disponible_at` es una COLA: se reinicia cuando alguien abandona el
-- traslado o cuando se reactiva uno inactivo. Los dos valores empiezan iguales y
-- después divergen a propósito — mezclarlos rompería el historial o el reloj.
--
-- POR QUÉ SE GUARDA CUÁNDO SE AVISÓ
-- El barrido corre cada 10 minutos. Sin `alerta_*_at`, un traslado estancado
-- mandaría el mismo correo 6 veces por hora hasta que alguien lo atienda: el
-- encargado aprende a ignorar la alerta y el sistema deja de servir. Con la
-- marca, cada alerta sale UNA vez por traslado.
-- ---------------------------------------------------------------------------
ALTER TABLE traslados_despachos
  ADD COLUMN IF NOT EXISTS disponible_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS inactivo               BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS inactivo_at            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS inactivo_motivo        TEXT,
  ADD COLUMN IF NOT EXISTS alerta_recoleccion_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS alerta_auditoria_at    TIMESTAMPTZ;

-- Backfill: los despachos que ya existen nunca pasaron por borrador, así que su
-- `created_at` ES el momento en que quedaron disponibles. Sin esto, el barrido
-- los ignoraría para siempre (disponible_at NULL = sin reloj).
UPDATE traslados_despachos
   SET disponible_at = created_at
 WHERE disponible_at IS NULL;

-- El barrido filtra por (estado, inactivo) y ordena por el reloj. Los paneles
-- filtran por lo mismo en cada carga.
CREATE INDEX IF NOT EXISTS idx_despachos_estado_inactivo
  ON traslados_despachos (estado, inactivo);

-- ---------------------------------------------------------------------------
-- PARTE 2 — Despacho en BORRADOR (solo flujo General)
--
-- El encargado de traslados generales arma el pedido a lo largo de la semana:
-- el lunes agrega 20 ítems, el martes 15 más, y recién cuando termina lo pasa al
-- despachador. `Borrador` es el estado donde vive esa lista mientras crece.
--
-- NO se usa una tabla de staging aparte, a propósito: los ítems del borrador son
-- los MISMOS `traslados_items` (con su snapshot de inventario, criterios y
-- cantidades). Una tabla paralela obligaría a duplicar ese modelo y a copiarlo
-- al finalizar — dos representaciones del mismo dato que se desincronizan solo.
--
-- `estado` es varchar(30) sin CHECK, así que 'Borrador' no necesita DDL. La
-- máquina de estados de la aplicación es la que lo valida
-- (Despacho.model.updateStatus): Borrador → Creado, y nada más.
--
-- El índice parcial hace cumplir la regla de negocio que el código asume: UN solo
-- borrador abierto por (origen, destino). Si la garantía viviera solo en la
-- aplicación, dos pestañas abiertas crearían dos borradores para la misma sede y
-- el encargado agregaría ítems a uno mientras mira el otro. Acá lo decide la base.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS idx_despachos_borrador_unico
  ON traslados_despachos (origen, destino)
  WHERE estado = 'Borrador';

-- ---------------------------------------------------------------------------
-- PARTE 3 — Semilla de la configuración de alertas
--
-- Reusa `traslados_config` (tabla clave/valor JSONB de la migración 005) con la
-- clave 'alertas'. No hace falta tabla nueva: es exactamente el mismo caso de uso
-- que 'reposicion' — un puñado de parámetros que edita el admin.
--
-- `correos: []` significa "usar los destinatarios por defecto del backend"
-- (TRASLADOS_MAIL_DESPACHOS). Así el sistema avisa desde el minuto cero, aunque
-- nadie haya cargado correos todavía en el panel.
--
-- Las tres alertas arrancan APAGADAS (`activa: false`) a propósito. Esta
-- migración toca una base con despachos viejos: si `inactivar` entrara prendida,
-- el primer barrido inactivaría de golpe todo lo que lleva días estancado, y los
-- correos saldrían en lote. Que las prenda el encargado desde el panel cuando ya
-- vio los números.
-- ---------------------------------------------------------------------------
INSERT INTO traslados_config (clave, valor)
VALUES (
  'alertas',
  '{
    "recoleccion": {"activa": false, "horas": 5, "correos": []},
    "auditoria":   {"activa": false, "horas": 5, "correos": []},
    "inactivar":   {"activa": false, "horas": 8}
  }'::jsonb
)
ON CONFLICT (clave) DO NOTHING;
