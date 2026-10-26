const mongoose = require('mongoose');
const {
  RESERVATION_STATUSES,
  HOLD_STATES,
  RESERVATION_BOUNDS,
} = require('../constants/reservationConstants');
const { INVENTORY_BOUNDS } = require('../constants/inventoryConstants');

// ─── Internal fields excluded from every response by default ──────────────────
// holdState / holdAppliedAt / settledAt / activeKey are reservation & settlement
// internals and must never be exposed to clients.
const INTERNAL_SELECT_FALSE = { select: false };

// ─── Serialization guard: second line of defence ──────────────────────────────
// `select: false` keeps these out of normal reads; this transform guarantees they
// are stripped even if a query opts in with `.select('+field')` or a document is
// serialized after such a read.
const stripInternalFields = (doc, ret) => {
  delete ret.holdState;
  delete ret.holdAppliedAt;
  delete ret.settledAt;
  delete ret.activeKey;
  return ret;
};

const reservationSchema = new mongoose.Schema(
  {
    // ─── Parties & references (all derived server-side, never client-supplied) ─
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Reservation must belong to a customer'],
    },
    shop: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Shop',
      required: [true, 'Reservation must belong to a shop'],
    },
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: [true, 'Reservation must reference a product'],
    },
    inventory: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Inventory',
      required: [true, 'Reservation must reference an inventory entry'],
    },

    // ─── Requested units (bounded by the per-reservation cap) ────────────────
    quantity: {
      type: Number,
      required: [true, 'Quantity is required'],
      min: [RESERVATION_BOUNDS.MIN_UNITS, `Quantity must be at least ${RESERVATION_BOUNDS.MIN_UNITS}`],
      max: [RESERVATION_BOUNDS.MAX_UNITS, `Quantity cannot exceed ${RESERVATION_BOUNDS.MAX_UNITS}`],
      validate: {
        validator: Number.isInteger,
        message: 'Quantity must be an integer',
      },
    },

    // ─── Price snapshot at reservation time (paise) ───────────────────────────
    pricePaise: {
      type: Number,
      required: [true, 'Price snapshot is required'],
      min: [INVENTORY_BOUNDS.PRICE_MIN, `Price must be at least ${INVENTORY_BOUNDS.PRICE_MIN} paise`],
      max: [INVENTORY_BOUNDS.PRICE_MAX, `Price cannot exceed ${INVENTORY_BOUNDS.PRICE_MAX} paise`],
      validate: {
        validator: Number.isInteger,
        message: 'Price must be an integer (paise)',
      },
    },

    // ─── Lifecycle status ─────────────────────────────────────────────────────
    status: {
      type: String,
      enum: {
        values: Object.values(RESERVATION_STATUSES),
        message: 'Invalid reservation status',
      },
      default: RESERVATION_STATUSES.PENDING,
    },

    // ─── Stock-hold projection (internal — derived from the inventory marker) ─
    holdState: {
      type: String,
      enum: {
        values: Object.values(HOLD_STATES),
        message: 'Invalid hold state',
      },
      default: HOLD_STATES.UNCLAIMED,
      ...INTERNAL_SELECT_FALSE,
    },
    holdAppliedAt: {
      type: Date,
      ...INTERNAL_SELECT_FALSE,
    },
    settledAt: {
      type: Date,
      ...INTERNAL_SELECT_FALSE,
    },

    // ─── Expiry (120 minutes from creation) ───────────────────────────────────
    expiresAt: {
      type: Date,
      required: [true, 'Expiry timestamp is required'],
    },

    // ─── Idempotency key: "<customer>_<inventory>" while open, unset when closed
    // Enforced by a unique PARTIAL index so a duplicate create conflicts at the
    // database level instead of relying on an application-level race.
    activeKey: {
      type: String,
      ...INTERNAL_SELECT_FALSE,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true, transform: stripInternalFields },
    toObject: { virtuals: true, transform: stripInternalFields },
  }
);

// ─── One open reservation per (customer, inventory) ───────────────────────────
// Partial index only applies while activeKey is a string, so closed reservations
// (activeKey unset) never collide.
reservationSchema.index(
  { activeKey: 1 },
  {
    unique: true,
    partialFilterExpression: { activeKey: { $type: 'string' } },
    name: 'uniq_open_reservation_per_customer_inventory',
  }
);

// ─── Query Indexes ────────────────────────────────────────────────────────────
// Supports membership-driven reconciliation for a single inventory.
reservationSchema.index({ inventory: 1, holdState: 1 });
// Customer's own reservations.
reservationSchema.index({ customer: 1, status: 1 });
// Seller's shop timeline.
reservationSchema.index({ shop: 1, status: 1 });
// Expiry sweeper (later stage).
reservationSchema.index({ status: 1, expiresAt: 1 });

const Reservation = mongoose.model('Reservation', reservationSchema);

module.exports = Reservation;
