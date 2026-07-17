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
     TRASLADOS_MAIL_DESPACHOS    → cierre de recolección (SIEMPRE, haya o no
                                    faltantes). Default: la lista de compras.
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

const lista = (valor, porDefecto) =>
  String(valor || porDefecto)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const COMPRAS_DEFAULT = "lidercompras@merkahorrosas.com,compras@merkahorrosas.com";

export const DESTINATARIOS = {
  compras: lista(process.env.TRASLADOS_MAIL_COMPRAS, COMPRAS_DEFAULT),
  inventarios: lista(process.env.TRASLADOS_MAIL_INVENTARIOS, "Inventarios@merkahorrosas.com"),
  // Cierre de despacho. Sin env propia cae en la lista de compras, que es quien
  // hoy recibe todo lo de traslados.
  despachos: lista(
    process.env.TRASLADOS_MAIL_DESPACHOS,
    process.env.TRASLADOS_MAIL_COMPRAS || COMPRAS_DEFAULT,
  ),
};

/**
 * ¿Está el correo configurado? Si no, todo envío se omite silenciosamente y el
 * sistema parece "no mandar correos" sin ninguna pista. Lo exponemos para poder
 * avisarlo fuerte y temprano en vez de descubrirlo semanas después.
 */
export function emailConfigurado() {
  return Boolean(process.env.EMAIL_USER && process.env.EMAIL_PASS);
}

/**
 * MODO PRUEBA — `TRASLADOS_MAIL_MODO_PRUEBA=true`.
 *
 * Redirige TODO el correo a la lista de inventarios: compras no recibe nada.
 * Sirve para probar el flujo sin llenarle la bandeja a nadie.
 *
 * Es un interruptor peligroso: si queda prendido, compras deja de enterarse de
 * los faltantes y NADIE lo nota — el sistema sigue diciendo "correo enviado".
 * Es exactamente la clase de falla silenciosa que nos costó semanas encontrar en
 * este proyecto. Por eso grita en tres lados: prefijo [PRUEBA] en el asunto, un
 * warning en cada envío, y el campo `modo_prueba` en GET /api/health/email.
 */
export function modoPrueba() {
  return String(process.env.TRASLADOS_MAIL_MODO_PRUEBA || "").toLowerCase() === "true";
}

/**
 * Diagnóstico: se conecta al SMTP y AUTENTICA, sin enviar nada.
 *
 * "Las variables están cargadas" y "el correo funciona" son cosas distintas, y
 * confundirlas cuesta semanas: la cuenta puede tener la contraseña vencida, o
 * el tenant puede tener SMTP AUTH deshabilitado (Office365 lo apaga por default
 * hace años). Sin esto, la única forma de enterarse es cerrar un despacho real
 * y ver si llega el correo — o sea, enterarse tarde.
 *
 * @returns {Promise<{ok:boolean, configurado:boolean, error?:string, remitente?:string, destinatarios?:object}>}
 */
export async function verificarEmail() {
  const prueba = modoPrueba();
  const base = {
    configurado: emailConfigurado(),
    remitente: process.env.EMAIL_USER || null,
    host: process.env.EMAIL_HOST || "smtp.office365.com",
    puerto: Number(process.env.EMAIL_PORT) || 587,
    destinatarios: DESTINATARIOS,
    modo_prueba: prueba,
    // Cuando el desvío está activo lo decimos con todas las letras. Un modo de
    // prueba que no se ve es un modo de prueba que se queda prendido.
    ...(prueba && {
      aviso:
        "⚠️ MODO PRUEBA ACTIVO — TODO el correo se desvía a inventarios; compras NO recibe nada. " +
        "Apagá TRASLADOS_MAIL_MODO_PRUEBA para volver a producción.",
      desvio_a: DESTINATARIOS.inventarios,
    }),
  };

  if (!base.configurado) {
    return {
      ...base,
      ok: false,
      error: "Faltan EMAIL_USER y/o EMAIL_PASS en el entorno",
    };
  }

  try {
    await transporter.verify();
    return { ...base, ok: true };
  } catch (error) {
    return { ...base, ok: false, error: error.message };
  }
}

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
  let destinatarios = (Array.isArray(to) ? to : [to]).filter(Boolean);

  // El desvío va acá, en el ÚNICO punto por el que sale todo correo. Si viviera
  // en cada notificación, la próxima que alguien agregue se escaparía a compras.
  if (modoPrueba()) {
    const reales = destinatarios.join(", ");
    destinatarios = DESTINATARIOS.inventarios;
    subject = `[PRUEBA] ${subject}`;
    console.warn(
      `[email] 🧪 MODO PRUEBA — "${subject}" se desvía a ${destinatarios.join(", ")} ` +
        `(destinatarios reales: ${reales}). Apagá TRASLADOS_MAIL_MODO_PRUEBA para producción.`,
    );
  }

  if (!emailConfigurado()) {
    console.error(
      `[email] ❌ EMAIL_USER/EMAIL_PASS no configurados — NO se envió "${subject}". ` +
        "Cargá las variables EMAIL_* en el entorno (Vercel → Settings → Environment Variables).",
    );
    return { success: false, error: "Configuración de correo incompleta" };
  }
  if (destinatarios.length === 0) {
    console.error(`[email] ❌ sin destinatarios — NO se envió "${subject}"`);
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
