import { supabase } from "../config/supabase.js";

/* =============================================
   Configuración editable desde el admin.

   `traslados_config` es una tabla clave/valor con JSONB. Dos claves hoy:

   - "reposicion" → los días que usa el cálculo del sugerido:
       · llano:   cadencias A/B/C (días de reposición por clase)
       · general: periodoCubrimiento global que PISA el de SIESA (null = usar el
                  de cada ítem que trae SIESA)

   - "alertas"    → las reglas de inactividad (ver ALERTAS_DEFAULT abajo).
   ============================================= */

const TABLE = "traslados_config";
const CLAVE = "reposicion";
const CLAVE_ALERTAS = "alertas";

// Defaults si nunca se guardó nada (coinciden con CADENCIAS_DEFAULT del cálculo).
const DEFAULTS = {
  llano: { A: 1, B: 3, C: 5 },
  general: { periodoCubrimiento: null },
};

const numPos = (v, def) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : def;
};

/** Devuelve la config actual, completando con defaults lo que falte. */
export async function obtener() {
  const { data, error } = await supabase
    .from(TABLE)
    .select("valor")
    .eq("clave", CLAVE)
    .maybeSingle();
  if (error) throw new Error(`Error al leer config: ${error.message}`);

  const v = data?.valor || {};
  return {
    llano: {
      A: numPos(v?.llano?.A, DEFAULTS.llano.A),
      B: numPos(v?.llano?.B, DEFAULTS.llano.B),
      C: numPos(v?.llano?.C, DEFAULTS.llano.C),
    },
    general: {
      periodoCubrimiento:
        v?.general?.periodoCubrimiento == null
          ? null
          : numPos(v.general.periodoCubrimiento, null),
    },
  };
}

/** Upsert de la config (valor completo y saneado). */
export async function guardar(entrada) {
  const config = {
    llano: {
      A: numPos(entrada?.llano?.A, DEFAULTS.llano.A),
      B: numPos(entrada?.llano?.B, DEFAULTS.llano.B),
      C: numPos(entrada?.llano?.C, DEFAULTS.llano.C),
    },
    general: {
      periodoCubrimiento:
        entrada?.general?.periodoCubrimiento == null ||
        entrada?.general?.periodoCubrimiento === ""
          ? null
          : numPos(entrada.general.periodoCubrimiento, null),
    },
  };

  const { error } = await supabase
    .from(TABLE)
    .upsert(
      { clave: CLAVE, valor: config, updated_at: new Date().toISOString() },
      { onConflict: "clave" },
    );
  if (error) throw new Error(`Error al guardar config: ${error.message}`);
  return config;
}

/* =============================================
   Alertas por inactividad
   ============================================= */

/**
 * Defaults de las alertas. Las tres arrancan APAGADAS: prenderlas manda correos
 * e inactiva traslados, así que es una decisión del encargado, no un efecto de
 * desplegar código. `correos: []` = usar los destinatarios por defecto del
 * backend (DESTINATARIOS.despachos).
 */
export const ALERTAS_DEFAULT = {
  recoleccion: { activa: false, horas: 5, correos: [] },
  auditoria: { activa: false, horas: 5, correos: [] },
  inactivar: { activa: false, horas: 8 },
};

const bool = (v, def) => (typeof v === "boolean" ? v : def);

/**
 * Horas de una alerta. Debe ser > 0: un umbral de 0 horas dispararía la alerta
 * en el mismo barrido en que el traslado se creó, o inactivaría todo al instante.
 * Un valor inválido cae al default en vez de propagarse al barrido.
 */
const horas = (v, def) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : def;
};

/**
 * Sanea la lista de correos. Filtra lo que no tenga forma de dirección: un correo
 * mal escrito hace fallar el envío ENTERO del lote en SMTP, así que se descarta
 * acá y no cuando ya es tarde.
 */
const correos = (v) => {
  if (!Array.isArray(v)) return [];
  const limpios = v
    .map((c) => String(c ?? "").trim().toLowerCase())
    .filter((c) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c));
  return [...new Set(limpios)];
};

/** Normaliza una config de alertas cruda (de la BD o del request) al shape canónico. */
function sanearAlertas(v) {
  return {
    recoleccion: {
      activa: bool(v?.recoleccion?.activa, ALERTAS_DEFAULT.recoleccion.activa),
      horas: horas(v?.recoleccion?.horas, ALERTAS_DEFAULT.recoleccion.horas),
      correos: correos(v?.recoleccion?.correos),
    },
    auditoria: {
      activa: bool(v?.auditoria?.activa, ALERTAS_DEFAULT.auditoria.activa),
      horas: horas(v?.auditoria?.horas, ALERTAS_DEFAULT.auditoria.horas),
      correos: correos(v?.auditoria?.correos),
    },
    inactivar: {
      activa: bool(v?.inactivar?.activa, ALERTAS_DEFAULT.inactivar.activa),
      horas: horas(v?.inactivar?.horas, ALERTAS_DEFAULT.inactivar.horas),
    },
  };
}

/** Config de alertas vigente, completada con defaults. */
export async function obtenerAlertas() {
  const { data, error } = await supabase
    .from(TABLE)
    .select("valor")
    .eq("clave", CLAVE_ALERTAS)
    .maybeSingle();
  if (error) throw new Error(`Error al leer config de alertas: ${error.message}`);

  return sanearAlertas(data?.valor || {});
}

/** Upsert de la config de alertas (saneada). */
export async function guardarAlertas(entrada) {
  const config = sanearAlertas(entrada);

  const { error } = await supabase
    .from(TABLE)
    .upsert(
      { clave: CLAVE_ALERTAS, valor: config, updated_at: new Date().toISOString() },
      { onConflict: "clave" },
    );
  if (error) throw new Error(`Error al guardar config de alertas: ${error.message}`);
  return config;
}
