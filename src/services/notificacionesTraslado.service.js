import { sendEmail, DESTINATARIOS, emailConfigurado } from "./email.service.js";
import { nombreSede } from "../config/flujos.js";
import { fechaHoraLegible } from "../config/tiempo.js";
import {
  MARCA,
  encabezadoMarca,
  pieMarca,
  envolverMarca,
  filaDato,
} from "./emailMarca.js";

/* =============================================
   Notificaciones de traslado (correo)

   Al cerrar la recolección (estado → Recolectado) salen hasta 3 correos:

   1. CIERRE       → despachos. SIEMPRE, haya o no faltantes. Es el acuse de que
                     el despacho se cerró; su ausencia es la señal de que algo
                     falló, no de que "todo salió bien".
   2. FALTANTES    → compras. Solo si hay ítems con motivo.
   3. INFLADO      → inventarios. Solo los ítems con 'inventario_inflado'.

   Los tres son best-effort: una caída de SMTP no revierte el despacho.
   ============================================= */

// Solo el TEXTO visible cambió (pedido de negocio): los valores internos
// (sin_stock, inventario_inflado) se mantienen. Espejo del MOTIVO_LABEL del front.
const MOTIVO_LABEL = {
  sin_stock: "Agotado",
  surtido_parcial: "Surtido parcial en PV",
  inventario_inflado: "Inventario Fantasma",
};

const MOTIVO_INFLADO = "inventario_inflado";

const esc = (v) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const num = (v) => (v == null ? "—" : Number(v));

/* El CÓDIGO DE ÍTEM sí va en el correo, a diferencia de los paneles del
   despachador y del auditor, donde se oculta a propósito (anti-fraude: se
   identifica el producto por nombre e imagen, no por el código). Acá el lector
   es compras/inventarios, que necesitan el código para buscarlo en SIESA. Otro
   público, otra regla. */
const celdaCodigo = (it) =>
  `<td style="padding:6px 10px;border:1px solid #e2e8f0;font-family:monospace;">${esc(it.codigo_item || "—")}</td>`;

function filasTabla(items) {
  return items
    .map(
      (it) => `
      <tr>
        ${celdaCodigo(it)}
        <td style="padding:6px 10px;border:1px solid #e2e8f0;">${esc(it.descripcion || "—")}</td>
        <td style="padding:6px 10px;border:1px solid #e2e8f0;text-align:center;">${num(it.cantidad_admin)}</td>
        <td style="padding:6px 10px;border:1px solid #e2e8f0;text-align:center;">${num(it.cantidad_despachador)}</td>
        <td style="padding:6px 10px;border:1px solid #e2e8f0;">${esc(MOTIVO_LABEL[it.motivo] || it.motivo)}</td>
      </tr>`,
    )
    .join("");
}

const ENCABEZADOS_FALTANTES = ["Ítem", "Producto", "Pedido", "Recolectado", "Motivo"];

/**
 * Arma el HTML del correo. `filas` y `encabezados` se pasan desde afuera porque
 * el correo de cierre y el de faltantes muestran columnas distintas.
 */
function armarHtml({
  despacho,
  titulo,
  intro,
  filas,
  encabezados = ENCABEZADOS_FALTANTES,
  acento = MARCA.verde,
}) {
  const ruta = `${nombreSede(despacho.origen)} → ${nombreSede(despacho.destino)}`;
  // Hora de Colombia, NO la del servidor (Vercel corre en UTC). Ver config/tiempo.js.
  const fecha = fechaHoraLegible(despacho.updated_at || Date.now());
  const ths = encabezados
    .map(
      (h, i) =>
        `<th style="padding:9px 10px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;text-align:${
          i === 0 || i === encabezados.length - 1 ? "left" : "center"
        };">${esc(h)}</th>`,
    )
    .join("");

  return envolverMarca(`
    ${encabezadoMarca({ titulo, acento })}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td style="padding:20px 26px 8px;">
          <p style="margin:0 0 14px;font-size:14px;line-height:1.6;color:${MARCA.texto};">${esc(intro)}</p>
          <table role="presentation" cellpadding="0" cellspacing="0" border="0"
                 style="margin:0 0 18px;background:${MARCA.fondo};border-radius:10px;padding:4px 14px;width:100%;">
            <tr><td style="padding:8px 14px 2px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                ${filaDato("Ruta", esc(ruta), true)}
                ${filaDato("Fecha", esc(fecha))}
                ${filaDato("Despacho", `<span style="font-family:monospace;font-size:11px;">${esc(String(despacho.id))}</span>`)}
              </table>
            </td></tr>
          </table>
          <table role="presentation" cellpadding="0" cellspacing="0" border="0"
                 style="border-collapse:collapse;width:100%;font-size:13px;">
            <thead><tr style="background:${MARCA.medio};color:${MARCA.blanco};">${ths}</tr></thead>
            <tbody>${filas}</tbody>
          </table>
        </td>
      </tr>
    </table>
    ${pieMarca()}
  `);
}

/** Fila de la tabla del correo de cierre (todos los ítems, no solo faltantes). */
function filasCierre(items) {
  return items
    .map((it) => {
      const pedido = Number(it.cantidad_admin) || 0;
      const recogido = Number(it.cantidad_despachador) || 0;
      const completo = recogido >= pedido;
      return `
      <tr>
        ${celdaCodigo(it)}
        <td style="padding:6px 10px;border:1px solid #e2e8f0;">${esc(it.descripcion || "—")}</td>
        <td style="padding:6px 10px;border:1px solid #e2e8f0;text-align:center;">${pedido}</td>
        <td style="padding:6px 10px;border:1px solid #e2e8f0;text-align:center;">${recogido}</td>
        <td style="padding:6px 10px;border:1px solid #e2e8f0;color:${completo ? "#16a34a" : "#dc2626"};">
          ${completo ? "Completo" : esc(MOTIVO_LABEL[it.motivo] || "Incompleto")}
        </td>
      </tr>`;
    })
    .join("");
}

/**
 * Correo de CIERRE de recolección. Sale SIEMPRE, con faltantes o sin ellos.
 *
 * Antes solo existía el correo de faltantes, así que un despacho perfecto no
 * generaba ningún correo: el sistema quedaba mudo y era imposible distinguir
 * "salió todo bien" de "el correo está roto". El acuse tiene que ser
 * incondicional para que su ausencia signifique algo.
 *
 * @param {object} despacho - cabecera + `traslados_items`
 */
export async function notificarCierreRecoleccion(despacho) {
  const items = despacho?.traslados_items || [];
  const conFaltante = items.filter((it) => it.motivo);
  const ruta = `${nombreSede(despacho.origen)} → ${nombreSede(despacho.destino)}`;
  const resumen = conFaltante.length
    ? `${conFaltante.length} de ${items.length} producto(s) van con faltante.`
    : `Los ${items.length} producto(s) se recolectaron completos.`;

  return sendEmail({
    to: DESTINATARIOS.despachos,
    subject: `Despacho cerrado ${ruta}${conFaltante.length ? ` — ${conFaltante.length} con faltante` : ""}`,
    html: armarHtml({
      despacho,
      titulo: "Recolección finalizada",
      intro: `El despachador cerró la recolección. ${resumen}`,
      filas: filasCierre(items),
      encabezados: ["Ítem", "Producto", "Pedido", "Recolectado", "Estado"],
      // El color de la banda dice el estado antes de leer: verde salió completo,
      // ámbar algo quedó faltando.
      acento: conFaltante.length ? MARCA.ambar : MARCA.verde,
    }),
  });
}

/**
 * Notifica los faltantes de una recolección recién cerrada.
 * Best-effort: no lanza; devuelve un resumen de lo enviado.
 * @param {object} despacho - cabecera + `traslados_items` (con `motivo`)
 */
export async function notificarFaltantesRecoleccion(despacho) {
  const items = (despacho?.traslados_items || []).filter((it) => it.motivo);
  if (items.length === 0) return { enviados: 0, inflados: 0, resultados: {} };

  const rutaResumen = `${nombreSede(despacho.origen)} → ${nombreSede(despacho.destino)}`;
  const resultados = {};

  // 1. Compras — TODOS los motivos.
  resultados.compras = await sendEmail({
    to: DESTINATARIOS.compras,
    subject: `Faltantes en despacho ${rutaResumen} (${items.length})`,
    html: armarHtml({
      despacho,
      titulo: "Faltantes reportados en recolección",
      intro: `El despachador cerró la recolección con ${items.length} producto(s) marcados con faltante. Detalle:`,
      filas: filasTabla(items),
      acento: MARCA.ambar,
    }),
  });

  // 2. Inventarios — SOLO 'inventario_inflado'.
  const inflados = items.filter((it) => it.motivo === MOTIVO_INFLADO);
  if (inflados.length > 0) {
    resultados.inventarios = await sendEmail({
      to: DESTINATARIOS.inventarios,
      subject: `Inventario inflado detectado — ${rutaResumen} (${inflados.length})`,
      html: armarHtml({
        despacho,
        titulo: "Posible inventario inflado",
        intro: `Durante la recolección se detectaron ${inflados.length} producto(s) con inventario que no coincide con la existencia física. Revisar:`,
        filas: filasTabla(inflados),
        // Rojo: no es un faltante de surtido, es el inventario del ERP mintiendo.
        acento: MARCA.rojo,
      }),
    });
  }

  return {
    enviados: Object.values(resultados).filter((r) => r?.success).length,
    inflados: inflados.length,
    resultados,
  };
}

/* =============================================
   #2 — Correos del cierre de AUDITORÍA y de ERROR de subida a SIESA.
   Ambos van al líder de inventarios (DESTINATARIOS.inventarios →
   Inventarios@merkahorrosas.com). Best-effort: nunca tumban el flujo.
   ============================================= */

const ENCABEZADOS_COMPARATIVO = ["Ítem", "Producto", "Enviado (UND)", "Contado (UND)", "Diferencia"];

const DECISION_LABEL = {
  aprobado: "Aprobado",
  inconsistencia: "Recibido con inconsistencia",
  rechazado: "Rechazado",
};

/** ¿El ítem salió de origen? Misma regla que despacho.service.noSalioDeOrigen. */
function salioDeOrigen(it) {
  if (it.agotado === true) return false;
  if (it.cantidad_despachador != null && Number(it.cantidad_despachador) === 0) return false;
  return true;
}

/**
 * Filas del comparativo Enviado vs Contado (en UND). Enviado = cantidad_despachador
 * × factor (canonicalización estándar); Contado = cantidad_auditor (ya en UND).
 * Solo ítems que salieron de origen + extras agregados por el auditor.
 */
function filasComparativo(items) {
  return items
    .filter((it) => salioDeOrigen(it) || it.agregado_por_auditor || it.no_recibido)
    .map((it) => {
      const noRecibido = it.no_recibido === true;
      const enviado = (Number(it.cantidad_despachador) || 0) * (Number(it.factor) || 1);
      const contado = noRecibido ? 0 : (Number(it.cantidad_auditor) || 0);
      const dif = contado - enviado;
      const color = noRecibido ? "#b91c1c" : dif === 0 ? "#16a34a" : "#dc2626";
      const extra = [];
      if (it.agregado_por_auditor) extra.push('agregado en el recibo');
      if (noRecibido) extra.push('NO RECIBIDO');
      const extraHtml = extra.length
        ? ` <span style="color:#b91c1c;font-size:11px;font-weight:bold;">(${extra.join(', ')})</span>`
        : "";
      return `
      <tr>
        ${celdaCodigo(it)}
        <td style="padding:6px 10px;border:1px solid #e2e8f0;">${esc(it.descripcion || "—")}${extraHtml}</td>
        <td style="padding:6px 10px;border:1px solid #e2e8f0;text-align:center;">${enviado}</td>
        <td style="padding:6px 10px;border:1px solid #e2e8f0;text-align:center;">${contado}</td>
        <td style="padding:6px 10px;border:1px solid #e2e8f0;text-align:center;color:${color};font-weight:bold;">${dif > 0 ? "+" : ""}${dif}</td>
      </tr>`;
    })
    .join("");
}

/**
 * Correo con la TABLA COMPARATIVA al líder de inventarios, al finalizar la
 * auditoría. El auditor es control documental — este correo es su salida (ya no
 * sube a SIESA, eso lo hizo el despachador). Best-effort.
 * @param {object} despacho - cabecera + traslados_items (con cantidad_auditor ya persistida)
 * @param {"aprobado"|"inconsistencia"|"rechazado"} decision
 */
export async function enviarComparativoAuditoria(despacho, decision) {
  if (!emailConfigurado()) {
    console.error(
      `[traslados] ⚠️ comparativo NO enviado (despacho ${despacho?.id}): falta EMAIL_USER/PASS`,
    );
    return { success: false };
  }
  const ruta = `${nombreSede(despacho.origen)} → ${nombreSede(despacho.destino)}`;
  const decisionTxt = DECISION_LABEL[decision] || decision || "—";
  return sendEmail({
    to: DESTINATARIOS.inventarios,
    subject: `Recibo finalizado — ${ruta} (${decisionTxt})`,
    html: armarHtml({
      despacho,
      titulo: "Comparativo de recibo",
      intro: `Quien recibe finalizó la revisión (decisión: ${decisionTxt}). Comparativo Enviado vs Contado (UND):`,
      filas: filasComparativo(despacho?.traslados_items || []),
      encabezados: ENCABEZADOS_COMPARATIVO,
    }),
  });
}

/**
 * Correo de ERROR cuando la subida a SIESA falla al cerrar la recolección
 * (despachador). Incluye el mensaje legible Y el JSON crudo de la respuesta de
 * SIESA. Best-effort.
 * @param {object} despacho
 * @param {{estado?:string, motivo?:string, siesaData?:any, httpStatus?:number}} resultado
 *   - lo que devolvió enviarRequisicion
 */
export async function enviarErrorSiesa(despacho, resultado) {
  if (!emailConfigurado()) {
    console.error(
      `[traslados] ⚠️ error SIESA NO notificado (despacho ${despacho?.id}): falta EMAIL_USER/PASS`,
    );
    return { success: false };
  }
  const ruta = `${nombreSede(despacho.origen)} → ${nombreSede(despacho.destino)}`;
  const estado = resultado?.estado || "pendiente";
  const detalle = resultado?.motivo || despacho?.siesa_error || "Sin detalle.";
  const fecha = fechaHoraLegible(despacho.updated_at || Date.now());

  // JSON crudo de la respuesta de SIESA. Solo existe cuando el rechazo vino del
  // ERP: un timeout o un fallo de red no tiene cuerpo que mostrar, y en ese caso
  // se omite el bloque en vez de imprimir "undefined".
  let jsonCrudo = "";
  if (resultado?.siesaData !== undefined) {
    let texto;
    try {
      texto = JSON.stringify(resultado.siesaData, null, 2);
    } catch {
      // Referencias circulares: mejor algo legible que perder el bloque entero.
      texto = String(resultado.siesaData);
    }
    // Tope defensivo: un correo con una respuesta gigante puede ser rechazado por
    // el servidor SMTP. El detalle útil de SIESA viene al principio.
    const TOPE = 20000;
    if (texto.length > TOPE) {
      texto = `${texto.slice(0, TOPE)}\n\n… (truncado, ${texto.length} caracteres en total)`;
    }
    const http = resultado?.httpStatus != null ? ` (HTTP ${esc(String(resultado.httpStatus))})` : "";
    jsonCrudo = `
    <p style="margin:12px 0 6px;font-weight:bold;">JSON crudo de SIESA${http}:</p>
    <pre style="background:#0f172a;color:#e2e8f0;padding:12px;border-radius:6px;font-size:12px;white-space:pre-wrap;word-break:break-word;">${esc(texto)}</pre>`;
  }

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;color:#1e293b;max-width:640px;">
    <h2 style="color:#b91c1c;margin-bottom:4px;">Error al subir el traslado a SIESA</h2>
    <p style="margin:0 0 12px;">La requisición del despacho <b>${esc(String(despacho.id))}</b> (${esc(ruta)}) no se pudo subir a SIESA al cerrar la recolección. Quedó <b>${esc(estado)}</b>; el cron la reintenta, pero puede necesitar revisión manual.</p>
    <table style="margin:8px 0 12px;font-size:14px;">
      <tr><td style="padding:2px 8px;color:#64748b;">Despacho</td><td style="padding:2px 8px;"><b>${esc(String(despacho.id))}</b></td></tr>
      <tr><td style="padding:2px 8px;color:#64748b;">Ruta</td><td style="padding:2px 8px;">${esc(ruta)}</td></tr>
      <tr><td style="padding:2px 8px;color:#64748b;">Fecha</td><td style="padding:2px 8px;">${esc(fecha)}</td></tr>
    </table>
    <p style="margin:0 0 6px;font-weight:bold;">Respuesta de SIESA:</p>
    <pre style="background:#0f172a;color:#e2e8f0;padding:12px;border-radius:6px;font-size:12px;white-space:pre-wrap;word-break:break-word;">${esc(detalle)}</pre>${jsonCrudo}
    <p style="margin-top:16px;font-size:12px;color:#94a3b8;">Correo automático del sistema de Traslados — Merkahorro. No responder.</p>
  </div>`;

  return sendEmail({
    to: DESTINATARIOS.inventarios,
    subject: `⚠️ Error al subir a SIESA — ${ruta} (despacho ${String(despacho.id).slice(0, 8)})`,
    html,
  });
}

/* =============================================
   Alertas por inactividad (las dispara el barrido — ver alertas.service.js)
   ============================================= */

/**
 * Correo de traslado estancado. Plantilla propia y sin tabla de ítems, a
 * propósito: el lector no tiene que revisar productos, tiene que ir a destrabar
 * un traslado. Lo único que necesita es CUÁL, CUÁNTO lleva y QUÉ falta hacer.
 *
 * @param {object} p
 * @param {object} p.despacho    - cabecera (id, origen, destino, disponible_at)
 * @param {string} p.titulo
 * @param {string} p.queFalta    - la acción concreta que nadie hizo
 * @param {number} p.horas       - umbral configurado que se superó
 * @param {number} p.horasReales - cuánto lleva realmente esperando
 */
function armarHtmlAlerta({ despacho, titulo, queFalta, horas, horasReales }) {
  const ruta = `${nombreSede(despacho.origen)} → ${nombreSede(despacho.destino)}`;
  const desde = fechaHoraLegible(despacho.disponible_at || despacho.created_at);

  return envolverMarca(`
    ${encabezadoMarca({ titulo: `⏱ ${titulo}`, acento: MARCA.ambar })}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td style="padding:20px 26px 6px;">
          <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:${MARCA.texto};">${esc(queFalta)}</p>

          <!-- El dato que importa, grande: cuánto lleva parado. Es lo que decide
               si esto se atiende ahora o después. -->
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
                 style="background:#fff8ec;border:1px solid ${MARCA.ambar};border-radius:10px;margin-bottom:18px;">
            <tr>
              <td style="padding:14px 18px;">
                <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#9a5b00;">
                  Tiempo sin atender
                </div>
                <div style="margin-top:2px;font-size:26px;font-weight:800;line-height:1.1;color:#9a5b00;">
                  ${esc(horasReales)} h
                </div>
                <div style="margin-top:3px;font-size:12px;color:${MARCA.textoSuave};">
                  El aviso está configurado en ${esc(horas)} h
                </div>
              </td>
            </tr>
          </table>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
                 style="background:${MARCA.fondo};border-radius:10px;">
            <tr><td style="padding:12px 18px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                ${filaDato("Ruta", esc(ruta), true)}
                ${filaDato("Esperando desde", esc(desde))}
                ${filaDato("Traslado", `<span style="font-family:monospace;font-size:11px;">${esc(String(despacho.id))}</span>`)}
              </table>
            </td></tr>
          </table>
        </td>
      </tr>
    </table>
    ${pieMarca("Las horas de este aviso se configuran en el panel de administración, sección Alertas.")}
  `);
}

/**
 * Destinatarios de una alerta: los que cargó el encargado en el panel, o los de
 * despachos si la lista está vacía. El fallback importa — una alerta configurada
 * sin correos que no le llega a nadie es peor que no tener la alerta, porque el
 * panel dice que está activa.
 */
const destinatariosAlerta = (correos) =>
  correos?.length ? correos : DESTINATARIOS.despachos;

/**
 * Nadie inició la recolección. Best-effort: devuelve { success }, no lanza.
 * @param {object} despacho
 * @param {{horas:number, horasReales:number, correos:string[]}} cfg
 */
export async function notificarSinIniciarRecoleccion(despacho, { horas, horasReales, correos }) {
  const ruta = `${nombreSede(despacho.origen)} → ${nombreSede(despacho.destino)}`;
  return sendEmail({
    to: destinatariosAlerta(correos),
    subject: `⏱ Traslado sin recolectar hace ${horasReales} h — ${ruta}`,
    html: armarHtmlAlerta({
      despacho,
      titulo: "Nadie inició la recolección",
      queFalta:
        "El traslado está disponible en el panel del despachador y todavía ningún " +
        "despachador lo tomó. Hay que asignarlo o averiguar por qué quedó parado.",
      horas,
      horasReales,
    }),
  });
}

/**
 * El despachador cerró y nadie empezó a auditar. Best-effort.
 * @param {object} despacho
 * @param {{horas:number, horasReales:number, correos:string[]}} cfg
 */
export async function notificarSinIniciarAuditoria(despacho, { horas, horasReales, correos }) {
  const ruta = `${nombreSede(despacho.origen)} → ${nombreSede(despacho.destino)}`;
  return sendEmail({
    to: destinatariosAlerta(correos),
    subject: `⏱ Traslado sin recibir hace ${horasReales} h — ${ruta}`,
    html: armarHtmlAlerta({
      despacho,
      titulo: "Nadie inició el recibo",
      queFalta:
        "La recolección ya cerró y la mercancía está esperando que en la sede de " +
        "destino la reciban y la cuenten. Nadie abrió todavía este traslado en el panel de recibo.",
      horas,
      horasReales,
    }),
  });
}

/**
 * Dispara TODOS los correos del cierre de recolección y deja en el log qué pasó
 * con cada uno. Nunca lanza: el correo no puede tumbar el flujo de negocio.
 * @param {object} despacho
 */
export async function notificarRecoleccionCerrada(despacho) {
  if (!emailConfigurado()) {
    console.error(
      `[traslados] ⚠️ despacho ${despacho?.id} cerrado SIN notificar: falta configurar EMAIL_USER/EMAIL_PASS`,
    );
    return { cierre: false, faltantes: 0 };
  }

  const [cierre, faltantes] = await Promise.all([
    notificarCierreRecoleccion(despacho).catch((e) => ({ success: false, error: e.message })),
    notificarFaltantesRecoleccion(despacho).catch((e) => {
      console.error("[traslados] correo de faltantes falló:", e.message);
      return { enviados: 0 };
    }),
  ]);

  console.log(
    `[traslados] despacho ${despacho?.id}: cierre=${cierre?.success ? "enviado" : "FALLÓ"}, ` +
      `correos de faltantes=${faltantes?.enviados ?? 0}`,
  );

  return { cierre: Boolean(cierre?.success), faltantes: faltantes?.enviados ?? 0 };
}

/**
 * HTML del correo del manifiesto. Se exporta aparte de `enviarManifiestoCarga`
 * para poder verlo sin mandar un correo de verdad: el envío va a inventarios, así
 * que revisar el maquetado no puede depender de dispararlo.
 *
 * El correo lleva TODOS los campos del manifiesto, no un resumen.
 *
 * El PDF lo genera el navegador del despachador y puede no llegar (una versión
 * vieja del front, un error de jsPDF, un cierre desde un equipo raro). Cuando eso
 * pasa, este correo es el ÚNICO registro que le queda a inventarios de quién se
 * llevó la carga — y con placa y nombre de pila no se rastrea un camión. Así que
 * el cuerpo se sostiene solo: el adjunto es la comodidad, no el contenido.
 *
 * @param {object} despacho    - cabecera + traslados_items
 * @param {object} manifiesto  - fila de traslados_manifiestos
 * @param {boolean} conAdjunto - si el PDF viaja adjunto (cambia el primer párrafo)
 */
export function htmlManifiestoCarga(despacho, manifiesto, conAdjunto) {
  const ruta = `${nombreSede(despacho?.origen)} → ${nombreSede(despacho?.destino)}`;
  const numero = String(manifiesto?.despacho_id || despacho?.id || "").slice(0, 8).toUpperCase();
  const pesoKg = Number(manifiesto?.peso_kg || 0).toLocaleString("es-CO");
  const items = despacho?.traslados_items || [];
  const renglonesCargados = items.filter((it) => Number(it.cantidad_despachador) > 0).length;

  const bloque = (titulo, filas) => `
    <p style="margin:18px 0 6px;font-size:11px;font-weight:700;letter-spacing:0.06em;
              text-transform:uppercase;color:${MARCA.medio};">${esc(titulo)}</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
           style="background:${MARCA.fondo};border-radius:10px;">
      <tr><td style="padding:8px 14px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
          ${filas.join("")}
        </table>
      </td></tr>
    </table>`;

  const dato = (etiqueta, valor, destacado = false) =>
    filaDato(etiqueta, esc(valor || "—"), destacado);

  // `ruta` va sin escapar acá a propósito: `encabezadoMarca` escapa el título por
  // su cuenta, y pasárselo ya escapado lo escapaba dos veces.
  return envolverMarca(`
    ${encabezadoMarca({ titulo: `Manifiesto de carga — ${ruta}` })}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr><td style="padding:20px 26px 8px;">
        <p style="margin:0 0 4px;font-size:14px;color:${MARCA.texto};line-height:1.5;">
          El camión se cargó y el traslado se subió a SIESA.
          ${
            conAdjunto
              ? "El manifiesto va adjunto en PDF; abajo están los mismos datos."
              : `<b style="color:${MARCA.rojo};">El PDF no se pudo adjuntar</b>, así que el detalle completo va en este cuerpo.`
          }
        </p>

        ${bloque("Despacho", [
          dato("Nº de despacho", numero, true),
          dato("Ruta", ruta),
          dato("Fecha de carga", fechaHoraLegible(manifiesto?.created_at || Date.now())),
          dato("Renglones cargados", `${renglonesCargados} de ${items.length}`),
        ])}

        ${bloque("Viaje", [
          dato("Origen", manifiesto?.origen_viaje || nombreSede(despacho.origen)),
          dato("Destino", manifiesto?.destino_viaje || nombreSede(despacho.destino)),
          dato("Ciudad", manifiesto?.ciudad),
          dato("Municipio", manifiesto?.municipio),
          dato("Peso total declarado", `${pesoKg} kg`, true),
          ...(manifiesto?.observaciones ? [dato("Observaciones", manifiesto.observaciones)] : []),
        ])}

        ${bloque("Vehículo", [
          dato("Placa", manifiesto?.placa, true),
          dato("Marca", manifiesto?.marca),
          dato("Clase", manifiesto?.clase),
          dato("Tipo", manifiesto?.tipo),
          dato("Color", manifiesto?.color),
          dato("Carrocería", manifiesto?.carroceria),
        ])}

        ${bloque("Conductor", [
          dato("Nombre", manifiesto?.conductor_nombre, true),
          dato("Cédula", manifiesto?.conductor_documento),
          dato("Licencia", manifiesto?.conductor_licencia),
          dato("Teléfono", manifiesto?.conductor_telefono),
          dato("Ciudad", manifiesto?.conductor_ciudad),
          dato("Dirección", manifiesto?.conductor_direccion),
        ])}

        ${bloque("Despachador (quien entrega)", [
          dato("Nombre", manifiesto?.despachador_nombre, true),
          dato("Cédula", manifiesto?.despachador_documento),
          dato("Teléfono", manifiesto?.despachador_telefono),
        ])}
      </td></tr>
    </table>
    ${pieMarca("Documento interno — no reemplaza al manifiesto electrónico del RNDC.")}
  `);
}

/**
 * Correo con el PDF del MANIFIESTO DE CARGA a inventarios, al cargar el camión.
 *
 * El PDF lo genera el frontend (una sola fuente del layout) y lo manda en base64
 * dentro del request de cierre; acá se adjunta. Best-effort: el despacho YA se
 * cerró y se subió a SIESA cuando esto corre — si el correo o el adjunto fallan,
 * se loguea y no se revierte nada.
 *
 * @param {object} despacho    - cabecera + traslados_items (ruta y conteo de renglones)
 * @param {object} manifiesto  - fila de traslados_manifiestos (camión / conductor / viaje)
 * @param {string} [pdfBase64] - el PDF ya generado, en base64 (sin prefijo data:)
 */
export async function enviarManifiestoCarga(despacho, manifiesto, pdfBase64) {
  if (!emailConfigurado()) {
    console.error(
      `[traslados] ⚠️ manifiesto NO enviado (despacho ${despacho?.id}): falta EMAIL_USER/PASS`,
    );
    return { success: false };
  }

  const ruta = `${nombreSede(despacho?.origen)} → ${nombreSede(despacho?.destino)}`;
  const numero = String(manifiesto?.despacho_id || despacho?.id || "").slice(0, 8).toUpperCase();

  const attachments = pdfBase64
    ? [{ filename: `manifiesto-${numero}.pdf`, content: pdfBase64, encoding: "base64" }]
    : undefined;

  if (!attachments) {
    console.error(
      `[traslados] ⚠️ manifiesto ${despacho?.id}: se manda SIN PDF adjunto (no llegó del cliente)`,
    );
  }

  return sendEmail({
    to: DESTINATARIOS.inventarios,
    subject: `Manifiesto de carga — ${ruta} (despacho ${numero})`,
    html: htmlManifiestoCarga(despacho, manifiesto, Boolean(attachments)),
    attachments,
  });
}
