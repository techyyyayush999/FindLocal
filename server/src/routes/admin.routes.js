const express = require('express');
const { getAllUsers, getUserById, updateUserStatus } = require('../controllers/user.controller');
const { protect, authorize } = require('../middlewares/auth.middleware');

const router = express.Router();

// All admin routes require a valid JWT (protect) AND the admin role (authorize).
// protect runs first to establish identity; authorize then checks the role.
router.use(protect, authorize('admin'));

router.get('/users', getAllUsers);
router.get('/users/:id', getUserById);
router.patch('/users/:id/status', updateUserStatus);

module.exports = router;
