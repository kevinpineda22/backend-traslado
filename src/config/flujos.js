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
  PV004: "Llano",
};

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
    destinos: ["PV004"],
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
