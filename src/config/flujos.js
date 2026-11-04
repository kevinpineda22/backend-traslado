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
  "01201": "Machado",
};

/**
 * Centro de operación (`f350_id_co`) de cada sede — 3 chars, valida en maestro.
 *
 * NO es la bodega: la bodega es de 5 (`PV001`) y viaja en otro campo
 * (`f450_id_bodega_salida`). El C.O. identifica el centro de operación del
 * documento en el ERP.
 *
 * Se escribe como TABLA y no se deriva de la bodega con un slice: la bodega es
 * de 5 chars (`00201`) y el C.O. de 3 (`002`) — no hay una regla que los una sin
 * excepciones (`PV001 → 001` la rompe). Un mapeo explícito se lee, se audita y se
 * corrige; una derivación "casi siempre correcta" falla en silencio el día que
 * agregan una sede — y esta requisición entra CONTABILIZADA en SIESA
 * (`f350_ind_estado = 1`), así que un C.O. errado mueve inventario real al lugar
 * equivocado.
 *
 * CONFIRMADOS por el usuario contra los C.O. de SIESA (001=plaza, 002=villa,
 * 003=girardota, 004=llano, 006=vegas, 007=barbosa, 008=sanJuan, 012=machado).
 * Override por entorno: SIESA_IMPORTAR_CO_POR_SEDE.
 */
export const CENTROS_OPERACION = {
  PV001: "001", // plaza — Principal Copacabana
  "00201": "002", // villa — Villahermosa
  "00301": "003", // girardota — Girardota Parque
  "00401": "004", // llano — Girardota Llano
  "00601": "006", // vegas — Vegas
  "00701": "007", // barbosa — Barbosa
  "00801": "008", // sanJuan — San Juan
  "01201": "012", // machado — Machado (Copacabana)
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
    logica: "abc", // capacidad desde Excel; sugerido por clase A/B/C
    // Qué ítems muestra el flujo (ver `pasaPortafolio` en siesa.service.js):
    //   plan:  criterio del snapshot que define el portafolio ("CAT", "CAM"…). Un ítem
    //          sin valor en ese criterio NO se muestra.
    //   valor: (opcional) el valor EXACTO que debe tener (se compara sin tildes ni
    //          mayúsculas). Sin `valor`, cualquier valor no vacío sirve.
    //   excluir: (opcional) valores que sacan al ítem del portafolio.
    //   requiereCapacidad: (opcional) si es true, solo se muestran ítems con capacidad > 0.
    //   requiereOrigen: (opcional) si es true, solo ítems que existen en la bodega origen.
    //   exigirPlanEnSnapshot: (opcional) si es true y el snapshot no trae el plan en
    //          NINGUNA fila, el flujo responde un error explícito en vez de una lista vacía.
    // Llano: cualquier ítem con CAT, salvo los DESCODIFICADOS (que se dejan de manejar).
    portafolio: { plan: "CAT", excluir: ["DESCODIFICADOS"] },
    // Cómo se clasifica el ítem para el sugerido: `{ plan }` = la clase A/B/C sale de ese
    // criterio ("CATEGORIA TIPO A" → A) y el sugerido usa las cadencias del flujo;
    // `null` = sin clasificación (sugerido = capacidad − inventario).
    clasificacion: { plan: "CAT" },
  },
  // Machado: misma pantalla y flujo que Llano (capacidad por Excel, auto-clasificación
  // de pendientes, "enviar por partes"), pero con SU portafolio y SIN clasificación A/B/C
  // todavía. Su capacidad vive en `traslados_capacidad` bajo destino "01201" (migración
  // 042).
  //
  // El plan CAT ("CLASIFICACIÓN ABC LLANO") es EXCLUSIVO de Llano: Machado nunca lo lee.
  // Su portafolio es el plan CAM ("PORTAFOLIO MACHADO"), con valor "PORTAFOLIO ACTIVO
  // MACHADO"; un ítem sin CAM activo no se muestra aunque tenga capacidad cargada.
  //
  // Para agregarle A/B/C más adelante (sobre OTRO plan de SIESA): poner
  // `clasificacion: { plan: "<plan>" }` y la clase se lee de ahí; las cadencias ya
  // existen en la config (clave `machado`).
  machado: {
    id: "machado",
    nombre: "Traslado Machado",
    origen: "PV001",
    destinos: ["01201"],
    logica: "abc",
    portafolio: {
      plan: "CAM",
      valor: "PORTAFOLIO ACTIVO MACHADO",
      requiereCapacidad: true,
      requiereOrigen: true,
      exigirPlanEnSnapshot: true,
    },
    clasificacion: null,
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

/**
 * ¿El flujo usa la lógica A/B/C (capacidad por Excel, auto-clasificación, envío por
 * partes)? Se pregunta por la LÓGICA y no por el nombre "llano" a propósito: Machado
 * se comporta igual y el próximo flujo A/B/C también. Comparar contra un id fijo
 * obligaba a tocar cada servicio por cada sede nueva, y el que se olvidara quedaba
 * con el comportamiento de General sin ningún error que avisara.
 */
export function esFlujoAbc(flujoId) {
  return FLUJOS[flujoId]?.logica === "abc";
}

/** ¿La bodega destino pertenece a un flujo A/B/C? */
export function esDestinoAbc(destino) {
  return getFlujoPorDestino(String(destino ?? "").trim())?.logica === "abc";
}

/** Bodegas destino de todos los flujos A/B/C (las que tienen capacidad propia). */
export function destinosAbc() {
  return Object.values(FLUJOS)
    .filter((f) => f.logica === "abc")
    .flatMap((f) => f.destinos);
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
    // El front decide con esto si el flujo muestra clase A/B/C.
    clasifica: Boolean(f.clasificacion),
    origen: { codigo: f.origen, nombre: nombreSede(f.origen) },
    destinos: f.destinos.map((d) => ({ codigo: d, nombre: nombreSede(d) })),
  }));
}
