/**
 * asyncHandler — Wraps async route handlers to forward any thrown errors
 * to Express's centralized error middleware via `next(err)`.
 *
 * Usage:
 *   router.get('/route', asyncHandler(async (req, res) => { ... }));
 *
 * Without this utility every controller needs its own try/catch block.
 * With it, simply throw an error (or let a rejected promise bubble up)
 * and the centralized errorHandler middleware in Phase 0 handles the rest.
 */
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

module.exports = asyncHandler;
