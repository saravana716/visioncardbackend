/**
 * Central error handler — maps known errors to HTTP status codes and avoids leaking stack traces in production.
 */
function errorHandler(err, req, res, _next) {
  const status = err.statusCode && Number.isInteger(err.statusCode) ? err.statusCode : 500;
  const isProduction = process.env.NODE_ENV === "production";
  // In production a raw 500 message can leak internals (Firestore paths,
  // library errors); log it server-side and return a generic message. Known
  // errors (4xx / explicit statusCode) keep their message — those are written
  // for the client.
  if (status === 500) {
    console.error("[error-handler]", err);
  }
  const payload = {
    error: err.code || (status === 500 ? "INTERNAL_ERROR" : "REQUEST_ERROR"),
    message:
      isProduction && status === 500
        ? "Something went wrong"
        : err.message || "Something went wrong",
  };
  if (!isProduction && err.stack) {
    payload.stack = err.stack;
  }
  res.status(status).json(payload);
}

module.exports = { errorHandler };
