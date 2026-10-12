const { body, query, param } = require('express-validator');
const {
  PRODUCT_CATEGORIES,
  PRODUCT_STATUSES,
  PRODUCT_SYSTEM_FIELDS,
  VALID_GTIN_LENGTHS,
} = require('../constants/productConstants');

// ─── Helper: reject system/unknown fields in body ────────────────────────────
// Returns a custom body() validator that ensures no system-generated or
// unknown fields sneak through.
const rejectSystemFields = (allowedFields) =>
  body().custom((value, { req }) => {
    const bodyKeys = Object.keys(req.body);
    const unknownFields = bodyKeys.filter((k) => !allowedFields.includes(k));
    if (unknownFields.length > 0) {
      throw new Error(
        `Unknown or system-generated fields are not allowed: ${unknownFields.join(', ')}`
      );
    }
    return true;
  });

// ─── Helper: sanitize string query params against operator injection ─────────
// Prevents things like category[$ne]=foo from becoming a MongoDB operator.
const sanitizeQueryString = (fieldName) =>
  query(fieldName)
    .optional()
    .customSanitizer((value) => {
      // If it's not a simple string, reject it
      if (typeof value !== 'string') return undefined;
      return value;
    });

// ─── GTIN validation chain (reused by create and update) ─────────────────────
const gtinChain = body('gtin')
  .optional({ values: 'falsy' })
  .isString()
  .withMessage('GTIN must be a string')
  .matches(/^\d+$/)
  .withMessage('GTIN must contain only digits')
  .custom((value) => {
    if (!VALID_GTIN_LENGTHS.includes(value.length)) {
      throw new Error(`GTIN must be 8, 12, 13, or 14 digits long`);
    }
    return true;
  });

// ─── Image validation chain (reused by create and update) ────────────────────
const imagesChain = body('images')
  .optional()
  .isArray({ max: 5 })
  .withMessage('Images must be an array with at most 5 items');

const imageItemChain = body('images.*')
  .isString()
  .withMessage('Each image must be a string URL')
  .isLength({ max: 2048 })
  .withMessage('Each image URL cannot exceed 2048 characters')
  .matches(/^https:\/\/.+/)
  .withMessage('Each image URL must be a valid HTTPS URL');

// ─── Create Product Rules ────────────────────────────────────────────────────
const createProductRules = [
  rejectSystemFields(['name', 'brand', 'category', 'description', 'images', 'gtin']),

  body('name')
    .trim()
    .notEmpty()
    .withMessage('Product name is required')
    .isLength({ min: 2, max: 150 })
    .withMessage('Product name must be between 2 and 150 characters')
    .matches(/[\p{L}\p{N}]/u)
    .withMessage('Product name must contain at least one letter or digit'),

  body('brand')
    .trim()
    .notEmpty()
    .withMessage('Brand is required')
    .isLength({ min: 1, max: 80 })
    .withMessage('Brand must be between 1 and 80 characters'),

  body('category')
    .trim()
    .notEmpty()
    .withMessage('Category is required')
    .isIn(PRODUCT_CATEGORIES)
    .withMessage(`Category must be one of: ${PRODUCT_CATEGORIES.join(', ')}`),

  body('description')
    .optional()
    .isString()
    .withMessage('Description must be a string')
    .isLength({ max: 2000 })
    .withMessage('Description cannot exceed 2000 characters'),

  imagesChain,
  imageItemChain,
  gtinChain,
];

// ─── Update Product Rules ────────────────────────────────────────────────────
const updateProductRules = [
  rejectSystemFields(['name', 'brand', 'category', 'description', 'images', 'gtin']),

  body('name')
    .optional()
    .trim()
    .notEmpty()
    .withMessage('Product name cannot be empty')
    .isLength({ min: 2, max: 150 })
    .withMessage('Product name must be between 2 and 150 characters')
    .matches(/[\p{L}\p{N}]/u)
    .withMessage('Product name must contain at least one letter or digit'),

  body('brand')
    .optional()
    .trim()
    .notEmpty()
    .withMessage('Brand cannot be empty')
    .isLength({ min: 1, max: 80 })
    .withMessage('Brand must be between 1 and 80 characters'),

  body('category')
    .optional()
    .trim()
    .isIn(PRODUCT_CATEGORIES)
    .withMessage(`Category must be one of: ${PRODUCT_CATEGORIES.join(', ')}`),

  body('description')
    .optional()
    .isString()
    .withMessage('Description must be a string')
    .isLength({ max: 2000 })
    .withMessage('Description cannot exceed 2000 characters'),

  imagesChain,
  imageItemChain,
  gtinChain,
];

// ─── Status Update Rules ─────────────────────────────────────────────────────
const statusUpdateRules = [
  body('status')
    .trim()
    .notEmpty()
    .withMessage('Status is required')
    .isIn(Object.values(PRODUCT_STATUSES))
    .withMessage(`Status must be one of: ${Object.values(PRODUCT_STATUSES).join(', ')}`),

  body('rejectionReason')
    .optional()
    .isString()
    .withMessage('Rejection reason must be a string')
    .isLength({ max: 300 })
    .withMessage('Rejection reason cannot exceed 300 characters'),

  // rejectionReason is required when status is REJECTED
  body('rejectionReason').custom((value, { req }) => {
    if (req.body.status === PRODUCT_STATUSES.REJECTED) {
      if (!value || (typeof value === 'string' && value.trim().length === 0)) {
        throw new Error('Rejection reason is required when rejecting a product');
      }
    }
    return true;
  }),

  // Reject unknown fields beyond status and rejectionReason
  body().custom((value, { req }) => {
    const bodyKeys = Object.keys(req.body);
    const allowedKeys = ['status', 'rejectionReason'];
    const unknownFields = bodyKeys.filter((k) => !allowedKeys.includes(k));
    if (unknownFields.length > 0) {
      throw new Error(`Unknown fields are not allowed: ${unknownFields.join(', ')}`);
    }
    return true;
  }),
];

// ─── Pagination Rules (reusable) ─────────────────────────────────────────────
const paginationRules = [
  query('page')
    .optional()
    .isInt({ min: 1 })
    .withMessage('Page must be a positive integer')
    .toInt(),

  query('limit')
    .optional()
    .isInt({ min: 1, max: 50 })
    .withMessage('Limit must be between 1 and 50')
    .toInt(),
];

// ─── Product List Rules (public catalog) ─────────────────────────────────────
const productListRules = [
  ...paginationRules,
  sanitizeQueryString('category'),
  query('category')
    .optional()
    .isIn(PRODUCT_CATEGORIES)
    .withMessage(`Category must be one of: ${PRODUCT_CATEGORIES.join(', ')}`),
];

// ─── Seller "My Products" List Rules ─────────────────────────────────────────
const myProductsListRules = [
  ...paginationRules,
  sanitizeQueryString('status'),
  query('status')
    .optional()
    .isIn(Object.values(PRODUCT_STATUSES))
    .withMessage(`Status must be one of: ${Object.values(PRODUCT_STATUSES).join(', ')}`),
];

// ─── Admin Products List Rules ───────────────────────────────────────────────
const adminProductsListRules = [
  ...paginationRules,
  sanitizeQueryString('status'),
  sanitizeQueryString('category'),
  query('status')
    .optional()
    .isIn(Object.values(PRODUCT_STATUSES))
    .withMessage(`Status must be one of: ${Object.values(PRODUCT_STATUSES).join(', ')}`),
  query('category')
    .optional()
    .isIn(PRODUCT_CATEGORIES)
    .withMessage(`Category must be one of: ${PRODUCT_CATEGORIES.join(', ')}`),
];

// ─── ObjectId Param Rule ─────────────────────────────────────────────────────
// Replicates the pattern used in shop.validators.js
const productIdParamRules = [
  (req, res, next) => {
    const id = req.params.id;
    if (typeof id !== 'string' || !/^[0-9a-fA-F]{24}$/.test(id)) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: [{ field: 'id', message: 'Invalid ID format. Must be a valid MongoDB ObjectId.' }],
      });
    }
    next();
  },
];

module.exports = {
  createProductRules,
  updateProductRules,
  statusUpdateRules,
  productListRules,
  myProductsListRules,
  adminProductsListRules,
  productIdParamRules,
};
