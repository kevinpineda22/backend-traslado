import "dotenv/config";
import { supabase } from "../src/config/supabase.js";
import { buscarSalida, buscarEntrada, consultaConfigurada } from "../src/services/siesaTransito.consulta.js";

/* =============================================================================
   Rellena `siesa_docto` / `siesa_salida_docto` leyéndolos del ERP.

   POR QUÉ EXISTE. Arreglar cómo NACE un dato no arregla los que ya se guardaron.
   El 09/09/2026 se corrigió que el consecutivo de la entrada se busque en SIESA
   cuando el conector no lo devuelve — pero los despachos anteriores siguen con
   la columna en null, y esos no los toca nadie nunca más: 'enviado' es terminal.
   Medido ese día: 9 despachos del 05 al 09/09 con el par CERRADO en SIESA y
   `siesa_docto` en null en los 9.

   No es un problema de inventario. Los documentos existen y están apareados. Es
   que la base no puede decir qué CTE cerró qué despacho, y esa pregunta aparece
   el día que haya que auditar un traslado — o sea, el peor día para tener que ir
   a buscarla a mano.

   SOLO ESCRIBE DONDE HAY NULL. Un consecutivo ya guardado no se pisa: si la base
   y el ERP no coinciden, eso es un hallazgo para mirar, no algo para sobrescribir
   en silencio. Esos casos se listan aparte como DISCREPANCIA.

   Uso:
     node scripts/backfill-docto-transito.js            → simulacro (no escribe)
     node scripts/backfill-docto-transito.js --aplicar  → escribe
   ============================================================================= */

const APLICAR = process.argv.includes("--aplicar");

if (!consultaConfigurada()) {
  console.error("Falta SIESA_CONSULTA_TRANSITO: sin la consulta no hay de dónde leer.");
  process.exit(1);
}

const { data, error } = await supabase
  .from("traslados_despachos")
  .select("id, origen, destino, siesa_estado, siesa_docto, siesa_salida_docto, siesa_enviado_at")
  .eq("siesa_estado", "enviado")
  .or("siesa_docto.is.null,siesa_salida_docto.is.null")
  .order("siesa_enviado_at", { ascending: true });

if (error) {
  console.error("No se pudieron listar los despachos:", error.message);
  process.exit(1);
}

console.log(
  `${APLICAR ? "APLICANDO" : "SIMULACRO (no escribe)"} · ${data.length} despachos enviados con algún consecutivo faltante\n`,
);

let escritos = 0;
let sinDatos = 0;
const discrepancias = [];

for (const d of data) {
  let salida = null;
  let entrada = null;
  try {
    salida = await buscarSalida(d.id);
    entrada = await buscarEntrada(d.id);
  } catch (e) {
    console.error(`  ${d.id}  ERROR al leer el ERP: ${e.message}`);
    break; // el cache queda frío igual; no tiene sentido insistir
  }

  const patch = {};
  if (!d.siesa_docto && entrada?.nro) patch.siesa_docto = String(entrada.nro);
  if (!d.siesa_salida_docto && salida?.nro) patch.siesa_salida_docto = String(salida.nro);

  // Lo que YA estaba guardado y no coincide con el ERP: se reporta, no se pisa.
  if (d.siesa_docto && entrada?.nro && String(d.siesa_docto) !== String(entrada.nro)) {
    discrepancias.push(`${d.id} entrada: base=${d.siesa_docto} ERP=${entrada.nro}`);
  }
  if (d.siesa_salida_docto && salida?.nro && String(d.siesa_salida_docto) !== String(salida.nro)) {
    discrepancias.push(`${d.id} salida: base=${d.siesa_salida_docto} ERP=${salida.nro}`);
  }

  const ruta = `${d.origen}->${d.destino}`.padEnd(14);
  if (!Object.keys(patch).length) {
    sinDatos += 1;
    console.log(`  ${d.id}  ${ruta} sin datos en el ERP (salida=${salida?.nro ?? "-"} entrada=${entrada?.nro ?? "-"})`);
    continue;
  }

  const detalle = Object.entries(patch).map(([k, v]) => `${k}=${v}`).join(" ");
  console.log(`  ${d.id}  ${ruta} ${detalle}`);

  if (APLICAR) {
    const { error: errUpd } = await supabase.from("traslados_despachos").update(patch).eq("id", d.id);
    if (errUpd) console.error(`     ✖ no se pudo escribir: ${errUpd.message}`);
    else escritos += 1;
  }
}

console.log(
  `\n${APLICAR ? `escritos: ${escritos}` : "simulacro: no se escribió nada"} · sin datos en el ERP: ${sinDatos}`,
);
if (discrepancias.length) {
  console.log("\n⚠️ DISCREPANCIAS (guardado ≠ ERP, NO se tocaron):");
  for (const l of discrepancias) console.log(`   ${l}`);
}
if (!APLICAR) console.log("\nPara escribir: node scripts/backfill-docto-transito.js --aplicar");
