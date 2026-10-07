const { body, query } = require('express-validator');

// ─── Create Shop Rules ─────────────────────────────────────────────────────────
const createShopRules = [
  body('name')
    .trim()
    .notEmpty()
    .withMessage('Shop name is required')
    .isLength({ max: 100 })
    .withMessage('Shop name cannot exceed 100 characters'),

  body('description')
    .optional()
    .trim()
    .isLength({ max: 500 })
    .withMessage('Description cannot exceed 500 characters'),

  body('address')
    .trim()
    .notEmpty()
    .withMessage('Address is required')
    .isLength({ max: 300 })
    .withMessage('Address cannot exceed 300 characters'),

  body('phone')
    .optional()
    .trim()
    .matches(/^[+]?[\d\s().-]{7,20}$/)
    .withMessage('Phone number is not valid'),

  // Longitude: required for create, -180 to 180
  body('longitude')
    .notEmpty()
    .withMessage('Longitude is required')
    .isFloat({ min: -180, max: 180 })
    .withMessage('Longitude must be between -180 and 180'),

  // Latitude: required for create, -90 to 90
  body('latitude')
    .notEmpty()
    .withMessage('Latitude is required')
    .isFloat({ min: -90, max: 90 })
    .withMessage('Latitude must be between -90 and 90'),

  body('isOpen')
    .optional()
    .isBoolean()
    .withMessage('isOpen must be a boolean'),
];

// ─── Update Shop Rules ─────────────────────────────────────────────────────────
// All fields optional — seller can do partial updates.
// Protected fields (owner, isVerified, verifiedAt, verifiedBy) are stripped
// in the controller; they are not validated here on purpose.
const updateShopRules = [
  body('name')
    .optional()
    .trim()
    .notEmpty()
    .withMessage('Shop name cannot be empty')
    .isLength({ max: 100 })
    .withMessage('Shop name cannot exceed 100 characters'),

  body('description')
    .optional()
    .trim()
    .isLength({ max: 500 })
    .withMessage('Description cannot exceed 500 characters'),

  body('address')
    .optional()
    .trim()
    .notEmpty()
    .withMessage('Address cannot be empty')
    .isLength({ max: 300 })
    .withMessage('Address cannot exceed 300 characters'),

  body('phone')
    .optional()
    .trim()
    .matches(/^[+]?[\d\s().-]{7,20}$/)
    .withMessage('Phone number is not valid'),

  body('longitude')
    .optional()
    .isFloat({ min: -180, max: 180 })
    .withMessage('Longitude must be between -180 and 180'),

  body('latitude')
    .optional()
    .isFloat({ min: -90, max: 90 })
    .withMessage('Latitude must be between -90 and 90'),

  body().custom((value, { req }) => {
    const hasLng = req.body.longitude !== undefined;
    const hasLat = req.body.latitude !== undefined;
    if ((hasLng && !hasLat) || (!hasLng && hasLat)) {
      throw new Error('Both longitude and latitude must be provided together, or neither.');
    }
    return true;
  }),

  body('isOpen')
    .optional()
    .isBoolean()
    .withMessage('isOpen must be a boolean'),
];

// ─── Nearby Query Rules ────────────────────────────────────────────────────────
// Used for GET /api/v1/shops/nearby?lat=&lng=&radius=
const nearbyQueryRules = [
  query('lat')
    .notEmpty()
    .withMessage('lat is required')
    .isFloat({ min: -90, max: 90 })
    .withMessage('lat must be a valid latitude between -90 and 90'),

  query('lng')
    .notEmpty()
    .withMessage('lng is required')
    .isFloat({ min: -180, max: 180 })
    .withMessage('lng must be a valid longitude between -180 and 180'),

  query('radius')
    .optional()
    .isFloat({ min: 100, max: 50000 })
    .withMessage('radius must be between 100 and 50000 meters'),
];

// ─── ObjectId Param Rule ───────────────────────────────────────────────────────
// Validates a route param `id` is a 24-hex MongoDB ObjectId.
// Returns 400 via the standard validate middleware on mismatch.
const objectIdParamRules = [
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

module.exports = { createShopRules, updateShopRules, nearbyQueryRules, objectIdParamRules };
