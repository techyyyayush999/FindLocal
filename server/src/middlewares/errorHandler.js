const notFound = (req, res, next) => {
  const error = new Error(`Not Found - ${req.originalUrl}`);
  res.status(404);
  next(error);
};

const errorHandler = (err, req, res, next) => {
  // ─── MongoDB Duplicate-Key Error (e.g. unique owner index) ───────────────────
  // Code 11000 means a unique index constraint was violated.
  // Return 409 Conflict with a descriptive message instead of a generic 500.
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || {})[0] || 'field';
    return res.status(409).json({
      success: false,
      message: `A record with this ${field} already exists.`,
    });
  }

  // ─── Mongoose CastError → 400 ────────────────────────────────────────────────
  // Raised for a malformed ObjectId / wrong-typed value (e.g. /admin/users/not-an-id).
  // Normalized to a client error; the raw cast detail is never echoed.
  if (err.name === 'CastError') {
    const field = err.path || 'value';
    return res.status(400).json({
      success: false,
      message: `Invalid value provided for '${field}'.`,
    });
  }

  // ─── Mongoose ValidationError → 400 ──────────────────────────────────────────
  // Same response contract as the express-validator middleware.
  if (err.name === 'ValidationError' && err.errors) {
    const errors = Object.values(err.errors).map((e) => ({
      field: e.path,
      message: e.message,
    }));
    return res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors,
    });
  }

  // ─── General error fallback (Phase 1 behaviour preserved) ────────────────────
  // Prefer an explicit statusCode; otherwise honour a status already set on the
  // response (e.g. 404 from notFound); never fall back to the default 200.
  const statusCode = err.statusCode || (res.statusCode >= 400 ? res.statusCode : 500);

  // Never leak raw server-side errors/stack traces in production responses.
  const isProduction = process.env.NODE_ENV === 'production';
  const message =
    statusCode >= 500 && isProduction
      ? 'Internal Server Error'
      : err.message || 'Internal Server Error';

  const body = { success: false, message };
  if (process.env.NODE_ENV === 'development' && err.stack) {
    body.stack = err.stack;
  }

  res.status(statusCode).json(body);
};

module.exports = {
  notFound,
  errorHandler,
};
