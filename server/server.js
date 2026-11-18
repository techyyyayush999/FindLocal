const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const mongoose = require('mongoose');
const { assertValidEnv } = require('./src/config/env');
const connectDB = require('./src/config/db');
const { createGracefulShutdown } = require('./src/utils/gracefulShutdown');
const logger = require('./src/utils/logger');
const healthRoutes = require('./src/routes/health.routes');
const authRoutes = require('./src/routes/auth.routes');
const adminRoutes = require('./src/routes/admin.routes');
const shopRoutes = require('./src/routes/shop.routes');
const customerRoutes = require('./src/routes/customer.routes');
const productRoutes = require('./src/routes/product.routes');
const inventoryRoutes = require('./src/routes/inventory.routes');
const reservationRoutes = require('./src/routes/reservation.routes');
const { createExpirySweeper } = require('./src/services/reservation.service');
const { notFound, errorHandler } = require('./src/middlewares/errorHandler');
const requestLogger = require('./src/middlewares/requestLogger');
const {
  apiLimiter,
  authLimiter,
  reservationCreationLimiter,
} = require('./src/middlewares/rateLimit.middleware');

// ─── Validate configuration before anything else ───────────────────────────────
// A misconfigured server must fail fast — before it connects to the database or
// accepts any request — so a missing/placeholder JWT secret or a wildcard CORS
// origin can never go live. validateEnv only ever reports variable names and
// reasons, never secret values.
let envConfig;
try {
  envConfig = assertValidEnv();
} catch (error) {
  console.error(error.message);
  console.error('Server startup aborted due to invalid configuration.');
  process.exit(1);
}

// ─── Process-level fatal-error handlers ────────────────────────────────────────
// Registered once, after configuration validation. They log safe diagnostic
// information only (message + stack — never request bodies, headers, cookies,
// authorization headers, passwords, JWTs or database credentials) and reuse the
// graceful shutdown routine so sockets and the DB connection are drained before
// exit. `shutdown` is assigned once the HTTP server is listening (see
// startServer); a fatal error before that has nothing to drain, so it exits 1
// directly.
let shutdown = null;

process.on('uncaughtException', (err) => {
  logger.error('uncaught_exception', {
    error: err && err.message ? err.message : String(err),
    stack: err && err.stack,
  });
  if (shutdown) shutdown('uncaughtException', 1);
  else process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const message = reason && reason.message ? reason.message : String(reason);
  logger.error('unhandled_rejection', { error: message });
  if (shutdown) shutdown('unhandledRejection', 1);
  else process.exit(1);
});

// Initialize Express app
const app = express();

// Security headers (Helmet) and remove the framework fingerprint header.
app.disable('x-powered-by');
app.use(helmet());

// Request logging — mounted immediately after Helmet and before CORS and all
// rate limiters, so CORS preflight and rate-limited requests are captured too.
// Sets req.id (server-generated), which errorHandler reads for correlation.
app.use(requestLogger);

// Enable CORS — credentials:true is required for HttpOnly cookies to be sent cross-origin.
// The allowlist comes from the validated config: a wildcard is rejected at startup,
// so there is no silent "*" fallback while credentials are enabled.
app.use(
  cors({
    origin: envConfig.corsOrigins,
    credentials: true,
  })
);

// Rate limiting — mounted before the body parsers so rejected bursts stay cheap,
// and after CORS so a 429 response still carries the CORS headers the browser needs
// to read it. Limits come from the validated config (see src/config/env.js).
app.use('/api/v1', apiLimiter); // broad ceiling for all API traffic
app.use('/api/v1/auth/login', authLimiter); // strict — credential guessing
app.use('/api/v1/auth/register', authLimiter);
app.use('/api/v1/reservations', (req, res, next) => {
  // Targeted limiter: only reservation creation is counted here, so reads,
  // cancellations and pickups are left to the broad API limiter.
  const path = (req.originalUrl || '').split('?')[0];
  if (req.method === 'POST' && path === '/api/v1/reservations') {
    return reservationCreationLimiter(req, res, next);
  }
  next();
});

// Body parser middlewares — explicit size limit to bound per-request memory.
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));

// Cookie parser — required for req.cookies to be populated (used by protect middleware)
app.use(cookieParser());

// Routes
app.use('/api/v1/health', healthRoutes);
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1/seller/shops', shopRoutes);   // Seller: protected, seller role
app.use('/api/v1/shops', customerRoutes);       // Customer: public, verified shops only
app.use('/api/v1/products', productRoutes);     // Products: authenticated, role-based
app.use('/api/v1/inventory', inventoryRoutes);  // Inventory: seller, shop-scoped
app.use('/api/v1/reservations', reservationRoutes); // Reservations: customer create/read, seller read

// ─── Static hosting: React production build + SPA fallback ─────────────────────
// Serve the Vite build output so a single domain hosts both the SPA and the API.
// Deep links (/login, /reservations, /seller, …) are answered with index.html so
// the client-side BrowserRouter can resolve them.
const CLIENT_DIST = path.join(__dirname, '..', 'client', 'dist');
const INDEX_FILE = path.join(CLIENT_DIST, 'index.html');

app.use(express.static(CLIENT_DIST));

// GET-only SPA fallback. It never intercepts the API (or any non-GET request), so
// unknown /api/* paths still reach notFound and keep the JSON 404 contract. When
// the build is absent it falls through instead of raising an ENOENT/500.
app.get('*', (req, res, next) => {
  if (req.path === '/api' || req.path.startsWith('/api/')) return next();
  if (!fs.existsSync(INDEX_FILE)) return next();
  res.sendFile(INDEX_FILE, (err) => {
    if (err) next(err);
  });
});

// 404 & Centralized Error Handlers
app.use(notFound);
app.use(errorHandler);

// Server listener
const PORT = envConfig.port;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Background reservation expiry sweep (F1): releases held stock exactly once and
// closes expired reservations as EXPIRED via the idempotent settlement path. It is
// disabled under NODE_ENV=test so tests stay deterministic, never uses a TTL index,
// guards against overlapping runs in-process, and contains its own errors.
const expirySweeper = createExpirySweeper({
  intervalMs: Number(process.env.EXPIRY_SWEEP_INTERVAL_MS || 60 * 1000),
  limit: Number(process.env.EXPIRY_SWEEP_LIMIT || 200),
});

// ─── Startup ───────────────────────────────────────────────────────────────────
// The HTTP server starts listening only AFTER MongoDB is connected, so the API
// never accepts traffic it cannot serve and readiness can be trusted.
async function startServer() {
  await connectDB(); // throws on failure — handled by the caller below

  const server = app.listen(PORT, () => {
    console.log(`FindLocal server running in ${NODE_ENV} mode on port ${PORT}`);
    expirySweeper.start();
  });

  const graceful = createGracefulShutdown({
    server,
    connection: mongoose.connection,
    sweeper: expirySweeper,
    logger,
    timeoutMs: Number(process.env.SHUTDOWN_TIMEOUT_MS || 10000),
  });
  shutdown = graceful.shutdown; // expose to the process-level handlers above

  // Idempotent: repeated signals are ignored by the shutdown routine itself.
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return server;
}

startServer().catch((error) => {
  // Sanitized: never echo MONGO_URI/credentials or raw driver output.
  const reason = error && error.name ? error.name : 'Error';
  console.error(`Server startup failed (${reason}): database is unavailable.`);
  process.exit(1);
});

module.exports = app;

