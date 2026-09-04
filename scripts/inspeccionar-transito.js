import "dotenv/config";
import { ejecutarConsulta } from "../src/config/connekta.js";
import { despachoIdDeNotas } from "../src/services/siesaTransito.consulta.js";

/* =============================================
   Filas CRUDAS de la consulta de tránsito. Solo LEE.

   `verificar-transito.js` responde "¿está sano el tránsito?" y para eso APAREA
   los documentos con nuestros despachos por el uuid de las notas. Cuando lo que
   falla es el apareo mismo, ese script no sirve para diagnosticar: un documento
   cuyas notas cambiaron desaparece de su salida y el reporte lo da por resuelto.

   Este muestra lo que Connekta devuelve, sin filtrar y sin aparear. Es la
   herramienta para contestar "¿existe todavía el documento X?" — que no es la
   misma pregunta que "¿está apareado?".

   Uso:
     node scripts/inspeccionar-transito.js                    # resumen + los no apareados
     node scripts/inspeccionar-transito.js 1750 1751 1753     # por consecutivo
     node scripts/inspeccionar-transito.js 068c2b8b-faeb-...  # por despacho (las dos caras)
   ============================================= */

const buscados = process.argv.slice(2).map((s) => String(s).trim()).filter(Boolean);

const fmt = (d) => (d ? String(d).slice(0, 10) : "s/f");
const val = (f, k) => String(f?.[k] ?? "").trim();
const esUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

/**
 * Las dos caras de un despacho, tal como están HOY en el ERP.
 *
 * Contesta la pregunta que el verificador contesta de forma agregada — "¿este par
 * está cerrado?"— pero sobre UN despacho y mostrando los documentos. Cuando el
 * reporte agregado y la realidad no coinciden, esto es lo que dirime.
 */
function mostrarDespacho(filas, id) {
  const mias = filas.filter((f) => despachoIdDeNotas(f?.Notas) === id.toLowerCase());
  if (!mias.length) {
    console.log(`❌ despacho ${id} — no tiene NINGÚN documento apareado en la consulta.\n`);
    return;
  }

  const unicos = new Map();
  for (const f of mias) {
    unicos.set(`${val(f, "Tipo")}|${val(f, "CO")}|${val(f, "Nro")}`, f);
  }

  const salidas = [...unicos.values()].filter((f) => val(f, "Tipo").toUpperCase() === "CTS");
  const entradas = [...unicos.values()].filter((f) => val(f, "Tipo").toUpperCase() === "CTE");

  console.log(`despacho ${id}`);
  const linea = (f) => `      ${val(f, "Tipo")} ${val(f, "Nro")} · CO ${val(f, "CO")} · ${fmt(f.Fecha)}`;
  console.log(`   Salidas (${salidas.length}):`);
  salidas.forEach((f) => console.log(linea(f)));
  console.log(`   Entradas (${entradas.length}):`);
  entradas.forEach((f) => console.log(linea(f)));

  // El veredicto en una línea. Sin entrada la mercancía está en tránsito: fuera
  // de la bodega origen y fuera de la destino.
  if (!entradas.length) console.log("   🔴 PAR ABIERTO — la mercancía está en tránsito.\n");
  else if (salidas.length > 1) console.log("   🟠 Cerrado, pero con salidas duplicadas.\n");
  else console.log("   ✅ Par cerrado.\n");
}

async function main() {
  const nombre = String(process.env.SIESA_CONSULTA_TRANSITO || "").trim();
  if (!nombre) {
    console.error("❌ Falta SIESA_CONSULTA_TRANSITO en el .env");
    process.exit(1);
  }

  console.log(`🔎 Consultando "${nombre}"…\n`);

  let res;
  try {
    // Una sola página, igual que el servicio. Paginar sin ORDER BY saltea filas, y
    // un diagnóstico con filas faltantes es peor que no diagnosticar: fue lo que
    // hizo reportar tres pares abiertos que estaban cerrados hacía seis días.
    res = await ejecutarConsulta(nombre, 1, 2000);
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  }

  const filas = res.datos || [];
  console.log(`Filas devueltas: ${filas.length} de ${res.total} · páginas ${res.totalPaginas}\n`);

  if (res.totalPaginas > 1) {
    console.error(
      `❌ La consulta no entró en una página. Lo que sigue está INCOMPLETO y no\n` +
        `   sirve para concluir nada: sin ORDER BY el motor saltea filas entre\n` +
        `   páginas. Achicá la ventana de fechas del SQL.\n`,
    );
    process.exit(1);
  }

  if (buscados.length) {
    for (const termino of buscados) {
      if (esUuid(termino)) {
        mostrarDespacho(filas, termino);
        continue;
      }

      const nro = termino;
      const hits = filas.filter((f) => val(f, "Nro") === nro);
      if (!hits.length) {
        console.log(`❌ ${nro} — NO aparece en la consulta.`);
        console.log(`   Puede estar anulado, borrado, o fuera de la ventana de 60 días.\n`);
        continue;
      }
      for (const f of hits) {
        const id = despachoIdDeNotas(f?.Notas);
        console.log(`✅ ${nro} · ${val(f, "Tipo")} · CO ${val(f, "CO")} · ${fmt(f.Fecha)}`);
        console.log(`   Notas: ${val(f, "Notas") || "(vacías)"}`);
        // El apareo es lo que decide si el sistema lo VE. Un documento que existe
        // pero perdió el uuid de las notas es invisible para todo lo demás.
        console.log(
          id
            ? `   Apareado con el despacho ${id}\n`
            : `   ⚠️ SIN uuid en las notas — el sistema NO puede aparearlo con ningún despacho\n`,
        );
      }
    }
    return;
  }

  // Sin argumentos: el resumen que importa para diagnosticar el apareo.
  const huerfanas = filas.filter((f) => !despachoIdDeNotas(f?.Notas));
  const porTipo = filas.reduce((acc, f) => {
    const t = val(f, "Tipo").toUpperCase() || "?";
    acc[t] = (acc[t] || 0) + 1;
    return acc;
  }, {});

  console.log("Por tipo:", porTipo);
  console.log(`Sin uuid en las notas: ${huerfanas.length} de ${filas.length}\n`);

  if (huerfanas.length) {
    console.log("Documentos que el sistema NO puede aparear (los últimos 25):");
    for (const f of huerfanas.slice(-25)) {
      console.log(
        `   ${val(f, "Tipo")} ${val(f, "Nro")} · CO ${val(f, "CO")} · ${fmt(f.Fecha)} · ` +
          `${val(f, "Notas").slice(0, 70) || "(notas vacías)"}`,
      );
    }
    console.log(
      "\n   Algunos son traslados manuales del equipo de inventarios y está bien.\n" +
        "   Pero si acá aparece un documento NUESTRO, le cambiaron las notas y\n" +
        "   quedó invisible para el sistema.",
    );
  }
}

main().catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
