import "dotenv/config";
import axios from "axios";

/* =============================================
   ¿Qué consultas puede leer una llave de Connekta?

   Sirve para responder una sola pregunta: la llave del Postman ¿sirve también
   para todo lo que el backend ya lee hoy? Porque si sirve, se cambia la del
   .env y listo; y si no sirve, cambiarla rompería el snapshot y los costos.

   Prueba la llave del .env (CONNI_KEY/CONNI_TOKEN) y, si están puestas,
   también CONNI_KEY_PRUEBA/CONNI_TOKEN_PRUEBA. Las credenciales nunca se
   imprimen: solo los últimos 4 caracteres, para poder distinguirlas.

   Uso:  node scripts/probar-llave.js
   ============================================= */

const BASE_URL = process.env.CONNEKTA_BASE_URL;
const ID_COMPANIA = process.env.CONNEKTA_ID_COMPANIA;

// Las que el backend usa hoy + la de tránsito que queremos habilitar.
const CONSULTAS = [
  process.env.SIESA_CONSULTA_TRANSITO || "merkahorro_transferencia_transito_salida_dev",
  "merkahorro_sedes_dev",
  "merkahorro_costo_promedio_dev",
];

const tapar = (s) => (s ? `…${String(s).slice(-4)}` : "(vacía)");

async function probar(descripcion, key, token) {
  try {
    const { data } = await axios.get(`${BASE_URL}/ejecutarconsulta`, {
      headers: { conniKey: key, conniToken: token },
      params: { idCompania: ID_COMPANIA, descripcion, paginacion: "numPag=1|tamPag=1" },
      timeout: 30_000,
      validateStatus: () => true,
    });
    if (data?.codigo === 0) {
      return `✅ OK      (${data?.detalle?.total_registros ?? "?"} registros)`;
    }
    return `❌ RECHAZA  ${String(data?.detalle || data?.mensaje || "").slice(0, 60)}`;
  } catch (e) {
    return `❌ ERROR    ${e.message.slice(0, 60)}`;
  }
}

async function main() {
  if (!BASE_URL || !ID_COMPANIA) {
    console.error("❌ Faltan CONNEKTA_BASE_URL o CONNEKTA_ID_COMPANIA en el .env");
    process.exit(1);
  }

  const llaves = [
    { nombre: "La del backend (.env)", key: process.env.CONNI_KEY, token: process.env.CONNI_TOKEN },
  ];
  if (process.env.CONNI_KEY_PRUEBA && process.env.CONNI_TOKEN_PRUEBA) {
    llaves.push({
      nombre: "La de prueba (Postman)",
      key: process.env.CONNI_KEY_PRUEBA,
      token: process.env.CONNI_TOKEN_PRUEBA,
    });
  }

  for (const llave of llaves) {
    console.log(`\n🔑 ${llave.nombre} — termina en ${tapar(llave.key)}`);
    console.log("".padEnd(60, "─"));
    for (const c of CONSULTAS) {
      const r = await probar(c, llave.key, llave.token);
      console.log(`   ${c.padEnd(46)} ${r}`);
    }
  }

  if (llaves.length === 1) {
    console.log(
      "\nℹ️  Solo probé la llave del backend. Para comparar con la de Postman,\n" +
        "   agregá CONNI_KEY_PRUEBA y CONNI_TOKEN_PRUEBA al .env y volvé a correr.",
    );
  } else {
    console.log(
      "\n👉 Si la de prueba dice OK en LAS TRES, podés reemplazar CONNI_KEY y\n" +
        "   CONNI_TOKEN del .env por esos valores. Si falla en alguna, NO la\n" +
        "   reemplaces: hay que pedir que autoricen la llave del backend.",
    );
  }
}

main().catch((e) => {
  console.error(`❌ ${e.message}`);
  process.exit(1);
});
