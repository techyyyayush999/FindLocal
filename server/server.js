const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const { assertValidEnv } = require('./src/config/env');
const connectDB = require('./src/config/db');
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

// Connect to MongoDB
connectDB();

// Initialize Express app
const app = express();

// Security headers (Helmet) and remove the framework fingerprint header.
app.disable('x-powered-by');
app.use(helmet());

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

// 404 & Centralized Error Handlers
app.use(notFound);
app.use(errorHandler);

// Server listener
const PORT = envConfig.port;

// Background reservation expiry sweep (F1): releases held stock exactly once and
// closes expired reservations as EXPIRED via the idempotent settlement path. It is
// disabled under NODE_ENV=test so tests stay deterministic, never uses a TTL index,
// guards against overlapping runs in-process, and contains its own errors.
const expirySweeper = createExpirySweeper({
  intervalMs: Number(process.env.EXPIRY_SWEEP_INTERVAL_MS || 60 * 1000),
  limit: Number(process.env.EXPIRY_SWEEP_LIMIT || 200),
});

app.listen(PORT, () => {
  console.log(`FindLocal server running in ${process.env.NODE_ENV || 'development'} mode on port ${PORT}`);
  expirySweeper.start();
});

module.exports = app;

