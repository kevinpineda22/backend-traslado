import { sendEmail, DESTINATARIOS } from "./email.service.js";
import { nombreSede } from "../config/flujos.js";

/* =============================================
   Notificaciones de traslado (correo)

   Regla de negocio (pedida por el usuario):
   - Cualquier ítem con motivo de faltante  → compras (lidercompras + compras).
   - Ítems con motivo 'inventario_inflado'   → ADEMÁS a inventarios (solo esos).

   Se dispara una sola vez, al finalizar la recolección (estado → Recolectado).
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

function armarHtml({ despacho, items, titulo, intro }) {
  const ruta = `${nombreSede(despacho.origen)} → ${nombreSede(despacho.destino)}`;
  const fecha = new Date(despacho.updated_at || Date.now()).toLocaleString("es-CO");

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
        <tr style="background:#2d1578;color:#fff;">
          <th style="padding:8px 10px;text-align:left;">Producto</th>
          <th style="padding:8px 10px;">Pedido</th>
          <th style="padding:8px 10px;">Recolectado</th>
          <th style="padding:8px 10px;text-align:left;">Motivo</th>
        </tr>
      </thead>
      <tbody>${filasTabla(items)}</tbody>
    </table>
    <p style="margin-top:16px;font-size:12px;color:#94a3b8;">
      Correo automático del sistema de Traslados — Merkahorro. No responder.
    </p>
  </div>`;
}

/**
 * Notifica los faltantes de una recolección recién cerrada.
 * Best-effort: no lanza; devuelve un resumen de lo enviado.
 * @param {object} despacho - cabecera + `traslados_items` (con `motivo`)
 */
export async function notificarFaltantesRecoleccion(despacho) {
  const items = (despacho?.traslados_items || []).filter((it) => it.motivo);
  if (items.length === 0) return { enviados: 0 };

  const rutaResumen = `${nombreSede(despacho.origen)} → ${nombreSede(despacho.destino)}`;
  const resultados = {};

  // 1. Compras — TODOS los motivos.
  resultados.compras = await sendEmail({
    to: DESTINATARIOS.compras,
    subject: `Faltantes en despacho ${rutaResumen} (${items.length})`,
    html: armarHtml({
      despacho,
      items,
      titulo: "Faltantes reportados en recolección",
      intro: `El despachador cerró la recolección con ${items.length} producto(s) marcados con faltante. Detalle:`,
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
        items: inflados,
        titulo: "Posible inventario inflado",
        intro: `Durante la recolección se detectaron ${inflados.length} producto(s) con inventario que no coincide con la existencia física. Revisar:`,
      }),
    });
  }

  return {
    enviados: Object.values(resultados).filter((r) => r?.success).length,
    inflados: inflados.length,
    resultados,
  };
}
