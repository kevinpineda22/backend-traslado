/* =============================================
   Identidad visual de los correos de Traslados

   POR QUÉ UN MÓDULO APARTE
   Cada plantilla se armaba con sus propios colores sueltos. Con un solo lugar,
   cambiar la marca es cambiar acá — y ninguna plantilla nueva nace con un violeta
   distinto porque alguien copió el hex de memoria.

   POR QUÉ TODO VA EN `style=` Y NO EN UNA HOJA DE ESTILOS
   Los clientes de correo (Outlook, Gmail) descartan los <style> y no entienden
   variables CSS. En correo, el estilo inline no es descuido: es la única forma
   que sobrevive. Por eso la paleta vive como constantes de JS que se interpolan.

   POR QUÉ TABLAS Y NO FLEX/GRID
   Outlook usa el motor de renderizado de Word. Flexbox y grid no existen ahí; una
   tabla sí. El encabezado se arma con tabla a propósito.
   ============================================= */

/** Paleta corporativa — espejo de `sf-corporate-tokens.css` del frontend. */
export const MARCA = {
  profundo: "#1a0a4e", // --sfc-dark
  medio: "#2d1578", // --sfc-medium
  claro: "#4f35a1", // --sfc-light
  verde: "#30d158", // --sfc-accent-green
  ambar: "#ff9f0a", // --sfc-accent-orange
  rojo: "#ff453a", // --sfc-accent-red
  fondo: "#f5f5f7", // --sfc-bg
  texto: "#1d1d1f", // --sfc-text-dark
  textoSuave: "#86868b", // --sfc-text-secondary
  borde: "#e2e8f0",
  blanco: "#ffffff",
};

/** Pila de fuentes segura para correo (Plus Jakarta Sans no existe en Outlook). */
export const FUENTE =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

const esc = (v) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * URL del logo. Sale del entorno porque un correo no puede referenciar un archivo
 * local: la imagen tiene que estar en una URL pública que el cliente de correo
 * pueda bajar.
 *
 * Si no está configurada, el encabezado cae al nombre en texto. Un logo roto
 * (el cuadradito con la cruz) se ve peor que no tener logo.
 */
const logoUrl = () => String(process.env.TRASLADOS_MAIL_LOGO_URL || "").trim();

/**
 * Encabezado de marca: banda violeta con el logo (o el nombre) y el título.
 *
 * @param {object} p
 * @param {string} p.titulo   - de qué se trata el correo
 * @param {string} [p.acento] - color de la línea inferior; distingue el tipo de
 *   aviso de un vistazo (ámbar = algo está trabado, verde = todo bien).
 */
export function encabezadoMarca({ titulo, acento = MARCA.verde }) {
  const url = logoUrl();
  const marca = url
    ? `<img src="${esc(url)}" alt="Merkahorro" height="34"
           style="display:block;border:0;outline:none;text-decoration:none;height:34px;width:auto;">`
    : `<span style="font-size:19px;font-weight:800;color:${MARCA.blanco};letter-spacing:-0.02em;">
         Merkahorro
       </span>`;

  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
         style="background:${MARCA.profundo};background-image:linear-gradient(135deg, ${MARCA.profundo} 0%, ${MARCA.medio} 60%, ${MARCA.claro} 100%);border-radius:14px 14px 0 0;">
    <tr>
      <td style="padding:22px 26px 18px;">
        ${marca}
        <div style="margin-top:12px;font-size:17px;font-weight:700;color:${MARCA.blanco};line-height:1.35;">
          ${esc(titulo)}
        </div>
        <div style="margin-top:14px;height:3px;width:52px;background:${acento};border-radius:3px;"></div>
      </td>
    </tr>
  </table>`;
}

/** Pie del correo. `extra` agrega una línea de contexto (dónde se configura esto). */
export function pieMarca(extra = "") {
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr>
      <td style="padding:16px 26px 20px;border-top:1px solid ${MARCA.borde};">
        <p style="margin:0;font-size:11px;line-height:1.6;color:${MARCA.textoSuave};">
          Correo automático del sistema de <b style="color:${MARCA.medio};">Traslados — Merkahorro</b>. No responder.
          ${extra ? `<br>${esc(extra)}` : ""}
        </p>
      </td>
    </tr>
  </table>`;
}

/**
 * Envuelve el contenido en el lienzo del correo: fondo gris, tarjeta blanca
 * centrada y ancho tope de 640px. El `max-width` sin un ancho fijo hace que en
 * móvil se adapte y en escritorio no se estire a lo ancho de la pantalla.
 */
export function envolverMarca(contenido) {
  return `
  <div style="margin:0;padding:24px 12px;background:${MARCA.fondo};font-family:${FUENTE};">
    <table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0"
           style="max-width:640px;width:100%;margin:0 auto;background:${MARCA.blanco};border-radius:14px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.06);">
      <tr><td style="padding:0;">${contenido}</td></tr>
    </table>
  </div>`;
}

/** Fila de dato (etiqueta a la izquierda, valor a la derecha) para los bloques de resumen. */
export function filaDato(etiqueta, valor, destacado = false) {
  return `
  <tr>
    <td style="padding:5px 0;font-size:12px;color:${MARCA.textoSuave};white-space:nowrap;">${esc(etiqueta)}</td>
    <td style="padding:5px 0 5px 16px;font-size:13px;color:${MARCA.texto};${destacado ? "font-weight:700;" : ""}">${valor}</td>
  </tr>`;
}
