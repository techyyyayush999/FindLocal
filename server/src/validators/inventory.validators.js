const { body, query, param } = require('express-validator');
const {
  INVENTORY_BOUNDS,
  INVENTORY_CREATE_FIELDS,
  INVENTORY_UPDATE_FIELDS,
  INVENTORY_STOCK_FIELDS,
  INVENTORY_SYSTEM_FIELDS,
} = require('../constants/inventoryConstants');

// ─── Helper: reject system/unknown fields in body ────────────────────────────
const rejectUnknownFields = (allowedFields) =>
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

// ─── Helper: strict integer validation ───────────────────────────────────────
// express-validator's isInt() accepts numeric strings and floats-as-strings.
// This custom validator rejects anything that isn't a JS integer in the parsed body.
const strictInteger = (field) =>
  body(field).custom((value) => {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw new Error(`${field} must be an integer`);
    }
    return true;
  });

// ─── ObjectId Param Rule ────────────────────────────────────────────────────
// Validates route param `id` is a 24-hex MongoDB ObjectId.
const inventoryIdParamRules = [
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

// ─── ObjectId body field validation ─────────────────────────────────────────
const objectIdBody = (field) =>
  body(field)
    .notEmpty()
    .withMessage(`${field} is required`)
    .isString()
    .withMessage(`${field} must be a string`)
    .matches(/^[0-9a-fA-F]{24}$/)
    .withMessage(`${field} must be a valid 24-character hex ObjectId`);

// ─── Pagination Rules ───────────────────────────────────────────────────────
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

// ══════════════════════════════════════════════════════════════════════════════
// Create Inventory Rules
// ══════════════════════════════════════════════════════════════════════════════
const createInventoryRules = [
  rejectUnknownFields(INVENTORY_CREATE_FIELDS),

  objectIdBody('product'),

  body('pricePaise')
    .exists({ checkNull: true })
    .withMessage('pricePaise is required'),
  strictInteger('pricePaise'),
  body('pricePaise')
    .isInt({ min: INVENTORY_BOUNDS.PRICE_MIN, max: INVENTORY_BOUNDS.PRICE_MAX })
    .withMessage(
      `pricePaise must be an integer between ${INVENTORY_BOUNDS.PRICE_MIN} and ${INVENTORY_BOUNDS.PRICE_MAX}`
    ),

  body('quantity')
    .optional(),
  body('quantity')
    .optional()
    .custom((value) => {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw new Error('quantity must be an integer');
      }
      if (value < INVENTORY_BOUNDS.QUANTITY_MIN || value > INVENTORY_BOUNDS.QUANTITY_MAX) {
        throw new Error(
          `quantity must be between ${INVENTORY_BOUNDS.QUANTITY_MIN} and ${INVENTORY_BOUNDS.QUANTITY_MAX}`
        );
      }
      return true;
    }),

  body('isActive')
    .optional()
    .isBoolean({ strict: true })
    .withMessage('isActive must be a boolean (true or false)'),
];

// ══════════════════════════════════════════════════════════════════════════════
// Update Inventory Rules (PATCH /:id — price and isActive only)
// ══════════════════════════════════════════════════════════════════════════════
const updateInventoryRules = [
  rejectUnknownFields(INVENTORY_UPDATE_FIELDS),

  // Reject empty bodies
  body().custom((value, { req }) => {
    const bodyKeys = Object.keys(req.body);
    if (bodyKeys.length === 0) {
      throw new Error('Request body cannot be empty. Provide pricePaise or isActive to update.');
    }
    return true;
  }),

  body('pricePaise')
    .optional()
    .custom((value) => {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw new Error('pricePaise must be an integer');
      }
      if (value < INVENTORY_BOUNDS.PRICE_MIN || value > INVENTORY_BOUNDS.PRICE_MAX) {
        throw new Error(
          `pricePaise must be between ${INVENTORY_BOUNDS.PRICE_MIN} and ${INVENTORY_BOUNDS.PRICE_MAX}`
        );
      }
      return true;
    }),

  body('isActive')
    .optional()
    .isBoolean({ strict: true })
    .withMessage('isActive must be a boolean (true or false)'),
];

// ══════════════════════════════════════════════════════════════════════════════
// Stock Update Rules (PATCH /:id/stock)
// ══════════════════════════════════════════════════════════════════════════════
const stockUpdateRules = [
  rejectUnknownFields(INVENTORY_STOCK_FIELDS),

  // Must provide exactly one of quantity or adjust
  body().custom((value, { req }) => {
    const hasQuantity = req.body.quantity !== undefined;
    const hasAdjust = req.body.adjust !== undefined;

    if (hasQuantity && hasAdjust) {
      throw new Error('Provide either "quantity" (absolute set) or "adjust" (relative), not both.');
    }
    if (!hasQuantity && !hasAdjust) {
      throw new Error('Provide exactly one of "quantity" (absolute set) or "adjust" (relative).');
    }
    return true;
  }),

  // Absolute quantity
  body('quantity')
    .optional()
    .custom((value) => {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw new Error('quantity must be an integer');
      }
      if (value < INVENTORY_BOUNDS.QUANTITY_MIN || value > INVENTORY_BOUNDS.QUANTITY_MAX) {
        throw new Error(
          `quantity must be between ${INVENTORY_BOUNDS.QUANTITY_MIN} and ${INVENTORY_BOUNDS.QUANTITY_MAX}`
        );
      }
      return true;
    }),

  // Relative adjustment (can be negative)
  body('adjust')
    .optional()
    .custom((value) => {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw new Error('adjust must be an integer');
      }
      if (value === 0) {
        throw new Error('adjust must be non-zero');
      }
      // Bound: single adjustment magnitude cannot exceed the max quantity
      if (Math.abs(value) > INVENTORY_BOUNDS.QUANTITY_MAX) {
        throw new Error(
          `adjust magnitude cannot exceed ${INVENTORY_BOUNDS.QUANTITY_MAX}`
        );
      }
      return true;
    }),
];

// ── Inventory List Rules ────────────────────────────────────────────────────
const inventoryListRules = [...paginationRules];

module.exports = {
  createInventoryRules,
  updateInventoryRules,
  stockUpdateRules,
  inventoryListRules,
  inventoryIdParamRules,
};
