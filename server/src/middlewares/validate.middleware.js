const { validationResult } = require('express-validator');

/**
 * validate — Middleware that reads the result of express-validator rule chains
 * and responds with a 400 if any validation errors are present.
 *
 * Usage (in a route file):
 *   router.post('/register', registerRules, validate, registerController);
 *
 * The error response shape matches the project's centralized error convention:
 *   { success: false, message: '...', errors: [...] }
 */
const validate = (req, res, next) => {
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors: errors.array().map((err) => ({
        field: err.path,
        message: err.msg,
      })),
    });
  }

  next();
};

module.exports = validate;
