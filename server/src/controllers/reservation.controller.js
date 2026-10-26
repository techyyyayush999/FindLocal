const Reservation = require('../models/Reservation.model');
const asyncHandler = require('../utils/asyncHandler');
const reservationService = require('../services/reservation.service');
const { PAGINATION_DEFAULTS } = require('../constants/productConstants');

// ─── Error helper (matches controller convention: statusCode + message) ───────
const httpError = (statusCode, message) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

// ─── Map a settlement outcome that is not `ok` onto an HTTP error ─────────────
// `verb` is 'cancel' or 'pick up' so the messages stay distinct and specific.
function settlementError(outcome, verb) {
  switch (outcome.reason) {
    case 'EXPIRED':
      return httpError(
        409,
        'This reservation has expired and can no longer be picked up.'
      );
    case 'NOT_ACTIVE':
      return httpError(409, 'This reservation is not ready for pickup yet.');
    case 'ALREADY_CONSUMED':
      return httpError(
        409,
        'This reservation has already been fulfilled and can no longer be cancelled.'
      );
    case 'CONFLICT':
      return httpError(
        409,
        `This reservation is ${String(outcome.status).toLowerCase()} and cannot be ${verb}.`
      );
    default:
      return httpError(409, `This reservation cannot be ${verb}.`);
  }
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

// ─── Response projections ───────────────────────────────────────────────────
// Only non-internal fields are ever selected into a response. Internal
// settlement markers (holdState / holdAppliedAt / settledAt / activeKey) are
// `select: false` on the model, and `stripInternalFields` removes them from
// serialization as a second line of defence.
const CUSTOMER_POPULATE = [
  { path: 'product', select: 'name brand category images slug status' },
  { path: 'shop', select: 'name address isOpen' },
];

const SELLER_POPULATE = [
  { path: 'product', select: 'name brand category images slug status' },
  { path: 'customer', select: 'name email' },
];

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/v1/reservations — Create Reservation (authenticated customer)
// The customer is taken from the authenticated session, never from the body.
// ══════════════════════════════════════════════════════════════════════════════
const createReservation = asyncHandler(async (req, res) => {
  const reservation = await reservationService.createReservation({
    customerId: req.user._id,
    inventoryId: req.body.inventory,
    quantity: req.body.quantity,
  });

  await reservation.populate(CUSTOMER_POPULATE);

  res.status(201).json({
    success: true,
    message: 'Reservation created successfully.',
    data: { reservation },
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/v1/reservations/mine — List the customer's own reservations
// ══════════════════════════════════════════════════════════════════════════════
const getMyReservations = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const filter = { customer: req.user._id };

  const [reservations, total] = await Promise.all([
    Reservation.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate(CUSTOMER_POPULATE),
    Reservation.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    count: reservations.length,
    total,
    page,
    pages: Math.ceil(total / limit),
    data: { reservations },
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/v1/reservations/mine/:id — Get one of the customer's reservations
// Scoped by `customer`, so another customer's reservation is indistinguishable
// from a non-existent one (404).
// ══════════════════════════════════════════════════════════════════════════════
const getMyReservationById = asyncHandler(async (req, res) => {
  const reservation = await Reservation.findOne({
    _id: req.params.id,
    customer: req.user._id,
  }).populate(CUSTOMER_POPULATE);

  if (!reservation) {
    const error = new Error('Reservation not found.');
    error.statusCode = 404;
    throw error;
  }

  res.status(200).json({
    success: true,
    data: { reservation },
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/v1/reservations/shop — List reservations for the seller's own shop
// Scoped by `req.shop._id` (resolved from the authenticated seller), so a seller
// can never read another shop's reservations.
// ══════════════════════════════════════════════════════════════════════════════
const getShopReservations = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const filter = { shop: req.shop._id };

  const [reservations, total] = await Promise.all([
    Reservation.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate(SELLER_POPULATE),
    Reservation.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    count: reservations.length,
    total,
    page,
    pages: Math.ceil(total / limit),
    data: { reservations },
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// PATCH /api/v1/reservations/mine/:id/cancel — customer cancels their own
// Scoped by `customer`, so another customer's reservation is a 404 (indistinguish-
// able from non-existent). Idempotent: repeating a cancel returns 200.
// ══════════════════════════════════════════════════════════════════════════════
const cancelMyReservation = asyncHandler(async (req, res) => {
  const reservation = await Reservation.findOne({
    _id: req.params.id,
    customer: req.user._id,
  });
  if (!reservation) {
    throw httpError(404, 'Reservation not found.');
  }

  const outcome = await reservationService.settleReservation(
    reservation._id,
    'CANCEL'
  );
  if (!outcome.ok) {
    throw settlementError(outcome, 'cancelled');
  }

  const updated = await Reservation.findById(reservation._id).populate(
    CUSTOMER_POPULATE
  );

  res.status(200).json({
    success: true,
    message: 'Reservation cancelled successfully.',
    data: { reservation: updated },
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// PATCH /api/v1/reservations/shop/:id/cancel — seller cancels a reservation that
// belongs to their own shop. Scoped by `shop`, so another shop's reservation is a
// 404. Idempotent.
// ══════════════════════════════════════════════════════════════════════════════
const cancelShopReservation = asyncHandler(async (req, res) => {
  const reservation = await Reservation.findOne({
    _id: req.params.id,
    shop: req.shop._id,
  });
  if (!reservation) {
    throw httpError(404, 'Reservation not found.');
  }

  const outcome = await reservationService.settleReservation(
    reservation._id,
    'CANCEL'
  );
  if (!outcome.ok) {
    throw settlementError(outcome, 'cancelled');
  }

  const updated = await Reservation.findById(reservation._id).populate(
    SELLER_POPULATE
  );

  res.status(200).json({
    success: true,
    message: 'Reservation cancelled successfully.',
    data: { reservation: updated },
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// PATCH /api/v1/reservations/shop/:id/pickup — seller fulfils an ACTIVE, unexpired
// reservation belonging to their own shop. Expired reservations are refused and
// their hold is released (never left held). Idempotent on repeat.
// ══════════════════════════════════════════════════════════════════════════════
const pickupShopReservation = asyncHandler(async (req, res) => {
  const reservation = await Reservation.findOne({
    _id: req.params.id,
    shop: req.shop._id,
  });
  if (!reservation) {
    throw httpError(404, 'Reservation not found.');
  }

  const outcome = await reservationService.settleReservation(
    reservation._id,
    'FULFILL'
  );
  if (!outcome.ok) {
    throw settlementError(outcome, 'picked up');
  }

  const updated = await Reservation.findById(reservation._id).populate(
    SELLER_POPULATE
  );

  res.status(200).json({
    success: true,
    message: 'Reservation fulfilled successfully.',
    data: { reservation: updated },
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/v1/reservations/shop/expire — seller-triggered expiry sweep, scoped to
// their own shop. Releases overdue holds exactly once and moves them to EXPIRED.
// (Expiry is an explicit sweep, never a TTL index.) Idempotent.
// ══════════════════════════════════════════════════════════════════════════════
const expireShopReservations = asyncHandler(async (req, res) => {
  const summary = await reservationService.expireReservations({
    shopId: req.shop._id,
  });

  res.status(200).json({
    success: true,
    message: `Expired ${summary.expired} reservation(s).`,
    data: { summary },
  });
});

module.exports = {
  createReservation,
  getMyReservations,
  getMyReservationById,
  getShopReservations,
  cancelMyReservation,
  cancelShopReservation,
  pickupShopReservation,
  expireShopReservations,
};
