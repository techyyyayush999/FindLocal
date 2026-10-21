const express = require('express');
const {
  createInventory,
  getInventory,
  getInventoryById,
  updateInventory,
  updateStock,
} = require('../controllers/inventory.controller');
const { protect, authorize } = require('../middlewares/auth.middleware');
const { resolveSellerShop } = require('../middlewares/shop.middleware');
const validate = require('../middlewares/validate.middleware');
const {
  createInventoryRules,
  updateInventoryRules,
  stockUpdateRules,
  inventoryListRules,
  inventoryIdParamRules,
} = require('../validators/inventory.validators');

const router = express.Router();

// All inventory routes require authentication + seller role
router.use(protect);
router.use(authorize('seller'));

// ─── POST /api/v1/inventory ─────────────────────────────────────────────────
// Create inventory entry — requires verified shop
router.post(
  '/',
  resolveSellerShop({ requireVerified: true }),
  createInventoryRules,
  validate,
  createInventory
);

// ─── GET /api/v1/inventory ──────────────────────────────────────────────────
// List seller's inventory — does not require verified shop
router.get(
  '/',
  resolveSellerShop({ requireVerified: false }),
  inventoryListRules,
  validate,
  getInventory
);

// ─── GET /api/v1/inventory/:id ──────────────────────────────────────────────
// Get single entry — does not require verified shop
router.get(
  '/:id',
  inventoryIdParamRules,
  resolveSellerShop({ requireVerified: false }),
  getInventoryById
);

// ─── PATCH /api/v1/inventory/:id ────────────────────────────────────────────
// Update price and/or isActive
// Price changes require verified shop; deactivation alone does not.
// We use requireVerified: false here and let the controller-level logic
// or a more granular approach handle it. However, per the spec, we apply
// a conditional middleware: if pricePaise is being changed, require verified.
// Simplification: route uses requireVerified: false; the spec says
// "Allow deactivation even if shop is unverified" — so we handle
// price-change verification in a custom middleware below.
router.patch(
  '/:id',
  inventoryIdParamRules,
  resolveSellerShop({ requireVerified: false }),
  // Conditional: if pricePaise is in the body, require verified shop
  (req, res, next) => {
    if (req.body.pricePaise !== undefined && !req.shop.isVerified) {
      const error = new Error('Your shop must be verified to update prices.');
      error.statusCode = 403;
      return next(error);
    }
    next();
  },
  updateInventoryRules,
  validate,
  updateInventory
);

// ─── PATCH /api/v1/inventory/:id/stock ──────────────────────────────────────
// Atomic stock update — requires verified shop
router.patch(
  '/:id/stock',
  inventoryIdParamRules,
  resolveSellerShop({ requireVerified: true }),
  stockUpdateRules,
  validate,
  updateStock
);

module.exports = router;
