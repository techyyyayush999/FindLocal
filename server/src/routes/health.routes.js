const express = require('express');
const {
  getHealthStatus,
  getReadinessStatus,
} = require('../controllers/health.controller');

const router = express.Router();

// Liveness probe (existing contract preserved).
router.get('/', getHealthStatus);

// Readiness probe — database-aware; 503 while MongoDB is not connected.
router.get('/ready', getReadinessStatus);

module.exports = router;
