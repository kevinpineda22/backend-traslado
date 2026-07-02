/**
 * Middleware centralizado de manejo de errores.
 * Atrapa cualquier error lanzado en los controladores
 * y devuelve una respuesta JSON consistente.
 */
export function errorHandler(err, req, res, _next) {
  console.error("🔴 Error:", err.message);

  const statusCode = err.statusCode || 500;
  const mensaje = err.expose ? err.message : "Error interno del servidor";

  res.status(statusCode).json({
    ok: false,
    error: mensaje,
    ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
  });
}

/**
 * Helper para crear errores con código HTTP.
 */
export function createError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.expose = true;
  return error;
}
