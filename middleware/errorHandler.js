/**
 * Central error handler — maps known errors to HTTP status codes and avoids leaking stack traces in production.
 */
function errorHandler(err, req, res, _next) {
  const status = err.statusCode && Number.isInteger(err.statusCode) ? err.statusCode : 500;
  const payload = {
    error: err.code || (status === 500 ? "INTERNAL_ERROR" : "REQUEST_ERROR"),
    message: err.message || "Something went wrong",
  };
  if (process.env.NODE_ENV !== "production" && err.stack) {
    payload.stack = err.stack;
  }
  res.status(status).json(payload);
}

module.exports = { errorHandler };
