const Shop = require('../models/Shop.model');
const asyncHandler = require('../utils/asyncHandler');

// ─── Helper: build a safe location object from flat lat/lng fields ─────────────
// Accepts req.body.longitude and req.body.latitude (numbers).
// Returns a GeoJSON Point or undefined if neither is supplied.
// The controller always sets type: "Point" server-side — the client never
// provides the GeoJSON shape directly.
function buildLocation(body) {
  const lng = parseFloat(body.longitude);
  const lat = parseFloat(body.latitude);

  // Only build a location when both coordinates are present
  if (body.longitude === undefined && body.latitude === undefined) {
    return undefined;
  }

  return {
    type: 'Point',           // Always set server-side
    coordinates: [lng, lat], // GeoJSON order: [longitude, latitude]
  };
}

// ─── Helper: format raw distance in meters to a readable string ────────────────
function formatDistance(meters) {
  if (meters >= 1000) {
    return `${(meters / 1000).toFixed(1)} km`;
  }
  return `${Math.round(meters)} m`;
}

// ══════════════════════════════════════════════════════════════════════════════
// SELLER ENDPOINTS
// ══════════════════════════════════════════════════════════════════════════════

// ─── POST /api/v1/seller/shops ────────────────────────────────────────────────
// Creates a new shop for the authenticated seller.
// Enforces one-shop-per-seller at the DB level (unique owner index).
const createShop = asyncHandler(async (req, res) => {
  const existing = await Shop.findOne({ owner: req.user._id });
  if (existing) {
    const error = new Error('You already have a shop. A seller can only have one shop.');
    error.statusCode = 409;
    throw error;
  }

  // Pull only the safe, user-editable fields from req.body.
  // Never pass req.body directly to avoid mass-assignment of protected fields.
  const { name, description, address, phone, isOpen } = req.body;

  // Build the shop document
  const shopData = {
    owner: req.user._id, // Always taken from the authenticated session
    name,
    description,
    address,
    phone,
    isOpen,
  };

  // Attach location (buildLocation always returns valid Point since coords are required on create)
  shopData.location = buildLocation(req.body);

  const shop = await Shop.create(shopData);

  res.status(201).json({
    success: true,
    message: 'Shop created successfully.',
    data: { shop },
  });
});

// ─── GET /api/v1/seller/shops/me ─────────────────────────────────────────────
// Returns the authenticated seller's own shop.
const getMyShop = asyncHandler(async (req, res) => {
  const shop = await Shop.findOne({ owner: req.user._id });

  if (!shop) {
    const error = new Error('You do not have a shop yet.');
    error.statusCode = 404;
    throw error;
  }

  res.status(200).json({
    success: true,
    data: { shop },
  });
});

// ─── PUT /api/v1/seller/shops/me ─────────────────────────────────────────────
// Updates the authenticated seller's own shop.
// Protected fields (owner, isVerified, verifiedAt, verifiedBy) are never
// touched — they are explicitly excluded from the update object.
const updateMyShop = asyncHandler(async (req, res) => {
  const shop = await Shop.findOne({ owner: req.user._id });

  if (!shop) {
    const error = new Error('You do not have a shop yet. Create one first.');
    error.statusCode = 404;
    throw error;
  }

  // Build update object from safe fields only — no mass-assignment
  const { name, description, address, phone, isOpen } = req.body;

  if (name !== undefined)        shop.name        = name;
  if (description !== undefined) shop.description = description;
  if (address !== undefined)     shop.address     = address;
  if (phone !== undefined)       shop.phone       = phone;
  if (isOpen !== undefined)      shop.isOpen      = isOpen;

  // Update location only when coordinates are explicitly supplied
  const location = buildLocation(req.body);
  if (location) {
    shop.location = location;
  }

  // Note: owner, isVerified, verifiedAt, verifiedBy are never assigned here
  const updatedShop = await shop.save();

  res.status(200).json({
    success: true,
    message: 'Shop updated successfully.',
    data: { shop: updatedShop },
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// CUSTOMER ENDPOINTS (verified shops only)
// ══════════════════════════════════════════════════════════════════════════════

// ─── GET /api/v1/shops ────────────────────────────────────────────────────────
// Returns all verified shops. Customers cannot see unverified shops.
const getAllShops = asyncHandler(async (req, res) => {
  const shops = await Shop.find({ isVerified: true }).sort({ createdAt: -1 });

  res.status(200).json({
    success: true,
    count: shops.length,
    data: { shops },
  });
});

// ─── GET /api/v1/shops/:id ────────────────────────────────────────────────────
// Returns a single shop by ID, only if it is verified.
const getShopById = asyncHandler(async (req, res) => {
  const shop = await Shop.findOne({ _id: req.params.id, isVerified: true });

  if (!shop) {
    const error = new Error('Shop not found.');
    error.statusCode = 404;
    throw error;
  }

  res.status(200).json({
    success: true,
    data: { shop },
  });
});

// ─── GET /api/v1/shops/nearby ─────────────────────────────────────────────────
// Returns verified shops sorted by distance from the supplied coordinates.
// Query params: lat (required), lng (required), radius (optional, default 5000 m)
//
// Uses MongoDB $geoNear aggregation (MUST be the first pipeline stage).
// Filters for verified shops INSIDE the $geoNear query (not a $match after).
const getNearbyShops = asyncHandler(async (req, res) => {
  const lat    = parseFloat(req.query.lat);
  const lng    = parseFloat(req.query.lng);
  const radius = req.query.radius ? parseFloat(req.query.radius) : 5000;

  // $geoNear must be the first aggregation stage
  const pipeline = [
    {
      $geoNear: {
        near: {
          type: 'Point',
          coordinates: [lng, lat], // GeoJSON order: [longitude, latitude]
        },
        distanceField: 'distance',   // Distance in meters added to each document
        maxDistance: radius,          // Maximum search radius in meters
        spherical: true,              // Use spherical geometry (WGS84)
        query: { isVerified: true },  // Filter verified shops inside $geoNear
      },
    },
  ];

  const shops = await Shop.aggregate(pipeline);

  // Attach a human-readable distance string to each result
  const shopsWithFormattedDistance = shops.map((shop) => ({
    ...shop,
    distanceFormatted: formatDistance(shop.distance),
  }));

  res.status(200).json({
    success: true,
    count: shopsWithFormattedDistance.length,
    data: { shops: shopsWithFormattedDistance },
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// ADMIN ENDPOINTS
// ══════════════════════════════════════════════════════════════════════════════

// ─── GET /api/v1/admin/shops ──────────────────────────────────────────────────
// Returns all shops (verified and unverified) for admin visibility.
const adminGetAllShops = asyncHandler(async (req, res) => {
  const shops = await Shop.find()
    .populate('owner', 'name email role')
    .populate('verifiedBy', 'name email')
    .sort({ createdAt: -1 });

  res.status(200).json({
    success: true,
    count: shops.length,
    data: { shops },
  });
});

// ─── GET /api/v1/admin/shops/:id ──────────────────────────────────────────────
// Returns any shop by ID (verified or not) for admin use.
const adminGetShopById = asyncHandler(async (req, res) => {
  const shop = await Shop.findById(req.params.id)
    .populate('owner', 'name email role')
    .populate('verifiedBy', 'name email');

  if (!shop) {
    const error = new Error('Shop not found.');
    error.statusCode = 404;
    throw error;
  }

  res.status(200).json({
    success: true,
    data: { shop },
  });
});

// ─── PATCH /api/v1/admin/shops/:id/verify ─────────────────────────────────────
// Marks a shop as verified. Rejects if the shop is already verified.
const adminVerifyShop = asyncHandler(async (req, res) => {
  const shop = await Shop.findById(req.params.id);

  if (!shop) {
    const error = new Error('Shop not found.');
    error.statusCode = 404;
    throw error;
  }

  if (shop.isVerified) {
    const error = new Error('Shop is already verified.');
    error.statusCode = 400;
    throw error;
  }

  // Set verification fields — admin identity comes from req.user (set by protect)
  shop.isVerified  = true;
  shop.verifiedAt  = new Date();
  shop.verifiedBy  = req.user._id;

  const verifiedShop = await shop.save();

  res.status(200).json({
    success: true,
    message: 'Shop has been verified successfully.',
    data: { shop: verifiedShop },
  });
});

module.exports = {
  createShop,
  getMyShop,
  updateMyShop,
  getAllShops,
  getShopById,
  getNearbyShops,
  adminGetAllShops,
  adminGetShopById,
  adminVerifyShop,
};
