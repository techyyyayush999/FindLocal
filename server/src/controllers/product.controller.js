const Product = require('../models/Product.model');
const asyncHandler = require('../utils/asyncHandler');
const { generateSlug } = require('../utils/productNormalizer');
const {
  PRODUCT_STATUSES,
  ALLOWED_STATUS_TRANSITIONS,
  PRODUCT_EDITABLE_FIELDS,
  PAGINATION_DEFAULTS,
} = require('../constants/productConstants');

// ─── Helper: sanitize product for response ──────────────────────────────────
// Strips internal/moderation fields based on the requesting user's role
// and ownership.
function sanitizeProduct(product, reqUser) {
  const obj = product.toObject ? product.toObject() : { ...product };

  const isAdmin = reqUser && reqUser.role === 'admin';
  const isOwner =
    reqUser && obj.createdBy && reqUser._id.toString() === obj.createdBy.toString();

  // Fields always hidden from non-admin, non-owner responses
  delete obj.normalizedName;
  delete obj.normalizedBrand;
  delete obj.dedupeKey;
  delete obj.__v;

  if (!isAdmin && !isOwner) {
    delete obj.createdBy;
    delete obj.reviewedBy;
    delete obj.reviewedAt;
    delete obj.rejectionReason;
  }

  // Owner (seller) can see their own moderation info but not reviewedBy details
  if (isOwner && !isAdmin) {
    delete obj.reviewedBy;
  }

  return obj;
}

// ─── Helper: generate unique slug with bounded retry ────────────────────────
async function generateUniqueSlug(brand, name, excludeId = null) {
  const baseSlug = generateSlug(brand, name);
  const MAX_RETRIES = 5;

  for (let i = 0; i < MAX_RETRIES; i++) {
    const candidate = i === 0 ? baseSlug : `${baseSlug}-${i}`;
    const query = { slug: candidate };
    if (excludeId) query._id = { $ne: excludeId };

    const existing = await Product.findOne(query).select('_id').lean();
    if (!existing) return candidate;
  }

  // Fallback: append timestamp for uniqueness
  return `${baseSlug}-${Date.now()}`;
}

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

// ─── Helper: handle E11000 duplicate key errors ─────────────────────────────
// Returns a structured conflict response, respecting visibility rules.
async function handleDuplicateKeyError(err, res) {
  if (err.code !== 11000) return false;

  const keyPattern = err.keyPattern || {};
  const keyValue = err.keyValue || {};

  // Determine which field caused the duplicate
  if (keyPattern.dedupeKey) {
    // Look up existing product to check status for safe info disclosure
    const existing = await Product.findOne({ dedupeKey: keyValue.dedupeKey })
      .select('_id name slug status')
      .lean();

    if (existing && existing.status === PRODUCT_STATUSES.ACTIVE) {
      return res.status(409).json({
        success: false,
        message: 'A product with this name and brand already exists.',
        data: {
          existingProduct: {
            _id: existing._id,
            name: existing.name,
            slug: existing.slug,
          },
        },
      });
    }

    // Non-ACTIVE: generic message, no info leakage
    return res.status(409).json({
      success: false,
      message: 'A product with this name and brand combination already exists.',
    });
  }

  if (keyPattern.slug) {
    return res.status(409).json({
      success: false,
      message: 'A product with a conflicting slug already exists. Please try again.',
    });
  }

  if (keyPattern.gtin) {
    const existing = await Product.findOne({ gtin: keyValue.gtin })
      .select('_id name slug status')
      .lean();

    if (existing && existing.status === PRODUCT_STATUSES.ACTIVE) {
      return res.status(409).json({
        success: false,
        message: 'A product with this GTIN already exists.',
        data: {
          existingProduct: {
            _id: existing._id,
            name: existing.name,
            slug: existing.slug,
          },
        },
      });
    }

    return res.status(409).json({
      success: false,
      message: 'A product with this GTIN already exists.',
    });
  }

  // Generic fallback for unknown unique fields
  const field = Object.keys(keyPattern)[0] || 'field';
  return res.status(409).json({
    success: false,
    message: `A record with this ${field} already exists.`,
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/v1/products — Create Product
// ══════════════════════════════════════════════════════════════════════════════
const createProduct = asyncHandler(async (req, res) => {
  const { name, brand, category, description, images, gtin } = req.body;
  const user = req.user;

  // Determine initial status based on role
  const status =
    user.role === 'admin' ? PRODUCT_STATUSES.ACTIVE : PRODUCT_STATUSES.PENDING;

  // Build product data from whitelisted fields only
  const productData = {
    name,
    brand,
    category,
    createdBy: user._id,
    status,
  };

  if (description !== undefined) productData.description = description;
  if (images !== undefined) productData.images = images;
  if (gtin !== undefined && gtin !== '') productData.gtin = gtin;

  // Generate a unique slug before save (pre-save hook computes other derived fields)
  productData.slug = await generateUniqueSlug(brand, name);

  try {
    const product = await Product.create(productData);

    res.status(201).json({
      success: true,
      message: 'Product created successfully.',
      data: { product: sanitizeProduct(product, user) },
    });
  } catch (err) {
    // Handle E11000 duplicate key errors with proper disclosure rules
    if (err.code === 11000) {
      return handleDuplicateKeyError(err, res);
    }
    throw err;
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/v1/products — List ACTIVE Products (paginated)
// ══════════════════════════════════════════════════════════════════════════════
const getProducts = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);

  const filter = { status: PRODUCT_STATUSES.ACTIVE };

  // Category filter (already validated and sanitized by middleware)
  if (req.query.category && typeof req.query.category === 'string') {
    filter.category = req.query.category;
  }

  const [products, total] = await Promise.all([
    Product.find(filter)
      .select('-normalizedName -normalizedBrand -dedupeKey -createdBy -reviewedBy -reviewedAt -rejectionReason -__v')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Product.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    count: products.length,
    total,
    page,
    pages: Math.ceil(total / limit),
    data: { products },
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/v1/products/mine — Seller's Own Submissions
// ══════════════════════════════════════════════════════════════════════════════
const getMyProducts = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);

  const filter = { createdBy: req.user._id };

  // Optional status filter
  if (req.query.status && typeof req.query.status === 'string') {
    filter.status = req.query.status;
  }

  const [products, total] = await Promise.all([
    Product.find(filter)
      .select('-normalizedName -normalizedBrand -dedupeKey -reviewedBy -__v')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Product.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    count: products.length,
    total,
    page,
    pages: Math.ceil(total / limit),
    data: { products },
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/v1/products/admin — Admin Moderation Listing
// ══════════════════════════════════════════════════════════════════════════════
const getAdminProducts = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);

  // Default to PENDING for moderation workflow
  const filter = {};

  if (req.query.status && typeof req.query.status === 'string') {
    filter.status = req.query.status;
  } else {
    filter.status = PRODUCT_STATUSES.PENDING;
  }

  if (req.query.category && typeof req.query.category === 'string') {
    filter.category = req.query.category;
  }

  const [products, total] = await Promise.all([
    Product.find(filter)
      .select('-normalizedName -normalizedBrand -dedupeKey -__v')
      .populate('createdBy', 'name email role')
      .populate('reviewedBy', 'name email')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Product.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    count: products.length,
    total,
    page,
    pages: Math.ceil(total / limit),
    data: { products },
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/v1/products/:id — Product Detail
// ══════════════════════════════════════════════════════════════════════════════
const getProductById = asyncHandler(async (req, res) => {
  const product = await Product.findById(req.params.id);

  if (!product) {
    const error = new Error('Product not found.');
    error.statusCode = 404;
    throw error;
  }

  const user = req.user;
  const isAdmin = user.role === 'admin';
  const isOwner = product.createdBy.toString() === user._id.toString();

  // Non-ACTIVE products: only creator or admin can see
  if (product.status !== PRODUCT_STATUSES.ACTIVE && !isAdmin && !isOwner) {
    const error = new Error('Product not found.');
    error.statusCode = 404;
    throw error;
  }

  res.status(200).json({
    success: true,
    data: { product: sanitizeProduct(product, user) },
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// PATCH /api/v1/products/:id — Update Product
// ══════════════════════════════════════════════════════════════════════════════
const updateProduct = asyncHandler(async (req, res) => {
  const product = await Product.findById(req.params.id);

  if (!product) {
    const error = new Error('Product not found.');
    error.statusCode = 404;
    throw error;
  }

  const user = req.user;
  const isAdmin = user.role === 'admin';
  const isOwner = product.createdBy.toString() === user._id.toString();

  // SELLER: can only edit own PENDING or REJECTED products
  if (!isAdmin) {
    if (!isOwner) {
      const error = new Error('You do not have permission to edit this product.');
      error.statusCode = 403;
      throw error;
    }

    if (
      product.status !== PRODUCT_STATUSES.PENDING &&
      product.status !== PRODUCT_STATUSES.REJECTED
    ) {
      const error = new Error(
        `You can only edit products with status PENDING or REJECTED. Current status: ${product.status}.`
      );
      error.statusCode = 403;
      throw error;
    }
  }

  // Apply only whitelisted fields
  for (const field of PRODUCT_EDITABLE_FIELDS) {
    if (req.body[field] !== undefined) {
      // Handle gtin removal: empty string → remove
      if (field === 'gtin' && req.body[field] === '') {
        product.gtin = undefined;
      } else {
        product[field] = req.body[field];
      }
    }
  }

  // Slug stays stable after creation — name/brand changes never overwrite it.

  // If a seller edits a REJECTED product, resubmit as PENDING
  if (!isAdmin && product.status === PRODUCT_STATUSES.REJECTED) {
    product.status = PRODUCT_STATUSES.PENDING;
    product.rejectionReason = undefined;
    product.reviewedBy = undefined;
    product.reviewedAt = undefined;
  }

  try {
    const updatedProduct = await product.save();

    res.status(200).json({
      success: true,
      message: 'Product updated successfully.',
      data: { product: sanitizeProduct(updatedProduct, user) },
    });
  } catch (err) {
    if (err.code === 11000) {
      return handleDuplicateKeyError(err, res);
    }
    throw err;
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// PATCH /api/v1/products/:id/status — Admin Status Transition
// ══════════════════════════════════════════════════════════════════════════════
const updateProductStatus = asyncHandler(async (req, res) => {
  const product = await Product.findById(req.params.id);

  if (!product) {
    const error = new Error('Product not found.');
    error.statusCode = 404;
    throw error;
  }

  const { status: newStatus, rejectionReason } = req.body;
  const currentStatus = product.status;

  // Validate transition
  const allowedTargets = ALLOWED_STATUS_TRANSITIONS[currentStatus];
  if (!allowedTargets || !allowedTargets.includes(newStatus)) {
    const error = new Error(
      `Invalid status transition from ${currentStatus} to ${newStatus}.`
    );
    error.statusCode = 409;
    throw error;
  }

  // Apply status change
  product.status = newStatus;
  product.reviewedBy = req.user._id;
  product.reviewedAt = new Date();

  if (newStatus === PRODUCT_STATUSES.REJECTED) {
    product.rejectionReason = rejectionReason;
  } else {
    // Clear rejection fields when moving away from REJECTED
    product.rejectionReason = undefined;
  }

  const updatedProduct = await product.save();

  res.status(200).json({
    success: true,
    message: `Product status updated to ${newStatus}.`,
    data: { product: sanitizeProduct(updatedProduct, req.user) },
  });
});

module.exports = {
  createProduct,
  getProducts,
  getMyProducts,
  getAdminProducts,
  getProductById,
  updateProduct,
  updateProductStatus,
};
