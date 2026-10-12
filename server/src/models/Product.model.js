const mongoose = require('mongoose');
const { normalize, generateDedupeKey, generateSlug, collapseWhitespace } = require('../utils/productNormalizer');
const { PRODUCT_CATEGORIES, PRODUCT_STATUSES, VALID_GTIN_LENGTHS } = require('../constants/productConstants');

const productSchema = new mongoose.Schema(
  {
    // ─── Required Fields ────────────────────────────────────────────────────────
    name: {
      type: String,
      required: [true, 'Product name is required'],
      trim: true,
      minlength: [2, 'Product name must be at least 2 characters'],
      maxlength: [150, 'Product name cannot exceed 150 characters'],
    },

    brand: {
      type: String,
      required: [true, 'Brand is required'],
      trim: true,
      minlength: [1, 'Brand must be at least 1 character'],
      maxlength: [80, 'Brand cannot exceed 80 characters'],
    },

    category: {
      type: String,
      required: [true, 'Category is required'],
      enum: {
        values: PRODUCT_CATEGORIES,
        message: 'Invalid category: {VALUE}',
      },
    },

    // ─── Optional Fields ────────────────────────────────────────────────────────
    description: {
      type: String,
      maxlength: [2000, 'Description cannot exceed 2000 characters'],
    },

    images: {
      type: [String],
      default: undefined, // Do not store an empty array
      validate: {
        validator: function (arr) {
          return !arr || arr.length <= 5;
        },
        message: 'A product can have at most 5 images',
      },
    },

    gtin: {
      type: String,
      validate: {
        validator: function (v) {
          if (!v) return true;
          return /^\d+$/.test(v) && VALID_GTIN_LENGTHS.includes(v.length);
        },
        message: 'GTIN must contain only digits and be 8, 12, 13, or 14 characters long',
      },
    },

    // ─── Server-Generated Fields ────────────────────────────────────────────────
    slug: {
      type: String,
      unique: true,
    },

    normalizedName: {
      type: String,
    },

    normalizedBrand: {
      type: String,
    },

    dedupeKey: {
      type: String,
      unique: true,
    },

    status: {
      type: String,
      enum: Object.values(PRODUCT_STATUSES),
      default: PRODUCT_STATUSES.PENDING,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Product must have a creator'],
    },

    // ─── Moderation Fields ──────────────────────────────────────────────────────
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },

    reviewedAt: {
      type: Date,
    },

    rejectionReason: {
      type: String,
      maxlength: [300, 'Rejection reason cannot exceed 300 characters'],
    },
  },
  {
    timestamps: true, // Adds createdAt and updatedAt automatically
  }
);

// ─── Pre-save Hook: Compute derived fields ──────────────────────────────────
productSchema.pre('save', function (next) {
  // Collapse whitespace on name and brand
  if (this.isModified('name')) {
    this.name = collapseWhitespace(this.name);
    this.normalizedName = normalize(this.name);
  }

  if (this.isModified('brand')) {
    this.brand = collapseWhitespace(this.brand);
    this.normalizedBrand = normalize(this.brand);
  }

  // Recompute dedupeKey if name or brand changed
  if (this.isModified('name') || this.isModified('brand')) {
    this.dedupeKey = generateDedupeKey(this.normalizedBrand, this.normalizedName);
  }

  // Slug is generated only for new documents and remains stable thereafter.
  // (The controller sets a unique slug on create; this is a safety net for
  // direct model usage.)
  if (this.isNew && !this.slug) {
    this.slug = generateSlug(this.brand, this.name);
  }

  // Validate name contains at least one letter or digit
  if (this.isModified('name') && this.name) {
    if (!/[\p{L}\p{N}]/u.test(this.name)) {
      const err = new Error('Product name must contain at least one letter or digit');
      err.statusCode = 400;
      return next(err);
    }
  }

  // Deduplicate images
  if (this.isModified('images') && this.images && this.images.length > 0) {
    this.images = [...new Set(this.images)];
  }

  // Strip empty GTIN to avoid storing an empty string
  if (this.isModified('gtin') && this.gtin === '') {
    this.gtin = undefined;
  }

  next();
});

// ─── Indexes ────────────────────────────────────────────────────────────────
// { slug: 1 } unique — declared in schema
// { dedupeKey: 1 } unique — declared in schema

// Partial unique index on GTIN: only enforce uniqueness when gtin is a non-empty string
productSchema.index(
  { gtin: 1 },
  {
    unique: true,
    partialFilterExpression: { gtin: { $type: 'string' } },
  }
);

// Compound indexes for efficient querying
productSchema.index({ status: 1, category: 1, createdAt: -1 });
productSchema.index({ createdBy: 1, createdAt: -1 });

const Product = mongoose.model('Product', productSchema);

module.exports = Product;
