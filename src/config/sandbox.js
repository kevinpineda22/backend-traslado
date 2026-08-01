import fs from "node:fs";
import path from "node:path";

/* =============================================
   MODO SANDBOX — probar el flujo completo sin tocar el mundo real.

   `TRASLADOS_SANDBOX=true` corta las TRES salidas del sistema hacia afuera:

     1. Correo      → no se envía nada. El HTML se escribe en disco.
     2. Requisición → no se importa a SIESA. Se simula un docto.
     3. Ajuste      → no se importa a SIESA. Se simula un docto.

   Lo que SÍ sigue pasando: todo lo demás. Estados, firmas, manifiestos,
   auditoría, comparativas y el Excel se escriben en Supabase como siempre. Es a
   propósito — probar el flujo sin persistirlo no prueba nada; lo que no se puede
   deshacer es un correo a compras o un traslado contabilizado en el ERP.

   POR QUÉ UN SOLO INTERRUPTOR Y NO TRES
   Con tres, alguien prende dos y el tercero manda igual. La pregunta que se hace
   quien va a probar es una sola —"¿esto sale de mi máquina?"— y merece una sola
   respuesta.

   POR QUÉ NO ALCANZA `TRASLADOS_MAIL_MODO_PRUEBA`
   Ese desvía el correo a inventarios: sigue siendo un correo de verdad, a una
   persona de verdad. Sirve para revisar el maquetado en una bandeja real, no
   para probar sin avisarle a nadie.

   DÓNDE MIRAR LO QUE "SE MANDÓ": los correos quedan en `cache-data/sandbox/`
   como archivos .html que se abren en el navegador, con el asunto y los
   destinatarios reales adentro.
   ============================================= */

/** ¿Está prendido el sandbox? */
export function sandboxActivo() {
  return String(process.env.TRASLADOS_SANDBOX || "").toLowerCase() === "true";
}

/**
 * GUARDA DE PRODUCCIÓN.
 *
 * Un sandbox prendido en producción es peor que no tener sandbox: el sistema se
 * ve funcionando —los despachos cierran, los estados avanzan— y en silencio deja
 * de avisarle a compras y de mover inventario en el ERP. Nadie lo nota hasta que
 * falta mercancía. Así que en `NODE_ENV=production` se ignora y se grita.
 */
function permitido() {
  if (process.env.NODE_ENV !== "production") return true;
  console.error(
    "[sandbox] ⛔ TRASLADOS_SANDBOX está prendido en PRODUCCIÓN. Se IGNORA: " +
      "los correos y SIESA salen normal. Sacá la variable del entorno.",
  );
  return false;
}

/** El sandbox está activo Y permitido en este entorno. */
export function sandboxOn() {
  return sandboxActivo() && permitido();
}

const DIR = path.resolve(process.cwd(), "cache-data", "sandbox");

/**
 * Escribe en disco un correo que NO se envió, para poder abrirlo.
 *
 * Best-effort: en un serverless con FS de solo lectura esto falla, y el sandbox
 * no puede caerse por no poder guardar un archivo — el objetivo es no mandar el
 * correo, y eso ya se cumplió antes de llegar acá.
 *
 * @returns {string|null} ruta del archivo, o null si no se pudo escribir
 */
export function volcarCorreo({ to, subject, html, attachments }) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const sello = new Date().toISOString().replace(/[:.]/g, "-");
    const limpio = String(subject || "correo")
      .replace(/[^\w\sáéíóúñÁÉÍÓÚÑ-]/g, "")
      .trim()
      .replace(/\s+/g, "_")
      .slice(0, 60);
    const archivo = path.join(DIR, `${sello}__${limpio}.html`);

    const adjuntos = (attachments || []).map((a) => a.filename).join(", ") || "ninguno";
    // La cabecera va DENTRO del HTML: el archivo tiene que poder leerse solo,
    // sin volver al log a ver a quién le hubiera llegado.
    const cabecera = `
      <div style="font-family:monospace;background:#fffbeb;border:2px solid #f59e0b;
                  padding:12px 16px;margin:0 0 16px;">
        <b>CORREO NO ENVIADO — MODO SANDBOX</b><br>
        <b>Para:</b> ${(Array.isArray(to) ? to : [to]).join(", ")}<br>
        <b>Asunto:</b> ${subject}<br>
        <b>Adjuntos:</b> ${adjuntos}
      </div>`;

    fs.writeFileSync(archivo, cabecera + (html || ""), "utf8");
    return archivo;
  } catch (err) {
    console.warn("[sandbox] no se pudo volcar el correo a disco:", err.message);
    return null;
  }
}
