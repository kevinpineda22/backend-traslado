import "dotenv/config";
import { supabase } from "../src/config/supabase.js";
import { buscarSalida, buscarEntrada, existeSalida, consultaConfigurada } from "../src/services/siesaTransito.consulta.js";

/* =============================================================================
   Cómo le fue a los traslados de un día, cruzado contra el ERP.

   POR QUÉ EXISTE. El 09/09/2026 se cambiaron dos comportamientos que solo se
   pueden observar sobre traslados REALES, porque dependen de cuánto tarda SIESA
   y eso no lo simula ningún test:

     1. La ENTRADA ya no sale pegada a la salida: espera unos minutos
        (SIESA_ENTRADA_ESPERA_MS) y la manda el cron en la pasada siguiente.
     2. Un envío sin respuesta ('incierto') ya no queda parado: el barrido le
        pregunta al ERP y lo destraba solo cuando la respuesta es inequívoca.

   No se puede probar escribiendo en SIESA a propósito: el sistema IMPORTA
   documentos pero no puede borrarlos (Connekta solo lee), así que un documento
   de prueba es un movimiento de inventario real que después hay que ir a anular
   a mano. Se observa lo que pasa solo.

   QUÉ MIRAR, en orden:
     · ESPERA        → tiene que aparecer una fase `espera-entrada` en el log.
                       Si no aparece, el deploy no llevó el cambio.
     · BRECHA        → minutos entre que SIESA acepta la salida y cierra el par.
                       Con la espera en 5 min, esperá entre 5 y 15 (el cron corre
                       cada 10). Si sigue en segundos, la espera no está activa.
     · INTENTOS      → tiene que quedar en 1. Si subió, la espera está gastando
                       cupo de reintentos, que es justo lo que no debe pasar.
     · PAR EN SIESA  → salida y entrada, las dos. Es la única verdad.

   Uso:  node scripts/revisar-dia.js            → hoy
         node scripts/revisar-dia.js 2026-09-10 → un día puntual
   ============================================================================= */

const dia = process.argv[2] || new Date().toISOString().slice(0, 10);
const desde = `${dia}T00:00:00`;
const hasta = `${dia}T23:59:59`;

const { data, error } = await supabase
  .from("traslados_despachos")
  .select("id, origen, destino, estado, siesa_estado, siesa_intentos, siesa_docto, siesa_salida_docto, siesa_salida_at, siesa_enviado_at, siesa_error, siesa_intentos_log, updated_at")
  // Se filtra por `siesa_enviado_at`, NO por `updated_at`. Cualquier escritura
  // sobre la fila mueve `updated_at`: el backfill del 09/09 tocó 43 despachos y
  // los metió a todos en el reporte de ese día. Lo que se quiere son los que se
  // SUBIERON ese día. Los que quedaron sin subir se listan aparte, abajo.
  .gte("siesa_enviado_at", desde)
  .lte("siesa_enviado_at", hasta)
  .order("siesa_enviado_at", { ascending: true });

if (error) {
  console.error("No se pudieron leer los despachos:", error.message);
  process.exit(1);
}

console.log(`\n=== Traslados del ${dia} · ${data.length} con envío a SIESA ===\n`);

const min = (a, b) => {
  const x = Date.parse(a);
  const y = Date.parse(b);
  return Number.isNaN(x) || Number.isNaN(y) ? null : Math.round((y - x) / 60000);
};

let conEspera = 0;
let cerrados = 0;

for (const d of data) {
  const log = Array.isArray(d.siesa_intentos_log) ? d.siesa_intentos_log : [];
  const fases = log.map((e) => `${e.fase}:${e.estado}`).join(" | ") || "(sin log)";
  const espero = log.some((e) => e.fase === "espera-entrada");
  const barrido = log.some((e) => e.fase === "auto-incierto");
  const brecha = min(d.siesa_salida_at, d.siesa_enviado_at);

  if (espero) conEspera += 1;

  console.log(`${d.id}  ${d.origen} -> ${d.destino}`);
  console.log(`   estado=${d.siesa_estado}  intentos=${d.siesa_intentos}  CTS=${d.siesa_salida_docto ?? "-"}  CTE=${d.siesa_docto ?? "-"}`);
  console.log(`   brecha salida→cierre: ${brecha === null ? "?" : `${brecha} min`}${espero ? "   ✅ pasó por la ESPERA" : "   ⚠️ SIN espera (¿deploy viejo?)"}`);
  if (barrido) console.log("   🔎 lo tocó el BARRIDO de inciertos");
  console.log(`   log: ${fases}`);
  if (d.siesa_error) console.log(`   nota: ${d.siesa_error}`);

  // La base puede decir "enviado" y el ERP no tener el par. La verdad es el ERP.
  //
  // OJO CON LA PREGUNTA QUE SE HACE. Para saber si el par está CERRADO hace
  // falta EXISTENCIA, no identidad: `buscarSalida` devuelve null cuando hay
  // varias salidas del mismo despacho (se niega a elegir, y con razón). Usarla
  // acá haría que los despachos con las salidas duplicadas de agosto —los más
  // rotos, los que más miradas necesitan— salieran informados como "par
  // abierto", que es exactamente lo contrario de lo que pasa.
  if (consultaConfigurada()) {
    try {
      const hay = await existeSalida(d.id);
      const s = await buscarSalida(d.id);
      const e = await buscarEntrada(d.id);
      const ok = hay && Boolean(e);
      if (ok) cerrados += 1;
      const salidaTxt = s?.nro ?? (hay ? "VARIAS (duplicadas)" : "-");
      console.log(`   ERP: salida=${salidaTxt}  entrada=${e?.nro ?? "-"}  ${ok ? "✅ par cerrado" : "❌ PAR ABIERTO"}`);
    } catch (err) {
      console.log(`   ERP: no se pudo consultar (${err.message})`);
    }
  }
  console.log("");
}

console.log(`resumen: ${data.length} subidos · ${conEspera} pasaron por la espera · ${cerrados} con el par cerrado en el ERP`);
if (data.length && !conEspera) {
  console.log("\n⚠️ NINGUNO pasó por la espera. O el deploy no llevó el cambio, o SIESA_ENTRADA_ESPERA_MS quedó en 0.");
}

// LO QUE TODAVÍA NO CERRÓ, sin importar de qué día sea. Un traslado abierto no
// deja de importar porque haya cambiado la fecha, y es lo que un reporte "del
// día" se pierde justamente cuando más falta hace mirarlo.
const { data: abiertos } = await supabase
  .from("traslados_despachos")
  .select("id, origen, destino, siesa_estado, siesa_intentos, siesa_error, updated_at")
  .in("siesa_estado", ["pendiente", "incierto", "fallido"])
  .order("updated_at", { ascending: false });

console.log(`\n=== Sin cerrar, de cualquier fecha: ${abiertos?.length ?? 0} ===`);
for (const d of abiertos || []) {
  console.log(
    `  ${String(d.siesa_estado).padEnd(10)} ${d.id}  ${d.origen}->${d.destino}` +
      `  intentos=${d.siesa_intentos}  ${String(d.updated_at).slice(0, 16)}`,
  );
  if (d.siesa_error) console.log(`     ${String(d.siesa_error).slice(0, 160)}`);
}
