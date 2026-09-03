import "dotenv/config";
import {
  consultarTransito,
  consultaConfigurada,
} from "../src/services/siesaTransito.consulta.js";

/* =============================================
   Verificador del tránsito en SIESA. Solo LEE — no manda nada al ERP.

   Correlo ANTES de prender la entrada automática (`SIESA_SOLO_SALIDA=0`). Te
   dice tres cosas que hay que saber antes de soltar el sistema:

     1. Si la consulta de Connekta está registrada y autorizada para este
        conniKey (un 401 acá significa una de las dos, Connekta no distingue).
     2. Cuántos documentos aparea por el uuid de las notas — si aparea cero,
        el hilo del cruce está roto y NADA de esto va a funcionar.
     3. Qué salidas no tienen entrada. Con alguien creándolas a mano, esa lista
        debería ser corta; si es larga, el sistema tiene trabajo pendiente.

   Uso:  node scripts/verificar-transito.js
   ============================================= */

const fmt = (d) => (d ? String(d).slice(0, 10) : "s/f");

async function main() {
  if (!consultaConfigurada()) {
    console.error(
      "❌ Falta SIESA_CONSULTA_TRANSITO en el .env — es el nombre de la consulta\n" +
        "   registrada en Connekta. Ver docs/CONSULTA_TRANSITO_CONNEKTA.md",
    );
    process.exit(1);
  }

  console.log(`🔎 Consultando "${process.env.SIESA_CONSULTA_TRANSITO}"…\n`);

  let salidas, entradas;
  try {
    ({ salidas, entradas } = await consultarTransito({ refrescar: true }));
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  }

  const docsDe = (m) => [...m.values()].reduce((n, l) => n + l.length, 0);

  console.log(`Salidas (CTS) : ${docsDe(salidas)} documentos · ${salidas.size} despachos`);
  console.log(`Entradas (CTE): ${docsDe(entradas)} documentos · ${entradas.size} despachos\n`);

  // DUPLICADOS PRIMERO: son los que bloquean el cierre del par. Un despacho con
  // dos salidas no se puede cerrar solo — no hay forma de saber cuál referenciar.
  const dupSalidas = [...salidas.entries()].filter(([, l]) => l.length > 1);
  const dupEntradas = [...entradas.entries()].filter(([, l]) => l.length > 1);

  if (dupSalidas.length > 0) {
    console.log(`🔴 ${dupSalidas.length} despacho(s) con SALIDA duplicada en SIESA:\n`);
    for (const [id, l] of dupSalidas) {
      console.log(`   despacho ${id}  ·  CTS ${l.map((d) => d.nro).join(", ")}`);
    }
    console.log(
      "\n   Hay que borrar las sobrantes en SIESA. Mientras estén, esos despachos\n" +
        "   quedan 'pendiente': el sistema no adivina cuál referenciar.\n",
    );
  }

  if (dupEntradas.length > 0) {
    console.log(`🔴 ${dupEntradas.length} despacho(s) con ENTRADA duplicada — el destino recibió de más:\n`);
    for (const [id, l] of dupEntradas) {
      console.log(`   despacho ${id}  ·  CTE ${l.map((d) => d.nro).join(", ")}`);
    }
    console.log("");
  }

  if (salidas.size === 0) {
    console.error(
      "❌ Cero salidas apareadas. O la consulta no devuelve `Notas`, o no hay\n" +
        "   documentos nuestros en la ventana de fechas del SQL. Sin el uuid de las\n" +
        "   notas no hay forma de cruzar un documento de SIESA con un despacho.",
    );
    process.exit(1);
  }

  const sinEntrada = [...salidas.entries()].filter(([id]) => !entradas.has(id));
  const huerfanas = [...entradas.entries()].filter(([id]) => !salidas.has(id));

  if (sinEntrada.length === 0) {
    console.log("✅ Todas las salidas tienen su entrada.");
  } else {
    console.log(`⚠️  ${sinEntrada.length} salida(s) SIN entrada — el par está abierto:\n`);
    for (const [id, docs] of sinEntrada) {
      const d = docs[0];
      console.log(
        `   despacho ${id}  ·  CTS ${docs.map((x) => x.nro).join("/")}  ·  CO ${d.co}  ·  ${fmt(d.fecha)}`,
      );
    }
  }

  if (huerfanas.length > 0) {
    console.log(
      `\n⚠️  ${huerfanas.length} entrada(s) sin su salida en la ventana consultada.\n` +
        "   Suele ser una salida más vieja que el rango del SQL, no un error.",
    );
  }

  console.log(
    "\nSi la lista de salidas sin entrada está vacía o es corta, podés prender\n" +
      "la entrada automática (SIESA_SOLO_SALIDA=0) — el guard anti-duplicado\n" +
      "adopta las que ya existan en vez de crear una segunda.",
  );
}

main().catch((e) => {
  console.error(`❌ ${e.message}`);
  process.exit(1);
});
