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

  // ─── General error fallback (Phase 1 behaviour preserved) ────────────────────
  const statusCode = err.statusCode || res.statusCode || 500;
  res.status(statusCode).json({
    success: false,
    message: err.message || 'Internal Server Error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
};

module.exports = {
  notFound,
  errorHandler,
};
