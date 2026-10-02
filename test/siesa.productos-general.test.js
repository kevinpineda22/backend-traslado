import { test, mock, before } from "node:test";
import assert from "node:assert/strict";

/* =============================================================================
   Panel "Nuevo despacho", flujo General: SOLO productos de la tienda destino.

   El panel recorría la unión CEDI ∪ tienda, y como en General no hay filtro de
   CAT, todo el catálogo del CEDI (PV001) aparecía para cada tienda. Medido el
   28/09/2026: entre el 27% y el 54% de la lista eran productos que la tienda
   nunca manejó.

   Decisión de negocio explícita (opción A): solo lo que la tienda tiene. El costo
   aceptado es que desde este panel ya no se le puede mandar a una tienda un
   producto que nunca tuvo — el test lo deja escrito para que nadie lo "arregle"
   por accidente volviendo a la unión.

   `calcularSugeridoGeneral` se reemplaza para controlar la necesidad desde el
   fixture (`consumo_promedio`): acá importa QUÉ ítems salen, no la cuenta.
   ============================================================================= */

const ORIGEN = "PV001";
const DESTINO = "00601"; // Vegas: la tienda con más ruido medido (53%)

let getProductosTraslado;
let filas = [];

/** Fila del snapshot con lo mínimo que lee getProductosTraslado. */
const fila = (bodega, codigo, { disponible = 10, consumo = 0 } = {}) => ({
  bodega,
  codigo_item: codigo,
  descripcion: `ITEM ${codigo}`,
  um: "UND",
  um_orden: "UND",
  factor: 1,
  volumen: null,
  inventario: disponible,
  disponible,
  consumo_promedio: consumo,
  periodo_cubrimiento: 0,
  rotacion: "",
  criterios: {},
});

before(async () => {
  mock.module("../src/services/snapshot.service.js", {
    exports: {
      leerBodegas: async () => filas,
      leerBodegasItems: async () => [],
    },
  });
  mock.module("../src/models/Capacidad.model.js", {
    exports: { mapaCapacidades: async () => new Map(), factoresDeItem: async () => new Map() },
  });
  mock.module("../src/models/Config.model.js", {
    exports: {
      obtener: async () => ({ llano: { A: 1, B: 3, C: 5 }, general: { periodoCubrimiento: null } }),
    },
  });
  mock.module("../src/config/supabase.js", { exports: { supabase: {} } });
  mock.module("../src/services/sugerido.service.js", {
    exports: {
      calcularSugeridoGeneral: ({ consumoDestino }) => ({
        stockSeguridad: consumoDestino,
        necesidad: consumoDestino,
      }),
      calcularSugeridoABC: () => 0,
    },
  });

  ({ getProductosTraslado } = await import("../src/services/siesa.service.js"));
});

const codigosDe = async () => {
  const { data, error } = await getProductosTraslado({ origen: ORIGEN, destino: DESTINO });
  assert.equal(error, undefined);
  return data.map((p) => p.codigo_item).sort();
};

test("un producto que SOLO tiene el CEDI no aparece para la tienda", async () => {
  filas = [
    fila(ORIGEN, "1"), fila(DESTINO, "1"), // los dos → sale
    fila(ORIGEN, "2"), // solo CEDI → NO sale (costo aceptado de la opción A)
  ];
  assert.deepEqual(await codigosDe(), ["1"]);
});

test("un producto de la tienda en CERO sigue apareciendo", async () => {
  // Agotado en la tienda, con stock en el CEDI: lo primero que hay que mandar.
  filas = [fila(ORIGEN, "3", { disponible: 80 }), fila(DESTINO, "3", { disponible: 0 })];
  assert.deepEqual(await codigosDe(), ["3"]);
});

test("un producto que SOLO tiene la tienda aparece si lo necesita, y no si no", async () => {
  filas = [
    fila(DESTINO, "4", { consumo: 5 }), // necesidad > 0 → sale (se manda desde otra sede)
    fila(DESTINO, "5", { consumo: 0 }), // necesidad 0 y sin CEDI → no sale
  ];
  assert.deepEqual(await codigosDe(), ["4"]);
});

test("el CEDI con catálogo mucho más grande no infla la lista de la tienda", async () => {
  // Proporción real de Vegas: la mitad del CEDI no la maneja la tienda.
  filas = [];
  for (let i = 1; i <= 10; i++) filas.push(fila(ORIGEN, `C${i}`));
  for (let i = 1; i <= 5; i++) filas.push(fila(DESTINO, `C${i}`));
  const codigos = await codigosDe();
  assert.equal(codigos.length, 5);
  assert.ok(codigos.every((c) => ["C1", "C2", "C3", "C4", "C5"].includes(c)));
});

test("si la tienda no tiene filas en el snapshot, avisa en vez de mostrar una lista vacía", async () => {
  // Bodega en flujos.js pero no en el WHERE de Connekta, o sede nueva.
  filas = [fila(ORIGEN, "1"), fila(ORIGEN, "2")];
  const { data, error } = await getProductosTraslado({ origen: ORIGEN, destino: DESTINO });
  assert.equal(data, undefined);
  assert.match(error, /Sin datos de inventario para la bodega 00601/);
});
