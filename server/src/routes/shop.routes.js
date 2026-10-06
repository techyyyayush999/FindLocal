const express = require('express');
const { createShop, getMyShop, updateMyShop } = require('../controllers/shop.controller');
const { protect, authorize } = require('../middlewares/auth.middleware');
const validate = require('../middlewares/validate.middleware');
const { createShopRules, updateShopRules } = require('../validators/shop.validators');

const router = express.Router();

// All seller routes require a valid JWT (protect) AND the seller role (authorize).
router.use(protect, authorize('seller'));

// ─── POST /api/v1/seller/shops ────────────────────────────────────────────────
// Create the seller's shop (one per seller enforced by unique owner index)
router.post('/', createShopRules, validate, createShop);

// ─── GET /api/v1/seller/shops/me ──────────────────────────────────────────────
// Get the authenticated seller's own shop
router.get('/me', getMyShop);

// ─── PUT /api/v1/seller/shops/me ──────────────────────────────────────────────
// Update the authenticated seller's own shop
router.put('/me', updateShopRules, validate, updateMyShop);

module.exports = router;
