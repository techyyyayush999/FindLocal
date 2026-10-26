const mongoose = require('mongoose');

// Bounded server-selection timeout so a cold/unreachable database fails fast
// instead of hanging the startup indefinitely. Overridable for slow environments.
const DEFAULT_SERVER_SELECTION_TIMEOUT_MS = 10000;

function resolveServerSelectionTimeoutMs() {
  const parsed = Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SERVER_SELECTION_TIMEOUT_MS;
}

// Establishes the single shared Mongoose connection.
//   • Resolves to the active connection on success.
//   • THROWS on failure so the caller controls the process exit (no silent
//     "connected-ish" states and no duplicate connection attempts).
//   • Re-uses an already-open connection instead of opening a second one.
const connectDB = async () => {
  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  const conn = await mongoose.connect(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: resolveServerSelectionTimeoutMs(),
  });

  console.log(`MongoDB Connected: ${conn.connection.host}`);
  return conn.connection;
};

module.exports = connectDB;
