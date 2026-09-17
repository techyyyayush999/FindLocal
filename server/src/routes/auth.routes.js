const express = require('express');
const { register, login, logout, getMe } = require('../controllers/auth.controller');
const { protect } = require('../middlewares/auth.middleware');
const validate = require('../middlewares/validate.middleware');
const { registerRules, loginRules } = require('../validators/auth.validators');

const router = express.Router();

// Public routes
router.post('/register', registerRules, validate, register);
router.post('/login', loginRules, validate, login);

// Protected routes — JWT cookie required
router.post('/logout', protect, logout);
router.get('/me', protect, getMe);

module.exports = router;
