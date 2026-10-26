const mongoose = require('mongoose');
const { INVENTORY_BOUNDS } = require('../constants/inventoryConstants');

// ─── Serialization guard: never expose internal stock-hold bookkeeping ────────
const stripInternalFields = (doc, ret) => {
  delete ret.heldReservations;
  return ret;
};

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

    // ─── Internal Stock-Hold Ledger (never client-editable, never exposed) ──────
    // Per-reservation evidence that a stock hold has been applied. Mutated
    // ATOMICALLY together with reservedQuantity so a retry or reconciler can
    // always tell whether a specific reservation's claim already landed — without
    // a grace period and without double-counting. Excluded from reads by default;
    // opt in with `.select('+heldReservations')`.
    heldReservations: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Reservation' }],
      default: [],
      select: false,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true, transform: stripInternalFields },
    toObject: { virtuals: true, transform: stripInternalFields },
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
