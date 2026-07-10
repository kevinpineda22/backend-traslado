import { supabase } from "../config/supabase.js";

/* =============================================
   Configuración de reposición (editable desde el admin).

   Guarda en una sola fila (clave = "reposicion") los días que usa el cálculo:
     - llano:   cadencias A/B/C (días de reposición por clase)
     - general: periodoCubrimiento global que PISA el de SIESA (null = usar el
                de cada ítem que trae SIESA)
   ============================================= */

const TABLE = "traslados_config";
const CLAVE = "reposicion";

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
