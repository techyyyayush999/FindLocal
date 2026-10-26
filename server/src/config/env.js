const path = require('path');
const dotenv = require('dotenv');

// ─── Load environment variables ────────────────────────────────────────────────
// Load server/.env once, resolved from this file's location so it works no matter
// what the current working directory is. dotenv never overrides a variable that is
// already present in process.env, so explicitly-provided values (containers, CI,
// and the isolated test harnesses that spawn server.js) always take precedence.
dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });

// ─── JWT secret strength rules ─────────────────────────────────────────────────
// A weak or placeholder signing secret lets anyone forge an authenticated cookie,
// which is a complete authentication bypass. These are enforced at startup.
const MIN_SECRET_LENGTH = 32;

// Exact (case-insensitive) values that are obviously not real secrets.
const PLACEHOLDER_SECRETS = [
  'your_jwt_secret_here',
  'your_jwt_secret',
  'your_secret',
  'your_secret_key',
  'jwt_secret',
  'jwtsecret',
  'secret',
  'supersecret',
  'changeme',
  'change_me',
  'change-me',
  'password',
  'passw0rd',
  'placeholder',
  'example',
  'replace_me',
  'change_this',
];

// Substrings that mark a value as a placeholder regardless of length.
const PLACEHOLDER_SUBSTRINGS = [
  'your_jwt_secret',
  'your-secret',
  'your_secret',
  'changeme',
  'change_me',
  'change-me',
  'replace_me',
  'replace-me',
  'replace_with',
  'placeholder',
  'example',
  'change_this',
];

// Returns true when a secret is a known placeholder or is trivially weak
// (a single character repeated). The actual value is never logged or returned.
function looksLikePlaceholder(secret) {
  const normalized = secret.trim().toLowerCase();

  if (PLACEHOLDER_SECRETS.includes(normalized)) return true;
  if (PLACEHOLDER_SUBSTRINGS.some((marker) => normalized.includes(marker))) return true;

  // Disallow trivial secrets such as "aaaaaaaa...".
  if (normalized.length > 0 && normalized.split('').every((char) => char === normalized[0])) {
    return true;
  }

  return false;
}

function parseCorsOrigins(raw) {
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

// ─── validateEnv ───────────────────────────────────────────────────────────────
// Pure validation: takes an environment object (defaults to process.env) and
// returns { ok, errors, config }. Error strings only ever name variables and the
// reason — never their values — so no secret can leak through a config error.
function validateEnv(env = process.env) {
  const errors = [];

  // MONGO_URI — required and must be a MongoDB connection string.
  const mongoUri = String(env.MONGO_URI || '').trim();
  if (!mongoUri) {
    errors.push('MONGO_URI is required (for example mongodb://localhost:27017/findlocal).');
  } else if (!/^mongodb(\+srv)?:\/\//i.test(mongoUri)) {
    errors.push('MONGO_URI must start with "mongodb://" or "mongodb+srv://".');
  }

  // JWT_SECRET — required, strong, and never a placeholder.
  const jwtSecret = String(env.JWT_SECRET || '').trim();
  if (!jwtSecret) {
    errors.push('JWT_SECRET is required.');
  } else if (looksLikePlaceholder(jwtSecret)) {
    errors.push('JWT_SECRET must not be a placeholder value (for example "your_jwt_secret_here").');
  } else if (jwtSecret.length < MIN_SECRET_LENGTH) {
    errors.push(`JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters long.`);
  }

  // CORS_ORIGIN — required. Credential-carrying cookies are always enabled, so a
  // wildcard origin must never be used and there is no silent "*" fallback.
  const rawCors = String(env.CORS_ORIGIN || '').trim();
  let corsOrigins = [];
  if (!rawCors) {
    errors.push('CORS_ORIGIN is required (a comma-separated list of allowed origins).');
  } else {
    corsOrigins = parseCorsOrigins(rawCors);
    if (corsOrigins.includes('*')) {
      errors.push('CORS_ORIGIN must not contain "*" while credential-carrying cookies are enabled.');
    } else {
      for (const origin of corsOrigins) {
        let valid = false;
        try {
          const parsed = new URL(origin);
          valid = parsed.protocol === 'http:' || parsed.protocol === 'https:';
        } catch {
          valid = false;
        }
        if (!valid) {
          errors.push(`CORS_ORIGIN entry "${origin}" is not a valid http(s) origin.`);
        }
      }
    }
  }

  // PORT — optional, defaults to 5000.
  let port = 5000;
  if (env.PORT !== undefined && String(env.PORT).trim() !== '') {
    const parsedPort = Number(env.PORT);
    if (!Number.isInteger(parsedPort) || parsedPort <= 0 || parsedPort > 65535) {
      errors.push('PORT must be an integer between 1 and 65535.');
    } else {
      port = parsedPort;
    }
  }

  const nodeEnv = String(env.NODE_ENV || 'development').trim() || 'development';
  const jwtExpiresIn = String(env.JWT_EXPIRES_IN || '7d').trim() || '7d';

  // ── Rate limiting (optional) ────────────────────────────────────────────────
  // Positive integers only. Defaults stay conservative in production but are
  // deliberately generous under NODE_ENV=test, so the isolated regression suites
  // (which issue many requests from a single host) are never throttled. An
  // explicitly provided value always wins over the default, which lets the
  // security tests force an HTTP 429 on purpose.
  const isTest = nodeEnv === 'test';
  const readPositiveInt = (name, fallback) => {
    const raw = env[name];
    if (raw === undefined || String(raw).trim() === '') return fallback;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      errors.push(`${name} must be a positive integer.`);
      return fallback;
    }
    return parsed;
  };

  const rateLimit = {
    windowMs: readPositiveInt('RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000),
    apiMax: readPositiveInt('RATE_LIMIT_API_MAX', isTest ? 1000000 : 300),
    authMax: readPositiveInt('RATE_LIMIT_AUTH_MAX', isTest ? 1000000 : 10),
    reservationMax: readPositiveInt('RATE_LIMIT_RESERVATION_MAX', isTest ? 1000000 : 20),
  };

  return {
    ok: errors.length === 0,
    errors,
    config: { mongoUri, jwtSecret, corsOrigins, port, nodeEnv, jwtExpiresIn, rateLimit },
  };
}

class ConfigError extends Error {
  constructor(errors) {
    super(`Invalid environment configuration:\n - ${errors.join('\n - ')}`);
    this.name = 'ConfigError';
    this.code = 'INVALID_ENV';
    this.errors = errors;
  }
}

// Throws a ConfigError when configuration is invalid, otherwise returns the
// validated config. Call this before the server connects or listens.
function assertValidEnv(env = process.env) {
  const { ok, errors, config } = validateEnv(env);
  if (!ok) throw new ConfigError(errors);
  return config;
}

module.exports = {
  validateEnv,
  assertValidEnv,
  ConfigError,
  MIN_SECRET_LENGTH,
  PLACEHOLDER_SECRETS,
};
