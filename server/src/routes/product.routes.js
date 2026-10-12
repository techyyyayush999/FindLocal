const express = require('express');
const {
  createProduct,
  getProducts,
  getMyProducts,
  getAdminProducts,
  getProductById,
  updateProduct,
  updateProductStatus,
} = require('../controllers/product.controller');
const { protect, authorize } = require('../middlewares/auth.middleware');
const validate = require('../middlewares/validate.middleware');
const {
  createProductRules,
  updateProductRules,
  statusUpdateRules,
  productListRules,
  myProductsListRules,
  adminProductsListRules,
  productIdParamRules,
} = require('../validators/product.validators');

const router = express.Router();

// All product routes require authentication
router.use(protect);

// ─── Static routes MUST be registered before /:id ────────────────────────────

// ─── GET /api/v1/products/mine ───────────────────────────────────────────────
// Seller's own submitted products
router.get(
  '/mine',
  authorize('seller'),
  myProductsListRules,
  validate,
  getMyProducts
);

// ─── GET /api/v1/products/admin ──────────────────────────────────────────────
// Admin moderation listing
router.get(
  '/admin',
  authorize('admin'),
  adminProductsListRules,
  validate,
  getAdminProducts
);

// ─── POST /api/v1/products ───────────────────────────────────────────────────
// Create a new product (seller or admin)
router.post(
  '/',
  authorize('seller', 'admin'),
  createProductRules,
  validate,
  createProduct
);

// ─── GET /api/v1/products ────────────────────────────────────────────────────
// List ACTIVE products (all authenticated roles)
router.get(
  '/',
  productListRules,
  validate,
  getProducts
);

// ─── GET /api/v1/products/:id ────────────────────────────────────────────────
// Product detail (visibility depends on role and status)
router.get(
  '/:id',
  productIdParamRules,
  getProductById
);

// ─── PATCH /api/v1/products/:id ──────────────────────────────────────────────
// Update a product (seller: own PENDING/REJECTED, admin: any)
router.patch(
  '/:id',
  authorize('seller', 'admin'),
  productIdParamRules,
  updateProductRules,
  validate,
  updateProduct
);

// ─── PATCH /api/v1/products/:id/status ───────────────────────────────────────
// Admin status transitions (approve, reject, deactivate, reactivate)
router.patch(
  '/:id/status',
  authorize('admin'),
  productIdParamRules,
  statusUpdateRules,
  validate,
  updateProductStatus
);

module.exports = router;
