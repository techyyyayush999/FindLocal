const mongoose = require('mongoose');
const { INVENTORY_BOUNDS } = require('../constants/inventoryConstants');

const inventorySchema = new mongoose.Schema(
  {
    // ─── Shop Reference (derived server-side, never client-supplied) ────────────
    shop: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Shop',
      required: [true, 'Inventory entry must belong to a shop'],
    },

    // ─── Product Reference ──────────────────────────────────────────────────────
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: [true, 'Inventory entry must reference a product'],
    },

    // ─── Price in Paise (integer, min 1, max 100000000) ─────────────────────────
    pricePaise: {
      type: Number,
      required: [true, 'Price is required'],
      min: [INVENTORY_BOUNDS.PRICE_MIN, `Price must be at least ${INVENTORY_BOUNDS.PRICE_MIN} paise`],
      max: [INVENTORY_BOUNDS.PRICE_MAX, `Price cannot exceed ${INVENTORY_BOUNDS.PRICE_MAX} paise`],
      validate: {
        validator: Number.isInteger,
        message: 'Price must be an integer (paise)',
      },
    },

    // ─── Stock Quantity ─────────────────────────────────────────────────────────
    quantity: {
      type: Number,
      default: 0,
      min: [INVENTORY_BOUNDS.QUANTITY_MIN, 'Quantity cannot be negative'],
      max: [INVENTORY_BOUNDS.QUANTITY_MAX, `Quantity cannot exceed ${INVENTORY_BOUNDS.QUANTITY_MAX}`],
      validate: {
        validator: Number.isInteger,
        message: 'Quantity must be an integer',
      },
    },

    // ─── Reserved Quantity (never client-editable) ──────────────────────────────
    reservedQuantity: {
      type: Number,
      default: 0,
      min: [0, 'Reserved quantity cannot be negative'],
      validate: {
        validator: Number.isInteger,
        message: 'Reserved quantity must be an integer',
      },
    },

    // ─── Active Flag ────────────────────────────────────────────────────────────
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// ─── Virtual: availableQuantity ───────────────────────────────────────────────
// Not stored — computed on the fly from quantity - reservedQuantity.
inventorySchema.virtual('availableQuantity').get(function () {
  return this.quantity - this.reservedQuantity;
});

// ─── Unique Compound Index ──────────────────────────────────────────────────────
// Each shop can list a given product only once.
inventorySchema.index({ shop: 1, product: 1 }, { unique: true });

// ─── Query Indexes ──────────────────────────────────────────────────────────────
inventorySchema.index({ shop: 1, createdAt: -1 });

const Inventory = mongoose.model('Inventory', inventorySchema);

module.exports = Inventory;
