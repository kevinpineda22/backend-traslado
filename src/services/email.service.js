import nodemailer from "nodemailer";

/* =============================================
   Servicio de correo (SMTP Office365)

   Mismo patrón que backend-inventario/controllers/emailService.js: nodemailer
   sobre el SMTP corporativo. Las credenciales salen del .env (EMAIL_*), las
   mismas de inventarios — copialas al .env de este backend:

     EMAIL_HOST=smtp.office365.com
     EMAIL_PORT=587
     EMAIL_SECURE=false
     EMAIL_USER=<cuenta emisora @merkahorrosas.com>
     EMAIL_PASS=<contraseña de la cuenta>

   Destinatarios (overridables por env, con default a los correos pedidos):
     TRASLADOS_MAIL_COMPRAS      → todos los motivos de faltante
     TRASLADOS_MAIL_INVENTARIOS  → solo el motivo "inventario inflado"
   ============================================= */

const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST || "smtp.office365.com",
  port: Number(process.env.EMAIL_PORT) || 587,
  secure: process.env.EMAIL_SECURE === "true", // false para 587 (STARTTLS)
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
  tls: { ciphers: "TLSv1.2" },
});

export const DESTINATARIOS = {
  compras: (
    process.env.TRASLADOS_MAIL_COMPRAS ||
    "lidercompras@merkahorrosas.com,compras@merkahorrosas.com"
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  inventarios: (
    process.env.TRASLADOS_MAIL_INVENTARIOS || "Inventarios@merkahorrosas.com"
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
};

/**
 * Envía un correo. Devuelve { success } y NUNCA lanza hacia arriba: el correo es
 * un efecto secundario best-effort; una falla de SMTP no debe tumbar el flujo de
 * negocio (recolección / auditoría). Se loguea para diagnóstico.
 *
 * @param {object} mail
 * @param {string|string[]} mail.to
 * @param {string} mail.subject
 * @param {string} mail.html
 */
export async function sendEmail({ to, subject, html }) {
  const destinatarios = Array.isArray(to) ? to : [to];
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.error("[email] EMAIL_USER/EMAIL_PASS no configurados — se omite el envío");
    return { success: false, error: "Configuración de correo incompleta" };
  }
  if (destinatarios.length === 0) {
    return { success: false, error: "Sin destinatarios" };
  }

  try {
    await transporter.sendMail({
      from: `"Traslados Merkahorro" <${process.env.EMAIL_USER}>`,
      to: destinatarios.join(", "),
      subject,
      html,
    });
    console.log(`[email] ✅ enviado a ${destinatarios.join(", ")} — ${subject}`);
    return { success: true };
  } catch (error) {
    console.error(`[email] ❌ error enviando "${subject}":`, error.message);
    return { success: false, error: error.message };
  }
}
