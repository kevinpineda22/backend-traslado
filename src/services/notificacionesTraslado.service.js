import { sendEmail, DESTINATARIOS, emailConfigurado } from "./email.service.js";
import { nombreSede } from "../config/flujos.js";

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

const MOTIVO_LABEL = {
  sin_stock: "Sin stock",
  surtido_parcial: "Surtido parcial en PV",
  inventario_inflado: "Inventario inflado",
};

const MOTIVO_INFLADO = "inventario_inflado";

const esc = (v) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const num = (v) => (v == null ? "—" : Number(v));

function filasTabla(items) {
  return items
    .map(
      (it) => `
      <tr>
        <td style="padding:6px 10px;border:1px solid #e2e8f0;">${esc(it.descripcion || it.codigo_item)}</td>
        <td style="padding:6px 10px;border:1px solid #e2e8f0;text-align:center;">${num(it.cantidad_admin)}</td>
        <td style="padding:6px 10px;border:1px solid #e2e8f0;text-align:center;">${num(it.cantidad_despachador)}</td>
        <td style="padding:6px 10px;border:1px solid #e2e8f0;">${esc(MOTIVO_LABEL[it.motivo] || it.motivo)}</td>
      </tr>`,
    )
    .join("");
}

const ENCABEZADOS_FALTANTES = ["Producto", "Pedido", "Recolectado", "Motivo"];

/**
 * Arma el HTML del correo. `filas` y `encabezados` se pasan desde afuera porque
 * el correo de cierre y el de faltantes muestran columnas distintas.
 */
function armarHtml({ despacho, titulo, intro, filas, encabezados = ENCABEZADOS_FALTANTES }) {
  const ruta = `${nombreSede(despacho.origen)} → ${nombreSede(despacho.destino)}`;
  const fecha = new Date(despacho.updated_at || Date.now()).toLocaleString("es-CO");
  const ths = encabezados
    .map(
      (h, i) =>
        `<th style="padding:8px 10px;text-align:${i === 0 || i === encabezados.length - 1 ? "left" : "center"};">${esc(h)}</th>`,
    )
    .join("");

  return `
  <div style="font-family:Arial,Helvetica,sans-serif;color:#1e293b;max-width:640px;">
    <h2 style="color:#2d1578;margin-bottom:4px;">${esc(titulo)}</h2>
    <p style="margin:0 0 12px;">${esc(intro)}</p>
    <table style="margin:8px 0 16px;font-size:14px;">
      <tr><td style="padding:2px 8px;color:#64748b;">Despacho</td><td style="padding:2px 8px;"><b>${esc(String(despacho.id))}</b></td></tr>
      <tr><td style="padding:2px 8px;color:#64748b;">Ruta</td><td style="padding:2px 8px;">${esc(ruta)}</td></tr>
      <tr><td style="padding:2px 8px;color:#64748b;">Fecha</td><td style="padding:2px 8px;">${esc(fecha)}</td></tr>
    </table>
    <table style="border-collapse:collapse;width:100%;font-size:13px;">
      <thead>
        <tr style="background:#2d1578;color:#fff;">${ths}</tr>
      </thead>
      <tbody>${filas}</tbody>
    </table>
    <p style="margin-top:16px;font-size:12px;color:#94a3b8;">
      Correo automático del sistema de Traslados — Merkahorro. No responder.
    </p>
  </div>`;
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
        <td style="padding:6px 10px;border:1px solid #e2e8f0;">${esc(it.descripcion || it.codigo_item)}</td>
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
      encabezados: ["Producto", "Pedido", "Recolectado", "Estado"],
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
      }),
    });
  }

  return {
    enviados: Object.values(resultados).filter((r) => r?.success).length,
    inflados: inflados.length,
    resultados,
  };
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
