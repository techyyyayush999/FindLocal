const Inventory = require('../models/Inventory.model');
const Product = require('../models/Product.model');
const asyncHandler = require('../utils/asyncHandler');
const { PRODUCT_STATUSES } = require('../constants/productConstants');
const {
  INVENTORY_BOUNDS,
  PAGINATION_DEFAULTS,
  PRODUCT_POPULATE_SELECT,
} = require('../constants/inventoryConstants');

// ─── Helper: parse pagination params ────────────────────────────────────────
function parsePagination(query) {
  let page = parseInt(query.page, 10) || PAGINATION_DEFAULTS.PAGE;
  let limit = parseInt(query.limit, 10) || PAGINATION_DEFAULTS.LIMIT;

  if (page < 1) page = 1;
  if (limit < 1) limit = 1;
  if (limit > PAGINATION_DEFAULTS.MAX_LIMIT) limit = PAGINATION_DEFAULTS.MAX_LIMIT;

  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/v1/inventory — Create Inventory Entry
// ══════════════════════════════════════════════════════════════════════════════
const createInventory = asyncHandler(async (req, res) => {
  const shopId = req.shop._id;
  const { product: productId, pricePaise, quantity, isActive } = req.body;

  // Verify the referenced product exists and is ACTIVE
  const product = await Product.findById(productId).select('_id status').lean();

  if (!product) {
    const error = new Error('Product not found.');
    error.statusCode = 404;
    throw error;
  }

  if (product.status !== PRODUCT_STATUSES.ACTIVE) {
    const error = new Error('Only products with status ACTIVE can be added to inventory.');
    error.statusCode = 400;
    throw error;
  }

  // Build document from whitelisted fields only
  const inventoryData = {
    shop: shopId,
    product: productId,
    pricePaise,
    reservedQuantity: 0,
  };

  if (quantity !== undefined) inventoryData.quantity = quantity;
  if (isActive !== undefined) inventoryData.isActive = isActive;

  try {
    const entry = await Inventory.create(inventoryData);

    // Populate product fields for response
    await entry.populate('product', PRODUCT_POPULATE_SELECT);

    res.status(201).json({
      success: true,
      message: 'Inventory entry created successfully.',
      data: { inventory: entry },
    });
  } catch (err) {
    // Handle E11000 duplicate key: shop + product compound unique index
    if (err.code === 11000) {
      return res.status(409).json({
        success: false,
        message: 'This product is already listed in your shop inventory.',
      });
    }
    throw err;
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/v1/inventory — List Seller's Inventory (paginated)
// ══════════════════════════════════════════════════════════════════════════════
const getInventory = asyncHandler(async (req, res) => {
  const shopId = req.shop._id;
  const { page, limit, skip } = parsePagination(req.query);

  const filter = { shop: shopId };

  const [entries, total] = await Promise.all([
    Inventory.find(filter)
      .populate('product', PRODUCT_POPULATE_SELECT)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Inventory.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    count: entries.length,
    total,
    page,
    pages: Math.ceil(total / limit),
    data: { inventory: entries },
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/v1/inventory/:id — Get Single Inventory Entry
// ══════════════════════════════════════════════════════════════════════════════
const getInventoryById = asyncHandler(async (req, res) => {
  const shopId = req.shop._id;

  const entry = await Inventory.findOne({
    _id: req.params.id,
    shop: shopId,
  }).populate('product', PRODUCT_POPULATE_SELECT);

  if (!entry) {
    const error = new Error('Inventory entry not found.');
    error.statusCode = 404;
    throw error;
  }

  res.status(200).json({
    success: true,
    data: { inventory: entry },
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// PATCH /api/v1/inventory/:id — Update Price / Active Status
// ══════════════════════════════════════════════════════════════════════════════
const updateInventory = asyncHandler(async (req, res) => {
  const shopId = req.shop._id;
  const { pricePaise, isActive } = req.body;

  // Determine if this is a deactivation-only update
  // (deactivation is allowed even on unverified shops — handled in route middleware)
  // But price updates require a verified shop — enforced by middleware config

  // Build $set from whitelisted fields only
  const updateFields = {};
  if (pricePaise !== undefined) updateFields.pricePaise = pricePaise;
  if (isActive !== undefined) updateFields.isActive = isActive;

  const entry = await Inventory.findOneAndUpdate(
    { _id: req.params.id, shop: shopId },
    { $set: updateFields },
    { new: true, runValidators: true }
  ).populate('product', PRODUCT_POPULATE_SELECT);

  if (!entry) {
    const error = new Error('Inventory entry not found.');
    error.statusCode = 404;
    throw error;
  }

  res.status(200).json({
    success: true,
    message: 'Inventory entry updated successfully.',
    data: { inventory: entry },
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// PATCH /api/v1/inventory/:id/stock — Atomic Stock Update
// ══════════════════════════════════════════════════════════════════════════════
const updateStock = asyncHandler(async (req, res) => {
  const shopId = req.shop._id;
  const entryId = req.params.id;

  const hasQuantity = req.body.quantity !== undefined;
  const hasAdjust = req.body.adjust !== undefined;

  // ── Absolute set: { "quantity": N } ──────────────────────────────────────
  if (hasQuantity && !hasAdjust) {
    const newQuantity = req.body.quantity;

    // Atomic update: only succeeds if reservedQuantity <= newQuantity
    // This prevents setting quantity below reserved amount under concurrency.
    const entry = await Inventory.findOneAndUpdate(
      {
        _id: entryId,
        shop: shopId,
        reservedQuantity: { $lte: newQuantity },
      },
      { $set: { quantity: newQuantity } },
      { new: true, runValidators: true }
    ).populate('product', PRODUCT_POPULATE_SELECT);

    if (entry) {
      return res.status(200).json({
        success: true,
        message: 'Stock updated successfully.',
        data: { inventory: entry },
      });
    }

    // No match — distinguish between missing/foreign (404) vs constraint conflict (409)
    const exists = await Inventory.findOne({ _id: entryId, shop: shopId })
      .select('_id quantity reservedQuantity')
      .lean();

    if (!exists) {
      const error = new Error('Inventory entry not found.');
      error.statusCode = 404;
      throw error;
    }

    // Entry exists but constraint failed — reservedQuantity > newQuantity
    return res.status(409).json({
      success: false,
      message: `Cannot set quantity to ${newQuantity}. Reserved quantity is ${exists.reservedQuantity}. Quantity must be >= reserved quantity.`,
    });
  }

  // ── Relative adjustment: { "adjust": ±N } ───────────────────────────────
  if (hasAdjust && !hasQuantity) {
    const adjust = req.body.adjust;

    // Atomic conditional update using $expr to guard the invariant:
    //   0 <= reservedQuantity <= (quantity + adjust) <= 1000000
    const entry = await Inventory.findOneAndUpdate(
      {
        _id: entryId,
        shop: shopId,
        $expr: {
          $and: [
            // Resulting quantity must not go below reservedQuantity
            { $gte: [{ $add: ['$quantity', adjust] }, '$reservedQuantity'] },
            // Resulting quantity must not go below 0
            { $gte: [{ $add: ['$quantity', adjust] }, 0] },
            // Resulting quantity must not exceed MAX
            { $lte: [{ $add: ['$quantity', adjust] }, INVENTORY_BOUNDS.QUANTITY_MAX] },
          ],
        },
      },
      { $inc: { quantity: adjust } },
      { new: true, runValidators: true }
    ).populate('product', PRODUCT_POPULATE_SELECT);

    if (entry) {
      return res.status(200).json({
        success: true,
        message: 'Stock adjusted successfully.',
        data: { inventory: entry },
      });
    }

    // No match — distinguish 404 from 409
    const exists = await Inventory.findOne({ _id: entryId, shop: shopId })
      .select('_id quantity reservedQuantity')
      .lean();

    if (!exists) {
      const error = new Error('Inventory entry not found.');
      error.statusCode = 404;
      throw error;
    }

    const resultingQty = exists.quantity + adjust;
    let reason;
    if (resultingQty < 0) {
      reason = `Adjustment of ${adjust} would result in negative quantity (current: ${exists.quantity}).`;
    } else if (resultingQty < exists.reservedQuantity) {
      reason = `Adjustment of ${adjust} would drop quantity below reserved amount (current: ${exists.quantity}, reserved: ${exists.reservedQuantity}).`;
    } else {
      reason = `Adjustment of ${adjust} would exceed maximum quantity of ${INVENTORY_BOUNDS.QUANTITY_MAX} (current: ${exists.quantity}).`;
    }

    return res.status(409).json({
      success: false,
      message: `Stock adjustment failed. ${reason}`,
    });
  }

  // Should not reach here — validators enforce exactly one of quantity/adjust
  const error = new Error('Provide exactly one of "quantity" (absolute) or "adjust" (relative).');
  error.statusCode = 400;
  throw error;
});

module.exports = {
  createInventory,
  getInventory,
  getInventoryById,
  updateInventory,
  updateStock,
};
