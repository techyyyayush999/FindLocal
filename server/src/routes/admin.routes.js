const express = require('express');
const { getAllUsers, getUserById, updateUserStatus } = require('../controllers/user.controller');
const { adminGetAllShops, adminGetShopById, adminVerifyShop } = require('../controllers/shop.controller');
const { protect, authorize } = require('../middlewares/auth.middleware');
const { objectIdParamRules } = require('../validators/shop.validators');

const router = express.Router();

// All admin routes require a valid JWT (protect) AND the admin role (authorize).
// protect runs first to establish identity; authorize then checks the role.
router.use(protect, authorize('admin'));

// ─── User management ──────────────────────────────────────────────────────────
// The ':id' routes validate the param up front with the same shared rule used by
// the shop routes below, so a malformed ObjectId is rejected as a consistent
// client error and never reaches a Mongoose query.
router.get('/users', getAllUsers);
router.get('/users/:id', objectIdParamRules, getUserById);
router.patch('/users/:id/status', objectIdParamRules, updateUserStatus);

// ─── Shop management ──────────────────────────────────────────────────────────
router.get('/shops', adminGetAllShops);
router.get('/shops/:id', objectIdParamRules, adminGetShopById);
router.patch('/shops/:id/verify', objectIdParamRules, adminVerifyShop);

module.exports = router;
