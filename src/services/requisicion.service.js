import { supabase } from "../config/supabase.js";
import * as DespachoModel from "../models/Despacho.model.js";
import { FLUJOS } from "../config/flujos.js";
import { tomarLock, liberarLock } from "./lock.service.js";
import {
  importarRequisicion,
  ConfigSiesaError,
  configFaltante,
} from "./siesaRequisicion.service.js";

/* =============================================
   Orquestación del envío de requisiciones a SIESA

   El único trabajo de este módulo es que una requisición se envíe UNA VEZ.
   Dos envíos = dos requisiciones = movimientos de inventario que nunca pasaron,
   y eso no lo arregla nadie desde la app: hay que ir a pedirle a SIESA que los
   borre. Por eso todo acá está construido alrededor de no duplicar.

   Tres defensas, porque una sola no alcanza:
     1. `siesa_estado = 'enviado'` es terminal. Jamás se reenvía.
     2. Un lock por despacho (tabla compartida) impide que el cron de reintentos
        y el cierre del despachador manden a la vez desde instancias distintas.
     3. La transición a 'enviando' es condicional (`.neq("siesa_estado","enviado")`):
        si otro ya lo marcó, la carrera se pierde en la BD, no en memoria.

   El TOPE de intentos existe por la misma razón: si SIESA acepta pero se corta
   la respuesta, reintentar duplicaría. Preferimos parar y avisar antes que
   insistir a ciegas.
   ============================================= */

const TABLE = "traslados_despachos";
const MAX_INTENTOS = Number(process.env.SIESA_REQUISICION_MAX_INTENTOS) || 5;
const LOCK_TTL_S = 120;

const lockDe = (despachoId) => `siesa:requisicion:${despachoId}`;

/** Marca el estado del envío en la cabecera del despacho. */
async function marcar(despachoId, patch) {
  const { error } = await supabase.from(TABLE).update(patch).eq("id", despachoId);
  if (error) console.error(`[requisicion] no se pudo marcar ${despachoId}:`, error.message);
}

/**
 * Envía la requisición de UN despacho a SIESA, si corresponde.
 * Nunca lanza: devuelve qué pasó. El despacho ya está cerrado; esto es un efecto
 * posterior y no puede tumbar nada.
 *
 * @param {object|string} despachoOId - el despacho (con items) o su id
 * @returns {Promise<{estado:'enviado'|'pendiente'|'fallido'|'omitido', motivo?:string}>}
 */
export async function enviarRequisicion(despachoOId) {
  const id = typeof despachoOId === "string" ? despachoOId : despachoOId?.id;
  if (!id) return { estado: "omitido", motivo: "sin id" };

  // Defensa 2: un solo enviador a la vez para este despacho, entre instancias.
  const lock = lockDe(id);
  if (!(await tomarLock(lock, LOCK_TTL_S, "envio-requisicion"))) {
    return { estado: "omitido", motivo: "otro envío en curso" };
  }

  try {
    // Releemos SIEMPRE de la BD: quien nos llamó pudo traer un objeto viejo, y
    // "ya se envió" es justo el dato que no podemos permitirnos leer desactualizado.
    const despacho = await DespachoModel.findById(id);
    if (!despacho) return { estado: "omitido", motivo: "no existe" };

    // Defensa 1: 'enviado' es terminal.
    if (despacho.siesa_estado === "enviado") {
      return { estado: "omitido", motivo: "ya enviado" };
    }

    // El chequeo de config va DESPUÉS de leer el despacho (el centro de
    // operación depende del origen) y ANTES de contar el intento: una variable
    // de entorno que falta no es SIESA fallando, y reintentar no la va a crear.
    // Si consumiera intentos, un fin de semana de cron dejaría todo en 'fallido'
    // por algo que se arregla cargando una variable.
    const faltan = configFaltante(despacho.origen);
    if (faltan.length) {
      await marcar(id, {
        siesa_estado: "pendiente",
        siesa_error: `Configuración incompleta: falta ${faltan.join(", ")}`,
      });
      console.error(`[requisicion] ⚠️ despacho ${id} sin enviar — falta ${faltan.join(", ")}`);
      return { estado: "pendiente", motivo: "config" };
    }

    const intentos = Number(despacho.siesa_intentos) || 0;
    if (intentos >= MAX_INTENTOS) {
      await marcar(id, { siesa_estado: "fallido" });
      return { estado: "fallido", motivo: "máximo de intentos alcanzado" };
    }

    // Defensa 3: la carrera se resuelve en la BD. Si otra instancia ya lo marcó
    // como enviado entre nuestro read y este update, no pisamos nada.
    const { data: reservado, error: errReserva } = await supabase
      .from(TABLE)
      .update({ siesa_intentos: intentos + 1 })
      .eq("id", id)
      .neq("siesa_estado", "enviado")
      .select("id")
      .maybeSingle();

    if (errReserva) throw new Error(`No se pudo reservar el envío: ${errReserva.message}`);
    if (!reservado) return { estado: "omitido", motivo: "ya enviado (carrera)" };

    try {
      const r = await importarRequisicion(despacho);

      if (r.vacio) {
        // Despacho sin nada recolectado: no hay requisición que crear.
        await marcar(id, {
          siesa_estado: "enviado",
          siesa_error: null,
          siesa_enviado_at: new Date().toISOString(),
          siesa_docto: null,
        });
        return { estado: "enviado", motivo: "sin ítems recolectados" };
      }

      await marcar(id, {
        siesa_estado: "enviado",
        siesa_error: null,
        siesa_docto: r.docto || null,
        siesa_enviado_at: new Date().toISOString(),
        siesa_payload: r.payload || null,
      });
      console.log(`[requisicion] ✅ despacho ${id} importado a SIESA (docto ${r.docto || "s/n"})`);
      return { estado: "enviado" };
    } catch (err) {
      const esConfig = err instanceof ConfigSiesaError;
      const agotado = intentos + 1 >= MAX_INTENTOS;
      // Config incompleta no consume el cupo de reintentos: no es SIESA fallando.
      const estado = esConfig ? "pendiente" : agotado ? "fallido" : "pendiente";

      await marcar(id, {
        siesa_estado: estado,
        siesa_error: String(err.message).slice(0, 1000),
      });
      console.error(
        `[requisicion] ❌ despacho ${id} intento ${intentos + 1}/${MAX_INTENTOS}: ${err.message}`,
      );
      return { estado, motivo: err.message };
    }
  } finally {
    await liberarLock(lock);
  }
}

/**
 * Reintenta las requisiciones que quedaron pendientes. Lo llama el cron.
 * Solo toca 'pendiente': 'fallido' agotó sus intentos y necesita que alguien
 * mire qué pasó — insistir solo sería ruido.
 *
 * @param {number} limite - cuántas procesar por corrida
 */
export async function reintentarPendientes(limite = 20) {
  const { data, error } = await supabase
    .from(TABLE)
    .select("id")
    .eq("siesa_estado", "pendiente")
    .lt("siesa_intentos", MAX_INTENTOS)
    .order("updated_at", { ascending: true })
    .limit(limite);

  if (error) throw new Error(`Error al listar requisiciones pendientes: ${error.message}`);
  if (!data?.length) return { procesados: 0, enviados: 0, resultados: [] };

  // En SERIE, no en paralelo: SIESA ya nos tiró deadlocks por concurrencia con
  // el snapshot, y acá cada request ESCRIBE. No hay ningún apuro que justifique
  // el riesgo — son 20 documentos, no 77 páginas.
  const resultados = [];
  for (const { id } of data) {
    resultados.push({ id, ...(await enviarRequisicion(id)) });
  }

  const enviados = resultados.filter((r) => r.estado === "enviado").length;
  console.log(`[requisicion] reintento: ${enviados}/${resultados.length} enviados`);
  return { procesados: resultados.length, enviados, resultados };
}

/**
 * Resumen para el panel/monitor: cuántas hay en cada estado y si la config está
 * completa para CADA sede origen. Reportar solo el global escondería el caso
 * real: el C.O. cargado para una sede y faltando para otra.
 */
export async function estadoRequisiciones() {
  const { data, error } = await supabase
    .from(TABLE)
    .select("id, origen, destino, siesa_estado, siesa_intentos, siesa_error, siesa_docto")
    .not("siesa_estado", "is", null);

  if (error) throw new Error(`Error al leer estado de requisiciones: ${error.message}`);

  const conteo = { pendiente: 0, enviado: 0, fallido: 0 };
  for (const r of data || []) {
    if (conteo[r.siesa_estado] != null) conteo[r.siesa_estado] += 1;
  }

  // El PORQUÉ de cada una que no llegó. Sin esto hay que ir a bucear a los logs
  // de Vercel para enterarse de algo que el sistema ya sabe — y una cola que
  // cuesta mirar es una cola que nadie mira.
  const problemas = (data || [])
    .filter((r) => r.siesa_estado !== "enviado")
    .map((r) => ({
      id: r.id,
      ruta: `${r.origen} → ${r.destino}`,
      estado: r.siesa_estado,
      intentos: r.siesa_intentos,
      error: r.siesa_error,
    }));

  const origenes = [...new Set(Object.values(FLUJOS).map((f) => f.origen))];
  const config = {};
  for (const sede of origenes) {
    const faltan = configFaltante(sede);
    config[sede] = faltan.length ? { listo: false, falta: faltan } : { listo: true };
  }

  return { ...conteo, config, listoParaEnviar: origenes.every((s) => config[s].listo) };
}
