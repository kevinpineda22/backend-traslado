/**
 * Configuración de flujos de traslado.
 *
 * Cada flujo define su bodega de ORIGEN y las bodegas DESTINO habilitadas,
 * más la lógica de cálculo de sugerido que aplica.
 *
 * Para reasignar una sede a otro flujo, mové su código entre `destinos`.
 * Para agregar una sede nueva, sumala en `SEDES` y en el `destinos` del flujo.
 *
 * IMPORTANTE: los códigos deben coincidir con `IdBodega` (f150_id) de SIESA y
 * estar incluidos en el filtro del query registrado en Connekta.
 */

export const SEDES = {
  PV001: "Principal Copacabana",
  "00301": "Girardota Parque",
  "00201": "Villahermosa",
  "00701": "Barbosa",
  "00801": "San Juan",
  "00601": "Vegas",
  "00401": "Girardota Llano",
};

/**
 * Centro de operación (`f350_id_co`) de cada sede — 3 chars, valida en maestro.
 *
 * NO es la bodega: la bodega es de 5 (`PV001`) y viaja en otro campo
 * (`f450_id_bodega_salida`). El C.O. identifica el centro de operación del
 * documento en el ERP.
 *
 * Se escribe como TABLA y no se deriva de la bodega con un slice: `00201 → P02`
 * tienta a programarlo, pero `PV001 → P01` rompe la regla. Un mapeo explícito se
 * lee, se audita y se corrige; una derivación "casi siempre correcta" falla en
 * silencio el día que agregan una sede — y esta requisición entra CONTABILIZADA
 * en SIESA (`f350_ind_estado = 1`), así que un C.O. errado mueve inventario real
 * al lugar equivocado.
 *
 * CONFIRMADOS por el usuario: PV001→P01, 00201→P02, 00301→P03.
 * INFERIDOS del patrón (confirmar antes de producción): 00401, 00601, 00701, 00801.
 * Hoy solo se usan los de las sedes ORIGEN de FLUJOS (PV001 y 00301), ambos
 * confirmados. Override por entorno: SIESA_IMPORTAR_CO_POR_SEDE.
 */
export const CENTROS_OPERACION = {
  PV001: "P01", // confirmado — Copacabana
  "00201": "P02", // confirmado — Villahermosa
  "00301": "P03", // confirmado — Girardota Parque
  "00401": "P04", // inferido — Girardota Llano
  "00601": "P06", // inferido — Vegas
  "00701": "P07", // inferido — Barbosa
  "00801": "P08", // inferido — San Juan
};

/** Centro de operación de una sede (o "" si no está mapeada). */
export function centroOperacionDeSede(codigo) {
  return CENTROS_OPERACION[String(codigo || "").trim()] || "";
}

export const FLUJOS = {
  general: {
    id: "general",
    nombre: "Traslado General",
    origen: "PV001",
    destinos: ["00301", "00201", "00701", "00801", "00601"],
    logica: "stock_seguridad", // consumo × periodoCubrimiento − inventario
  },
  llano: {
    id: "llano",
    nombre: "Traslado Llano",
    origen: "00301",
    destinos: ["00401"],
    logica: "abc", // clasificación A/B/C con capacidad desde Excel
  },
};

/** Todas las bodegas involucradas (origen + destinos) — sirve para filtrar SIESA. */
export function bodegasInvolucradas() {
  const set = new Set();
  for (const f of Object.values(FLUJOS)) {
    set.add(f.origen);
    for (const d of f.destinos) set.add(d);
  }
  return Array.from(set);
}

/** Devuelve el flujo al que pertenece una bodega destino (o null). */
export function getFlujoPorDestino(destino) {
  return (
    Object.values(FLUJOS).find((f) => f.destinos.includes(destino)) || null
  );
}

/** Nombre legible de una sede por su código. */
export function nombreSede(codigo) {
  return SEDES[codigo] || codigo;
}

/** Lista de flujos con sus destinos enriquecidos (código + nombre). */
export function listarFlujos() {
  return Object.values(FLUJOS).map((f) => ({
    id: f.id,
    nombre: f.nombre,
    logica: f.logica,
    origen: { codigo: f.origen, nombre: nombreSede(f.origen) },
    destinos: f.destinos.map((d) => ({ codigo: d, nombre: nombreSede(d) })),
  }));
}
