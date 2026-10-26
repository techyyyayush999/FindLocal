const rateLimit = require('express-rate-limit');
const { validateEnv } = require('../config/env');

// ─── Rate limiting ─────────────────────────────────────────────────────────────
// Three layers of protection, all built from the validated configuration so the
// limits live in exactly one place (src/config/env.js + .env):
//
//   apiLimiter                 — broad ceiling for every /api/v1 request
//   authLimiter                — strict ceiling for login / register (credential guessing)
//   reservationCreationLimiter — targeted ceiling for reservation creation only
//
// Defaults are conservative in production but generous under NODE_ENV=test so the
// isolated regression suites are never throttled. An explicit RATE_LIMIT_* value
// always wins, which the security tests use to force an HTTP 429 on purpose.
//
// The server exits during startup when configuration is invalid, so the values
// read here are always sane. No secret is ever involved.
const { rateLimit: limits } = validateEnv(process.env).config;

const RATE_LIMIT_MESSAGE = 'Too many requests. Please try again later.';

const baseOptions = {
  windowMs: limits.windowMs,
  standardHeaders: true, // send the modern RateLimit-* response headers
  legacyHeaders: false, // do not send the deprecated X-RateLimit-* headers
  message: { success: false, message: RATE_LIMIT_MESSAGE },
};

// Broad limiter — applies to all API traffic (defence in depth; the per-route
// limiters below are stricter than this one).
const apiLimiter = rateLimit({ ...baseOptions, limit: limits.apiMax });

// Strict limiter — repeated login/registration attempts are a credential-guessing
// signal, so this is far tighter than the broad limiter.
const authLimiter = rateLimit({ ...baseOptions, limit: limits.authMax });

// Targeted limiter — one limiter instance/namespace, scoped to reservation
// creation by the caller (see server.js).
const reservationCreationLimiter = rateLimit({ ...baseOptions, limit: limits.reservationMax });

module.exports = { apiLimiter, authLimiter, reservationCreationLimiter };
