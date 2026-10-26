const { body, query } = require('express-validator');
const {
  RESERVATION_BOUNDS,
  RESERVATION_CREATE_FIELDS,
} = require('../constants/reservationConstants');

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
const reservationIdParamRules = [
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
// Create Reservation Rules
// ══════════════════════════════════════════════════════════════════════════════
const createReservationRules = [
  rejectUnknownFields(RESERVATION_CREATE_FIELDS),

  objectIdBody('inventory'),

  body('quantity')
    .exists({ checkNull: true })
    .withMessage('quantity is required'),
  strictInteger('quantity'),
  body('quantity')
    .isInt({ min: RESERVATION_BOUNDS.MIN_UNITS, max: RESERVATION_BOUNDS.MAX_UNITS })
    .withMessage(
      `quantity must be an integer between ${RESERVATION_BOUNDS.MIN_UNITS} and ${RESERVATION_BOUNDS.MAX_UNITS}`
    ),
];

// ── Reservation List Rules ──────────────────────────────────────────────────
const reservationListRules = [...paginationRules];

module.exports = {
  createReservationRules,
  reservationListRules,
  reservationIdParamRules,
};
