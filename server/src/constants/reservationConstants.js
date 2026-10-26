// ─── Reservation Lifecycle Statuses ───────────────────────────────────────────
const RESERVATION_STATUSES = {
  PENDING: 'PENDING',       // created, stock claim not yet confirmed
  ACTIVE: 'ACTIVE',         // stock held, awaiting pickup
  CANCELLED: 'CANCELLED',   // cancelled by customer or seller (stock released)
  FULFILLED: 'FULFILLED',   // picked up (stock consumed)
  EXPIRED: 'EXPIRED',       // past expiresAt without pickup (stock released)
  REJECTED: 'REJECTED',     // creation failed (no stock available)
};

// Statuses during which the reservation still occupies stock and keeps its
// activeKey, so a second concurrent reservation for the same customer+inventory
// is blocked by the unique partial index.
const RESERVATION_OPEN_STATUSES = [
  RESERVATION_STATUSES.PENDING,
  RESERVATION_STATUSES.ACTIVE,
];

// Terminal statuses that never imply the customer physically took stock. A
// lingering inventory marker for one of these is healed by RELEASING the hold
// (membership-guarded decrement), never by re-claiming or re-summing.
// FULFILLED is intentionally excluded: a leftover marker there means "stock was
// taken but consume did not complete", which reconciliation must NOT guess at.
const RESERVATION_RELEASABLE_STATUSES = [
  RESERVATION_STATUSES.CANCELLED,
  RESERVATION_STATUSES.EXPIRED,
  RESERVATION_STATUSES.REJECTED,
];

// ─── Stock-Hold States (idempotency projection) ───────────────────────────────
// Derived from the internal inventory marker `heldReservations` — see
// reservation.service.js. Never the source of truth, only a fast read model.
const HOLD_STATES = {
  UNCLAIMED: 'UNCLAIMED',   // no stock claimed
  HELD: 'HELD',             // stock claimed (reservedQuantity incremented)
  RELEASED: 'RELEASED',     // claim undone (cancelled or expired)
  CONSUMED: 'CONSUMED',     // claim converted into a physical stock decrement
};

// ─── Reservation Bounds / Product Decisions (Stage 0 §8) ──────────────────────
const RESERVATION_BOUNDS = {
  MIN_UNITS: 1,
  MAX_UNITS: 10,          // max 10 units per reservation
  EXPIRY_MINUTES: 120,    // 120-minute reservation expiry
};

// ─── Fields the client is allowed to supply when creating a reservation ───────
const RESERVATION_CREATE_FIELDS = ['inventory', 'quantity'];

// ─── System-generated fields the client must never supply ─────────────────────
const RESERVATION_SYSTEM_FIELDS = [
  'customer', 'shop', 'product', 'pricePaise', 'status', 'holdState',
  'holdAppliedAt', 'settledAt', 'expiresAt', 'activeKey',
  'createdAt', 'updatedAt', '_id', '__v',
];

module.exports = {
  RESERVATION_STATUSES,
  RESERVATION_OPEN_STATUSES,
  RESERVATION_RELEASABLE_STATUSES,
  HOLD_STATES,
  RESERVATION_BOUNDS,
  RESERVATION_CREATE_FIELDS,
  RESERVATION_SYSTEM_FIELDS,
};
