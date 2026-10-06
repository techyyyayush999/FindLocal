const express = require('express');
const { getAllShops, getShopById, getNearbyShops } = require('../controllers/shop.controller');
const validate = require('../middlewares/validate.middleware');
const { nearbyQueryRules } = require('../validators/shop.validators');

const router = express.Router();

// ─── Public customer-facing routes (no auth required) ────────────────────────
// All endpoints below only surface VERIFIED shops.

// IMPORTANT: /nearby must be defined BEFORE /:id to prevent Express from
// interpreting "nearby" as a dynamic :id parameter.

// ─── GET /api/v1/shops/nearby ─────────────────────────────────────────────────
// Query params: lat, lng (required), radius (optional, default 5000 m)
router.get('/nearby', nearbyQueryRules, validate, getNearbyShops);

// ─── GET /api/v1/shops ────────────────────────────────────────────────────────
// Returns all verified shops sorted by newest first
router.get('/', getAllShops);

// ─── GET /api/v1/shops/:id ────────────────────────────────────────────────────
// Returns a single verified shop by MongoDB ObjectId
router.get('/:id', getShopById);

module.exports = router;
