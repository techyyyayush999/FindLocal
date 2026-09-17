const jwt = require('jsonwebtoken');
const User = require('../models/User.model');
const asyncHandler = require('../utils/asyncHandler');
const { COOKIE_NAME } = require('../middlewares/auth.middleware');

// ─── Helper: Sign JWT and set HttpOnly cookie ──────────────────────────────────
// Centralizes token creation and cookie configuration to keep controllers clean.
// The cookie is HttpOnly (unreadable by JS) and Secure in production (HTTPS only).
const sendTokenCookie = (res, user) => {
  const token = jwt.sign(
    { id: user._id, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );

  const cookieOptions = {
    httpOnly: true,                                      // Inaccessible to JavaScript — XSS protection
    secure: process.env.NODE_ENV === 'production',       // HTTPS only in production
    sameSite: 'strict',                                  // CSRF protection: cookie only sent to same origin
    maxAge: 7 * 24 * 60 * 60 * 1000,                    // 7 days in milliseconds
  };

  res.cookie(COOKIE_NAME, token, cookieOptions);
};

// ─── Helper: Build safe user object (no password) ─────────────────────────────
const sanitizeUser = (user) => ({
  _id: user._id,
  name: user.name,
  email: user.email,
  role: user.role,
  isVerified: user.isVerified,
  isActive: user.isActive,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
});

// ─── POST /api/v1/auth/register ────────────────────────────────────────────────
const register = asyncHandler(async (req, res) => {
  const { name, email, password, role } = req.body;

  // Prevent any attempt to self-register as admin
  if (role === 'admin') {
    const error = new Error('You cannot register with the admin role.');
    error.statusCode = 400;
    throw error;
  }

  // Check for duplicate email
  const existingUser = await User.findOne({ email });
  if (existingUser) {
    const error = new Error('An account with this email already exists.');
    error.statusCode = 409;
    throw error;
  }

  // Create user — password hashing happens automatically in the pre-save hook
  const user = await User.create({ name, email, password, role: role || 'customer' });

  sendTokenCookie(res, user);

  res.status(201).json({
    success: true,
    message: 'Account created successfully.',
    data: { user: sanitizeUser(user) },
  });
});

// ─── POST /api/v1/auth/login ───────────────────────────────────────────────────
const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  // Explicitly select password because it is select:false on the schema
  const user = await User.findOne({ email }).select('+password');

  // Use the same generic message for both "user not found" and "wrong password"
  // to prevent user enumeration attacks (an attacker learns which emails are registered)
  if (!user || !(await user.comparePassword(password))) {
    const error = new Error('Invalid email or password.');
    error.statusCode = 401;
    throw error;
  }

  if (!user.isActive) {
    const error = new Error('Your account has been deactivated. Please contact support.');
    error.statusCode = 403;
    throw error;
  }

  sendTokenCookie(res, user);

  res.status(200).json({
    success: true,
    message: 'Logged in successfully.',
    data: { user: sanitizeUser(user) },
  });
});

// ─── POST /api/v1/auth/logout ──────────────────────────────────────────────────
const logout = asyncHandler(async (req, res) => {
  // Overwrite the cookie with an expired one — this clears it from the browser
  res.cookie(COOKIE_NAME, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 0,
  });

  res.status(200).json({
    success: true,
    message: 'Logged out successfully.',
  });
});

// ─── GET /api/v1/auth/me ───────────────────────────────────────────────────────
// Protected route. protect middleware has already validated the token and
// attached the full user document to req.user before this controller runs.
const getMe = asyncHandler(async (req, res) => {
  res.status(200).json({
    success: true,
    data: { user: sanitizeUser(req.user) },
  });
});

module.exports = { register, login, logout, getMe };
