const User = require('../models/User.model');
const asyncHandler = require('../utils/asyncHandler');

// ─── GET /api/v1/admin/users ───────────────────────────────────────────────────
// Returns all users, sorted by newest first. Password excluded by schema default.
const getAllUsers = asyncHandler(async (req, res) => {
  const users = await User.find().sort({ createdAt: -1 });

  res.status(200).json({
    success: true,
    count: users.length,
    data: { users },
  });
});

// ─── GET /api/v1/admin/users/:id ──────────────────────────────────────────────
const getUserById = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);

  if (!user) {
    const error = new Error('User not found.');
    error.statusCode = 404;
    throw error;
  }

  res.status(200).json({
    success: true,
    data: { user },
  });
});

// ─── PATCH /api/v1/admin/users/:id/status ─────────────────────────────────────
// Toggles a user's isActive flag (soft-ban / reinstate).
// Admins cannot deactivate themselves via this endpoint.
const updateUserStatus = asyncHandler(async (req, res) => {
  const { isActive } = req.body;

  if (typeof isActive !== 'boolean') {
    const error = new Error('isActive must be a boolean value (true or false).');
    error.statusCode = 400;
    throw error;
  }

  // Prevent self-deactivation
  if (req.params.id === req.user._id.toString()) {
    const error = new Error('Admins cannot change their own active status.');
    error.statusCode = 400;
    throw error;
  }

  const user = await User.findByIdAndUpdate(
    req.params.id,
    { isActive },
    { new: true, runValidators: true }
  );

  if (!user) {
    const error = new Error('User not found.');
    error.statusCode = 404;
    throw error;
  }

  res.status(200).json({
    success: true,
    message: `User account has been ${isActive ? 'activated' : 'deactivated'}.`,
    data: { user },
  });
});

module.exports = { getAllUsers, getUserById, updateUserStatus };
