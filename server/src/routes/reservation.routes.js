const express = require('express');
const {
  createReservation,
  getMyReservations,
  getMyReservationById,
  getShopReservations,
  cancelMyReservation,
  cancelShopReservation,
  pickupShopReservation,
  expireShopReservations,
} = require('../controllers/reservation.controller');
const { protect, authorize } = require('../middlewares/auth.middleware');
const { resolveSellerShop } = require('../middlewares/shop.middleware');
const validate = require('../middlewares/validate.middleware');
const {
  createReservationRules,
  reservationListRules,
  reservationIdParamRules,
} = require('../validators/reservation.validators');

const router = express.Router();

// All reservation routes require authentication; role is enforced per route.
router.use(protect);

// ─── Customer routes ─────────────────────────────────────────────────────────
// Static paths MUST precede any dynamic ':id' route.

// POST /api/v1/reservations — create a reservation for the authenticated customer
router.post(
  '/',
  authorize('customer'),
  createReservationRules,
  validate,
  createReservation
);

// GET /api/v1/reservations/mine — list the customer's own reservations
router.get(
  '/mine',
  authorize('customer'),
  reservationListRules,
  validate,
  getMyReservations
);

// GET /api/v1/reservations/mine/:id — one of the customer's own reservations
router.get(
  '/mine/:id',
  authorize('customer'),
  reservationIdParamRules,
  getMyReservationById
);

// PATCH /api/v1/reservations/mine/:id/cancel — cancel one of the customer's own
router.patch(
  '/mine/:id/cancel',
  authorize('customer'),
  reservationIdParamRules,
  cancelMyReservation
);

// ─── Seller routes ───────────────────────────────────────────────────────────
// Static paths MUST precede any dynamic ':id' route.

// POST /api/v1/reservations/shop/expire — seller-triggered expiry sweep (own shop)
// Settlement (cancel/pickup) must stay possible even if the shop is later
// unverified, otherwise stock would be stranded until it expires — hence
// requireVerified: false, matching the seller read endpoint.
router.post(
  '/shop/expire',
  authorize('seller'),
  resolveSellerShop({ requireVerified: false }),
  expireShopReservations
);

// GET /api/v1/reservations/shop — reservations for the seller's own shop
router.get(
  '/shop',
  authorize('seller'),
  resolveSellerShop({ requireVerified: false }),
  reservationListRules,
  validate,
  getShopReservations
);

// PATCH /api/v1/reservations/shop/:id/cancel — seller cancels own shop's reservation
router.patch(
  '/shop/:id/cancel',
  authorize('seller'),
  resolveSellerShop({ requireVerified: false }),
  reservationIdParamRules,
  cancelShopReservation
);

// PATCH /api/v1/reservations/shop/:id/pickup — seller fulfils own shop's reservation
router.patch(
  '/shop/:id/pickup',
  authorize('seller'),
  resolveSellerShop({ requireVerified: false }),
  reservationIdParamRules,
  pickupShopReservation
);

module.exports = router;
