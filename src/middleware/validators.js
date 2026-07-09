import { z } from "zod";

// Esquema para crear un despacho
const crearDespachoSchema = z.object({
  flujo: z.string().optional(),
  origen: z.string().optional(),
  destino: z.string().min(1, "destino es requerido"),
  despachador_id: z.string().optional(), // opcional: sin asignar = pool
  admin_id: z.string().optional(),
  criterios: z.array(z.string()).optional(),
  items: z
    .array(
      z.object({
        codigo_item: z.string().min(1),
        descripcion: z.string().optional(),
        unidad_medida: z.string().optional(),
        factor: z.number().optional(),
        rotacion: z.string().optional(),
        stock_origen: z.number().optional(),
        stock_destino: z.number().optional(),
        consumo_destino: z.number().optional(),
        stock_seguridad: z.number().optional(),
        sugerido: z.number().optional(),
        cantidad: z.number().positive("cantidad debe ser mayor a 0"),
      }),
    )
    .min(1, "Debe incluir al menos un item"),
});

// Esquema para cambio de estado
const cambiarEstadoSchema = z.object({
  estado: z.enum([
    "En_recoleccion",
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

// Auditoría — Paso 2: confirmar (decisión + firma)
const confirmarSchema = z.object({
  decision: z.enum(["aprobado", "inconsistencia", "rechazado"]),
  auditor_id: z.string().optional(),
  firma_data: z.string().min(1, "firma_data es requerida"),
  items: itemsAuditorSchema,
});

// Esquema para recolección
// El tope superior (cantidad <= cantidad_admin) se valida en el modelo, contra
// el valor guardado en la base — Zod no lo conoce en tiempo de request.
const recolectarSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string().uuid(),
        cantidad: z.number().min(0, "cantidad no puede ser negativa"),
        agotado: z.boolean().optional(),
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

export const validators = {
  crearDespacho: validate(crearDespachoSchema),
  cambiarEstado: validate(cambiarEstadoSchema),
  comparar: validate(compararSchema),
  confirmar: validate(confirmarSchema),
  recolectar: validate(recolectarSchema),
  capacidadBulk: validate(capacidadBulkSchema),
  capacidadUno: validate(capacidadUnoSchema),
};
