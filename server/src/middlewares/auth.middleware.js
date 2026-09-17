const jwt = require('jsonwebtoken');
const User = require('../models/User.model');
const asyncHandler = require('../utils/asyncHandler');

// ─── Cookie Name Constant ──────────────────────────────────────────────────────
// Defined once here so it's consistent across protect, login, and logout.
const COOKIE_NAME = 'findlocal_token';

// ─── protect ───────────────────────────────────────────────────────────────────
// Verifies the JWT from the HttpOnly cookie and attaches the authenticated user
// to req.user. All protected routes must use this middleware first.
//
// Why re-fetch from DB instead of trusting the JWT payload alone?
// If an admin bans or deactivates a user, that user's existing JWT is still
// technically valid until expiry. Re-fetching from DB allows us to enforce
// immediate access revocation via the isActive flag — without needing Redis
// or a token blacklist.
const protect = asyncHandler(async (req, res, next) => {
  const token = req.cookies[COOKIE_NAME];

  if (!token) {
    const error = new Error('Not authenticated. Please log in.');
    error.statusCode = 401;
    return next(error);
  }

  // Verify token signature and expiry
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    const error = new Error('Session expired or invalid. Please log in again.');
    error.statusCode = 401;
    return next(error);
  }

  // Re-fetch user from DB to catch deactivated accounts
  const user = await User.findById(decoded.id);

  if (!user) {
    const error = new Error('User no longer exists.');
    error.statusCode = 401;
    return next(error);
  }

  if (!user.isActive) {
    const error = new Error('Your account has been deactivated. Contact support.');
    error.statusCode = 403;
    return next(error);
  }

  // Attach user to request for downstream middlewares and controllers
  req.user = user;
  next();
});

// ─── authorize ─────────────────────────────────────────────────────────────────
// Factory that returns a middleware restricting access to specified roles.
// Always used AFTER protect — protect establishes identity, authorize checks permission.
//
// Usage:
//   router.get('/admin', protect, authorize('admin'), handler);
//   router.post('/shop', protect, authorize('seller', 'admin'), handler);
const authorize = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      const error = new Error(
        `Role '${req.user.role}' does not have permission to perform this action.`
      );
      error.statusCode = 403;
      return next(error);
    }
    next();
  };
};

module.exports = { protect, authorize, COOKIE_NAME };
