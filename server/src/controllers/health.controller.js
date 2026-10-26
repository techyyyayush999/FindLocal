const mongoose = require('mongoose');

// Liveness — "the process is up and serving". Deliberately does NOT touch the
// database so it stays lightweight and cannot fail because of a dependency.
const getHealthStatus = (req, res) => {
  res.status(200).json({
    success: true,
    status: 'ok',
    message: 'FindLocal API is running healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
};

// Readiness — "the service can actually serve traffic". Reports unavailable when
// MongoDB is not connected. Exposes only the connectivity state — never hosts,
// URIs, credentials or any other infrastructure detail.
const getReadinessStatus = (req, res) => {
  const connected = mongoose.connection.readyState === 1;

  if (!connected) {
    return res.status(503).json({
      success: false,
      status: 'unavailable',
      message: 'Service is not ready: database is not connected.',
      timestamp: new Date().toISOString(),
    });
  }

  res.status(200).json({
    success: true,
    status: 'ready',
    message: 'Service is ready.',
    timestamp: new Date().toISOString(),
  });
};

module.exports = {
  getHealthStatus,
  getReadinessStatus,
};
