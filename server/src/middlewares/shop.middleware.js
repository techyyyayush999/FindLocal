const Shop = require('../models/Shop.model');
const asyncHandler = require('../utils/asyncHandler');

// ─── resolveSellerShop ──────────────────────────────────────────────────────────
// Looks up the authenticated seller's shop and attaches it to req.shop.
// Returns 404 if the seller has no shop.
// If `requireVerified` option is true (default), returns 403 for unverified shops.
//
// Usage:
//   router.post('/', protect, authorize('seller'), resolveSellerShop(), handler);
//   router.patch('/:id', protect, authorize('seller'), resolveSellerShop({ requireVerified: false }), handler);
const resolveSellerShop = (options = {}) => {
  const { requireVerified = true } = options;

  return asyncHandler(async (req, res, next) => {
    const shop = await Shop.findOne({ owner: req.user._id }).select('_id isVerified').lean();

    if (!shop) {
      const error = new Error('You do not have a shop. Please create a shop first.');
      error.statusCode = 404;
      return next(error);
    }

    if (requireVerified && !shop.isVerified) {
      const error = new Error('Your shop must be verified to perform this action.');
      error.statusCode = 403;
      return next(error);
    }

    // Attach the shop for downstream use
    req.shop = shop;
    next();
  });
};

module.exports = { resolveSellerShop };
