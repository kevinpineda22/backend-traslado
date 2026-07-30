import * as DespachoModel from "../models/Despacho.model.js";
import { obtenerAlertas } from "../models/Config.model.js";
import { tomarLock, liberarLock } from "./lock.service.js";
import { emailConfigurado } from "./email.service.js";
import {
  notificarSinIniciarRecoleccion,
  notificarSinIniciarAuditoria,
} from "./notificacionesTraslado.service.js";

/* =============================================
   Barrido de alertas por inactividad

   POR QUÉ UN BARRIDO Y NO UN TEMPORIZADOR
   ───────────────────────────────────────
   La alerta se dispara por el paso del tiempo, no por una acción del usuario: hay
   que avisar justamente porque NADIE hizo nada. En serverless no existe un proceso
   vivo que pueda esperar 5 horas — la función atiende el request y muere. Así que
   alguien de afuera tiene que preguntar "¿hay algo vencido?" cada tanto: el cron
   de Vercel llama a GET /api/alertas/barrer cada 10 minutos.

   LAS TRES REGLAS
   ───────────────
   Todas miden `disponible_at` = desde cuándo el traslado espera que alguien lo
   tome (ver migración 013).

     1. recoleccion → 'Creado' vencido                        → correo (una vez)
     2. auditoria   → esperando auditor y SIN nadie atendiéndolo → correo (una vez)
     3. inactivar   → cualquiera de las dos vencida            → marca inactivo

   CÓMO SE SABE QUE "NADIE LO ESTÁ ATENDIENDO"
   Ni por el estado ni por `auditoria_iniciada_at`. El auditor cuenta TODO en el
   navegador (localStorage) y no toca el backend hasta que aprieta Comparar, así
   que durante todo el conteo el traslado se ve exactamente igual a uno abandonado:
   estado 'Recolectado' y `auditoria_iniciada_at` en NULL. Sin más señal, la regla 3
   congelaba traslados con el auditor contando, y al firmar se comía un 409.

   La señal es `auditoria_abierta_at` (migración 015), que se re-sella cada vez que
   el auditor abre o compara. Y se mide su FRESCURA, no su existencia: marcarlo como
   "ya abierto" para siempre dejaría al que abre y se va inmune a las tres reglas —
   invisible justo para lo que las alertas existen. Con la ventana de gracia, el que
   está contando queda protegido y el que abandonó vuelve a la cola.

   ORDEN: primero los correos, después la inactivación. Al revés, un traslado que
   cruza los dos umbrales en el mismo barrido se inactivaría antes de avisar y
   nadie se enteraría nunca de que existió.

   IDEMPOTENCIA
   ────────────
   Cada correo se marca en `alerta_*_at` y la consulta pide `IS NULL`, así el
   aviso sale UNA vez por traslado y por etapa. Sin eso, el cron de 10 minutos
   mandaría 6 correos por hora del mismo traslado hasta que alguien lo atienda —
   y una alerta que grita todo el tiempo es una alerta que se filtra a la papelera.

   Un lock corto evita que dos barridos superpuestos manden el mismo correo dos
   veces (el marcado no es atómico contra la lectura).
   ============================================= */

const LOCK = "alertas:barrido";
const LOCK_TTL_S = 120;

/** Etapas donde el traslado ESPERA a alguien, por tipo de alerta. */
const ESTADOS_ESPERA_DESPACHADOR = ["Creado"];
// El flujo real hoy es Recolectado → Auditado/Rechazado/Inconsistencia: NADIE setea
// 'En_recepcion' (está declarado en las transiciones y en los validators, pero no
// hay filas en ese estado). Se lo deja listado para que la regla siga valiendo si
// algún día se usa, pero NO aporta ninguna red de seguridad hoy — quien distingue
// "lo están atendiendo" de "está abandonado" es `auditoria_abierta_at`, no el estado.
const ESTADOS_ESPERA_AUDITOR = ["Recolectado", "En_recepcion"];

/**
 * Ventana de gracia del auditor: cuánto tiempo después de abrir un traslado se lo
 * considera "en manos de alguien". Un conteo de varios cientos de ítems puede
 * llevar más de una hora, así que el default es generoso — equivocarse para el
 * lado de no molestar es barato; equivocarse para el otro traba a una persona con
 * el conteo hecho.
 */
const GRACIA_AUDITOR_H = Number(process.env.ALERTAS_GRACIA_AUDITOR_HORAS) || 4;

const horasDesde = (iso) => (Date.now() - new Date(iso).getTime()) / 36e5;

/** ISO del instante a partir del cual un `disponible_at` se considera vencido. */
const corteDe = (horas) => new Date(Date.now() - horas * 36e5).toISOString();

/**
 * ISO del corte de actividad del auditor: si `auditoria_abierta_at` es POSTERIOR a
 * este instante, hay alguien trabajando y el traslado no se toca.
 */
const corteAuditor = () => corteDe(GRACIA_AUDITOR_H);

/**
 * Corre una regla de alerta por correo: busca los vencidos, manda y marca.
 *
 * El marcado va DESPUÉS del envío y solo si el correo salió. Si SMTP falla, el
 * traslado queda sin marca y el próximo barrido reintenta — una caída de correo no
 * puede consumir el único aviso que ese traslado iba a generar. El riesgo inverso
 * (marcar antes y perder el aviso) es el que no se puede recuperar.
 */
async function correrReglaCorreo({
  regla,
  cfg,
  estados,
  campoAlerta,
  notificar,
  respetaAuditor = false,
}) {
  if (!cfg.activa) return { regla, activa: false, vencidos: 0, enviados: 0 };

  const vencidos = await DespachoModel.findEstancados({
    estados,
    corte: corteDe(cfg.horas),
    campoAlerta,
    auditorInactivoDesde: respetaAuditor ? corteAuditor() : null,
  });

  let enviados = 0;
  for (const despacho of vencidos) {
    const horasReales = Math.floor(horasDesde(despacho.disponible_at));
    const r = await notificar(despacho, {
      horas: cfg.horas,
      horasReales,
      correos: cfg.correos,
    }).catch((e) => ({ success: false, error: e.message }));

    if (r?.success) {
      await DespachoModel.marcarAlertaEnviada(despacho.id, campoAlerta);
      enviados += 1;
    } else {
      console.error(
        `[alertas] ${regla}: no se pudo avisar del traslado ${despacho.id}: ${r?.error || "error desconocido"}`,
      );
    }
  }

  return { regla, activa: true, vencidos: vencidos.length, enviados };
}

/**
 * Inactiva los traslados estancados más allá del umbral.
 *
 * No lleva marca de deduplicación porque la bandera `inactivo` ES la marca: la
 * consulta ya filtra `inactivo = false`, así que un traslado inactivado no vuelve
 * a aparecer. Y si alguien lo reactiva a mano, `setActivo` re-sella el reloj —
 * por eso el barrido no lo vuelve a agarrar en la pasada siguiente.
 */
async function correrReglaInactivar(cfg) {
  if (!cfg.activa) return { regla: "inactivar", activa: false, vencidos: 0, inactivados: 0 };

  const vencidos = await DespachoModel.findEstancados({
    estados: [...ESTADOS_ESPERA_DESPACHADOR, ...ESTADOS_ESPERA_AUDITOR],
    corte: corteDe(cfg.horas),
    // Nunca se congela un traslado que un auditor tiene abierto AHORA: le borraría
    // el trabajo de la pantalla a mitad de conteo y lo dejaría con un 409 al firmar.
    // Eso lo decide una persona, no un cron. Pero "abierto hace tres días y nunca
    // confirmado" sí es abandono, y ese vuelve a la cola — por eso es frescura y no
    // un "ya lo abrieron" permanente. (Para los 'Creado' la condición no cambia
    // nada: nunca tienen apertura de auditoría.)
    auditorInactivoDesde: corteAuditor(),
  });

  let inactivados = 0;
  for (const despacho of vencidos) {
    const horasReales = Math.floor(horasDesde(despacho.disponible_at));
    const etapa =
      despacho.estado === "Recolectado" ? "sin auditar" : "sin iniciar la recolección";
    try {
      await DespachoModel.setActivo(
        despacho.id,
        false,
        `Inactivado automáticamente: ${horasReales} h ${etapa} (umbral ${cfg.horas} h)`,
      );
      inactivados += 1;
      console.log(
        `[alertas] 🔒 traslado ${despacho.id} inactivado — ${horasReales} h ${etapa}`,
      );
    } catch (e) {
      console.error(`[alertas] no se pudo inactivar ${despacho.id}: ${e.message}`);
    }
  }

  return { regla: "inactivar", activa: true, vencidos: vencidos.length, inactivados };
}

/**
 * Una pasada completa del barrido. Nunca lanza por un traslado suelto: un correo
 * que falla no puede abortar el resto de la cola.
 *
 * @returns {Promise<object>} resumen de lo que hizo cada regla
 */
export async function barrerAlertas() {
  if (!(await tomarLock(LOCK, LOCK_TTL_S, "barrido-alertas"))) {
    return { ok: true, saltado: true, motivo: "otro barrido en curso" };
  }

  try {
    const cfg = await obtenerAlertas();

    // Si el correo no está configurado, las reglas de aviso no pueden cumplirse.
    // Lo decimos fuerte en vez de reportar "0 enviados", que se lee como "no había
    // nada vencido" — la confusión que ya nos costó semanas en este proyecto.
    const puedeAvisar = emailConfigurado();
    if (!puedeAvisar && (cfg.recoleccion.activa || cfg.auditoria.activa)) {
      console.error(
        "[alertas] ⚠️ hay alertas activas pero falta EMAIL_USER/EMAIL_PASS: no se puede avisar a nadie",
      );
    }

    const reglas = [];

    if (puedeAvisar) {
      reglas.push(
        await correrReglaCorreo({
          regla: "recoleccion",
          cfg: cfg.recoleccion,
          estados: ESTADOS_ESPERA_DESPACHADOR,
          campoAlerta: "alerta_recoleccion_at",
          notificar: notificarSinIniciarRecoleccion,
        }),
      );
      reglas.push(
        await correrReglaCorreo({
          regla: "auditoria",
          cfg: cfg.auditoria,
          estados: ESTADOS_ESPERA_AUDITOR,
          campoAlerta: "alerta_auditoria_at",
          notificar: notificarSinIniciarAuditoria,
          respetaAuditor: true,
        }),
      );
    }

    // La inactivación va al final: primero se avisa, después se congela.
    reglas.push(await correrReglaInactivar(cfg.inactivar));

    const resumen = { ok: true, email_configurado: puedeAvisar, reglas };
    console.log(
      `[alertas] barrido: ${reglas
        .map((r) =>
          r.activa
            ? `${r.regla}=${r.enviados ?? r.inactivados}/${r.vencidos}`
            : `${r.regla}=apagada`,
        )
        .join(", ")}`,
    );
    return resumen;
  } finally {
    await liberarLock(LOCK);
  }
}

/**
 * Traslados inactivos, para la sección Alertas del panel (donde se reactivan).
 * Trae el resumen de ítems para que el encargado sepa qué está congelando.
 */
export async function listarInactivos() {
  return DespachoModel.findAllWithResumen({ inactivo: true });
}

/** Reactiva un traslado inactivo: vuelve a los paneles con el reloj en cero. */
export async function reactivar(id) {
  return DespachoModel.setActivo(id, true);
}

/** Inactiva un traslado a mano desde el panel. */
export async function inactivar(id, motivo = "Inactivado manualmente desde el panel") {
  return DespachoModel.setActivo(id, false, motivo);
}
