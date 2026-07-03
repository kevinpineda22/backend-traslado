import { z } from "zod";

// Esquema para crear un despacho
const crearDespachoSchema = z.object({
  flujo: z.string().optional(),
  origen: z.string().optional(),
  destino: z.string().min(1, "destino es requerido"),
  despachador_id: z.string().min(1, "despachador_id es requerido"),
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
  ]),
  firma_data: z.string().optional(),
});

// Esquema para auditoría
const auditarSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string().uuid(),
        cantidad_auditor: z.number().min(0, "cantidad_auditor no puede ser negativa"),
      }),
    )
    .min(1),
  firma_data: z.string().min(1, "firma_data es requerida"),
});

// Esquema para recolección
const recolectarSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string().uuid(),
        cantidad: z.number().min(0, "cantidad no puede ser negativa"),
      }),
    )
    .min(1),
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
  auditar: validate(auditarSchema),
  recolectar: validate(recolectarSchema),
};
