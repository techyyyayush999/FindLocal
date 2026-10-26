const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
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

// Enable CORS — credentials:true is required for HttpOnly cookies to be sent cross-origin.
// The allowlist comes from the validated config: a wildcard is rejected at startup,
// so there is no silent "*" fallback while credentials are enabled.
app.use(
  cors({
    origin: envConfig.corsOrigins,
    credentials: true,
  })
);

// Body parser middlewares
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

