import { z } from "zod";

// Ítem tal como lo manda el admin al crear un despacho o al engordar un borrador.
const itemAdminSchema = z.object({
  codigo_item: z.string().min(1),
  descripcion: z.string().optional(),
  unidad_medida: z.string().optional(),
  factor: z.number().optional(),
  rotacion: z.string().optional(),
  grupo: z.string().nullable().optional(),
  categoria: z.string().nullable().optional(),
  stock_origen: z.number().optional(),
  stock_destino: z.number().optional(),
  consumo_destino: z.number().optional(),
  stock_seguridad: z.number().optional(),
  sugerido: z.number().optional(),
  // Peso de una unidad base en gramos, para el total del manifiesto (017). Viaja
  // como `volumen` porque así lo devuelve `/siesa/productos`, pero el dato es
  // peso. `null` = SIESA no lo tiene.
  volumen: z.number().nullable().optional(),
  cantidad: z.number().positive("cantidad debe ser mayor a 0"),
});

// Esquema para crear un despacho
const crearDespachoSchema = z.object({
  flujo: z.string().optional(),
  origen: z.string().optional(),
  destino: z.string().min(1, "destino es requerido"),
  despachador_id: z.string().optional(), // opcional: sin asignar = pool
  admin_id: z.string().optional(),
  criterios: z.array(z.string()).optional(),
  // "Borrador" = lista en construcción (flujo General); ausente o "Creado" = el
  // despacho nace listo para el despachador, como siempre.
  estado: z.enum(["Borrador", "Creado"]).optional(),
  items: z.array(itemAdminSchema).min(1, "Debe incluir al menos un item"),
});


// Esquema para cambio de estado
const cambiarEstadoSchema = z.object({
  estado: z.enum([
    "En_recoleccion",
    // Contado, esperando el camión. Todavía NO se subió nada a SIESA (017).
    "Pendiente_carga",
    "Recolectado",
    "En_recepcion",
    "Auditado",
    "Rechazado",
    "Recibido_con_inconsistencia",
  ]),
  firma_data: z.string().optional(),
  despachador_id: z.string().optional(), // se reclama al iniciar (pool)
});

// Ítems que cuenta el auditor (reutilizado por comparar y confirmar)
const itemsAuditorSchema = z
  .array(
    z.object({
      id: z.string().uuid(),
      cantidad_auditor: z.number().min(0, "cantidad_auditor no puede ser negativa"),
    }),
  )
  .min(1);

// Auditoría — Paso 1: comparar (solo cuentas, sin firma)
const compararSchema = z.object({
  items: itemsAuditorSchema,
});

// Ítem existente que cuenta el auditor.
const itemAuditorExistenteSchema = z.object({
  id: z.string().uuid(),
  cantidad_auditor: z.number().min(0, "cantidad_auditor no puede ser negativa"),
});

// Ítem NUEVO agregado por el auditor (no venía en la lista original). Sin `id`.
const itemAuditorNuevoSchema = z.object({
  nuevo: z.literal(true),
  codigo_item: z.string().min(1, "codigo_item es requerido"),
  descripcion: z.string().optional(),
  unidad_medida: z.string().optional(),
  cantidad_auditor: z.number().min(0, "cantidad_auditor no puede ser negativa"),
});

// Auditoría — Paso 2: confirmar (decisión + firma). Acepta existentes y nuevos.
const confirmarSchema = z.object({
  decision: z.enum(["aprobado", "inconsistencia", "rechazado"]),
  auditor_id: z.string().optional(),
  firma_data: z.string().min(1, "firma_data es requerida"),
  items: z
    .array(z.union([itemAuditorExistenteSchema, itemAuditorNuevoSchema]))
    .min(1),
});

// Esquema para recolección
// El tope superior (cantidad <= cantidad_admin) se valida en el modelo, contra
// el valor guardado en la base — Zod no lo conoce en tiempo de request.
const recolectarSchema = z.object({
  // Dueño que escribe la recolección — el controller lo valida contra el despacho
  // (candado de propiedad). Opcional para no romper clientes viejos; el front lo manda.
  despachador_id: z.string().optional(),
  items: z
    .array(
      z.object({
        id: z.string().uuid(),
        cantidad: z.number().min(0, "cantidad no puede ser negativa"),
        agotado: z.boolean().optional(),
        motivo: z
          .enum(["sin_stock", "surtido_parcial", "inventario_inflado"])
          .nullable()
          .optional(),
        nueva_unidad_medida: z.string().optional(),
        nueva_cantidad_admin: z.number().optional(),
        nuevo_factor: z.number().optional(),
      }),
    )
    .min(1),
});

// Descripción opcional: "" o ausente → undefined (el modelo no toca la existente)
const descripcionOpcional = z.preprocess(
  (v) => (v == null || String(v).trim() === "" ? undefined : String(v).trim()),
  z.string().optional(),
);

// Capacidad Llano — carga masiva desde Excel (item + capacidad + descripción opcional)
const capacidadBulkSchema = z.object({
  items: z
    .array(
      z.object({
        item: z.preprocess((v) => String(v ?? "").trim(), z.string().min(1)),
        capacidad: z.preprocess((v) => Number(v) || 0, z.number().nonnegative()),
        descripcion: descripcionOpcional,
      }),
    )
    .min(1, "El Excel no tiene ítems válidos"),
});

// Capacidad Llano — edición o alta manual de un ítem
const capacidadUnoSchema = z.object({
  capacidad: z.preprocess((v) => Number(v) || 0, z.number().nonnegative()),
  descripcion: descripcionOpcional,
  // UM opcional del ítem: "" limpia, valor asigna. undefined → no se toca.
  unidad: z.preprocess(
    (v) => (v === undefined ? undefined : String(v ?? "").trim()),
    z.string().optional(),
  ),
  factor: z.preprocess(
    (v) => (v === undefined || v === null || v === "" ? undefined : Number(v)),
    z.number().positive().optional(),
  ),
});

// Config de reposición — días editables (cadencias Llano + cubrimiento General)
const diaPos = z.preprocess((v) => Number(v), z.number().positive("debe ser mayor a 0"));
const configSchema = z.object({
  llano: z.object({
    A: diaPos,
    B: diaPos,
    C: diaPos,
  }),
  general: z.object({
    // null / "" → usar el PeriodoCubrimiento de SIESA por ítem
    periodoCubrimiento: z.preprocess(
      (v) => (v == null || v === "" ? null : Number(v)),
      z.number().positive().nullable(),
    ),
  }),
});

// Config de alertas por inactividad.
// Las horas se exigen > 0: un umbral de 0 dispararía la alerta en el mismo barrido
// en que el traslado se creó, o inactivaría todo el pool de una pasada.
const horasAlerta = z.preprocess(
  (v) => Number(v),
  z.number().positive("las horas deben ser mayores a 0"),
);

// Los correos se validan acá Y se sanean en el modelo. La doble puerta es a
// propósito: acá el admin recibe un mensaje que dice qué corregir; el modelo
// protege al barrido de cualquier basura que ya esté guardada en la BD.
const correosAlerta = z
  .array(z.string().email("correo inválido"))
  .optional()
  .default([]);

const alertaCorreoSchema = z.object({
  activa: z.boolean(),
  horas: horasAlerta,
  correos: correosAlerta,
});

const alertasConfigSchema = z.object({
  recoleccion: alertaCorreoSchema,
  auditoria: alertaCorreoSchema,
  inactivar: z.object({
    activa: z.boolean(),
    horas: horasAlerta,
  }),
});

/**
 * Middleware factory: valida req.body contra un esquema Zod.
 */
function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        ok: false,
        error: "Error de validación",
        detalles: result.error.issues.map((i) => ({
          campo: i.path.join("."),
          mensaje: i.message,
        })),
      });
    }
    req.body = result.data; // datos limpios y tipados
    next();
  };
}

/**
 * CAMIÓN CARGADO — cierre de la recolección con el manifiesto.
 *
 * El vehículo y el conductor se aceptan de DOS formas: por `*_id` (elegidos del
 * maestro) o a mano (camión de refuerzo, conductor de paso). Zod no puede decidir
 * cuál corresponde sin conocer el maestro, así que acá todo va opcional y la regla
 * "elegí uno o escribilo" la valida `Manifiesto.model` — que sí puede consultar.
 *
 * Lo único que se exige acá es `peso_kg`: es el dato que no sale de ninguna tabla
 * y sin el cual el manifiesto no sirve.
 */
const cargarCamionSchema = z.object({
  despachador_id: z.string().optional(),
  firma_data: z.string().optional(),
  // Firma del conductor (base64 PNG). Se guarda junto a la del despachador en
  // traslados_firmas (rol 'conductor') para que la reimpresión del manifiesto
  // pueda re-estamparla. DEBE declararse acá: el schema descarta lo no declarado.
  firma_conductor: z.string().optional(),
  // PDF del manifiesto (base64) que el front genera para adjuntar al correo de
  // inventarios. Opcional: si no llega, el correo sale sin adjunto.
  manifiesto_pdf_base64: z.string().optional(),

  vehiculo_id: z.string().uuid().nullable().optional(),
  placa: z.string().optional(),
  marca: z.string().optional(),
  clase: z.string().optional(),
  tipo: z.string().optional(),
  color: z.string().optional(),
  carroceria: z.string().optional(),

  despachador_ref_id: z.string().uuid().nullable().optional(),
  despachador_nombre: z.string().optional(),
  despachador_documento: z.string().optional(),
  despachador_telefono: z.string().optional(),

  conductor_id: z.string().uuid().nullable().optional(),
  conductor_nombre: z.string().optional(),
  conductor_documento: z.string().optional(),
  conductor_direccion: z.string().optional(),
  conductor_telefono: z.string().optional(),
  conductor_licencia: z.string().optional(),
  conductor_ciudad: z.string().optional(),

  origen_viaje: z.string().optional(),
  destino_viaje: z.string().optional(),
  ciudad: z.string().optional(),
  municipio: z.string().optional(),

  peso_kg: z.coerce.number().positive("El peso total debe ser mayor a 0"),
  observaciones: z.string().optional(),
});

/** Alta/edición de los tres maestros del manifiesto. */
const vehiculoSchema = z.object({
  placa: z.string().min(1, "La placa es obligatoria"),
  marca: z.string().optional(),
  clase: z.string().optional(),
  tipo: z.string().optional(),
  color: z.string().optional(),
  carroceria: z.string().optional(),
});

/**
 * Despachador. OJO con lo que NO está acá: Zod descarta las claves que el esquema
 * no declara (`req.body = result.data`), así que un campo omitido no "pasa igual"
 * — se borra antes de llegar al modelo. Eso fue exactamente el bug del `correo`:
 * el panel lo mandaba, el esquema no lo nombraba, y el modelo respondía "el correo
 * es obligatorio" sobre un formulario que lo tenía escrito.
 *
 * `documento` es OPCIONAL desde la migración 021 (el modelo lo guarda `null`);
 * `correo` es lo único que el maestro exige además del nombre, porque es con lo
 * que la persona inicia sesión y con lo que se le asignan los despachos.
 *
 * Y volvió a pasar con `sede` (migración 025): el selector la mandaba, el esquema
 * no la nombraba, Zod la descartaba y guardar parecía no hacer nada — sin error,
 * sin pista. El aviso de arriba estaba escrito justamente para esto.
 */
const despachadorSchema = z.object({
  documento: z.string().optional(),
  nombre: z.string().min(1, "El nombre es obligatorio"),
  telefono: z.string().optional(),
  correo: z.string().min(1, "El correo es obligatorio"),
  // Bodega de la persona. Cadena vacía = "todas las sedes", que es lo que manda
  // el selector cuando no se elige ninguna; el modelo la convierte a NULL.
  sede: z.string().nullable().optional(),
});

const conductorSchema = z.object({
  documento: z.string().min(1, "El documento es obligatorio"),
  nombre: z.string().min(1, "El nombre es obligatorio"),
  direccion: z.string().optional(),
  telefono: z.string().optional(),
  licencia: z.string().optional(),
  ciudad: z.string().optional(),
});

export const validators = {
  crearDespacho: validate(crearDespachoSchema),
  cargarCamion: validate(cargarCamionSchema),
  vehiculo: validate(vehiculoSchema),
  conductor: validate(conductorSchema),
  despachador: validate(despachadorSchema),
  alertasConfig: validate(alertasConfigSchema),
  cambiarEstado: validate(cambiarEstadoSchema),
  comparar: validate(compararSchema),
  confirmar: validate(confirmarSchema),
  recolectar: validate(recolectarSchema),
  capacidadBulk: validate(capacidadBulkSchema),
  capacidadUno: validate(capacidadUnoSchema),
  config: validate(configSchema),
};
