const mongoose = require('mongoose');
const Inventory = require('../models/Inventory.model');
const Shop = require('../models/Shop.model');
const Product = require('../models/Product.model');
const Reservation = require('../models/Reservation.model');
const {
  RESERVATION_STATUSES,
  RESERVATION_OPEN_STATUSES,
  RESERVATION_RELEASABLE_STATUSES,
  HOLD_STATES,
  RESERVATION_BOUNDS,
} = require('../constants/reservationConstants');
const { PRODUCT_STATUSES } = require('../constants/productConstants');

// ─── Error helper (matches controller convention: statusCode + message) ───────
const httpError = (statusCode, message) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

// ══════════════════════════════════════════════════════════════════════════════
// Recovery-safe, idempotent stock-hold primitives + reservation creation
//
// Design invariants
// -----------------
// I1  A claim is applied by ONE atomic `Inventory.updateOne` whose filter both
//     (a) proves this reservation has not already claimed
//         (`heldReservations: { $ne: reservationId }`) and
//     (b) enforces availability
//         (`$expr: { $gte: [quantity - reservedQuantity, qty] }`),
//     while the payload mutates BOTH `reservedQuantity` and `heldReservations`
//     in the same document write.
// I2  "Was this reservation's claim applied?" ⇔ the reservation id is a member of
//     `inventory.heldReservations`. It never depends on the aggregate counter and
//     never needs a time window / grace period.
// I3  `reservedQuantity` and the marker set change ONLY together, inside a single
//     document write, for every operation (claim / release / consume). Therefore
//     the counter can never drift from the marker set because of a crash, and an
//     absolute `$set reservedQuantity = Σ markers` repair is NEITHER necessary
//     NOR safe (a stale-snapshot write can clobber a newer concurrent claim).
//     Reconciliation in this file therefore never assigns `reservedQuantity`; it
//     only performs membership-guarded incremental corrections.
// I4  Release and consume are membership-guarded too, so a retry matches 0 docs
//     and is a no-op. `reservedQuantity` / `quantity` can never be driven negative
//     or double-decremented by a duplicate / racing request.
// I5  `holdState` is a DERIVED projection of membership and is written ONLY when
//     the corresponding stock transition actually succeeded in this call. A crash
//     between the marker write and the state write is healed by recovery.
// I6  Reservation creation is write-ahead: a durable PENDING record (carrying its
//     `activeKey`) is committed BEFORE any stock is claimed, then the claim
//     happens, then PENDING is promoted to ACTIVE. Every intermediate crash is
//     repaired idempotently by `recoverReservation`.
//
// None of these primitives use multi-document transactions (the development
// MongoDB is standalone), and none rely on a cleanup grace period.
// ══════════════════════════════════════════════════════════════════════════════

// ─── Idempotency key builder ─────────────────────────────────────────────────
// Set while a reservation is open; must be unset when it reaches a terminal
// status so the unique partial index frees up.
const buildActiveKey = (customerId, inventoryId) =>
  `${String(customerId)}_${String(inventoryId)}`;

// ─── Membership probe: is THIS reservation's stock claim applied? ─────────────
async function isHoldApplied(inventoryId, reservationId) {
  const exists = await Inventory.exists({
    _id: inventoryId,
    heldReservations: reservationId,
  });
  return Boolean(exists);
}

// ─── Persist the derived holdState (only ever called on a real transition) ────
async function markHoldState(reservationId, holdState, extra = {}) {
  await Reservation.updateOne(
    { _id: reservationId },
    { $set: { holdState, ...extra } }
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// claimStockHold
// Atomically reserves `reservation.quantity` units for a reservation exactly
// once. Safe to call repeatedly (retries, reconciler, duplicate requests).
//
// Returns one of:
//   { applied: true }                        — stock is now held by this reservation
//   { applied: true, alreadyApplied: true }  — a previous attempt had already applied
//   { applied: false, reason: 'INSUFFICIENT_STOCK' }
//   { applied: false, reason: 'RESERVATION_NOT_OPEN' }   (terminal — never claims)
//   { applied: false, reason: 'RESERVATION_NOT_FOUND' }
// ══════════════════════════════════════════════════════════════════════════════
async function claimStockHold(reservationId) {
  const reservation = await Reservation.findById(reservationId).select(
    'inventory quantity status +holdState +holdAppliedAt'
  );
  if (!reservation) {
    return { applied: false, reason: 'RESERVATION_NOT_FOUND' };
  }

  // B3 — never claim stock on behalf of a terminal reservation.
  if (!RESERVATION_OPEN_STATUSES.includes(reservation.status)) {
    return { applied: false, reason: 'RESERVATION_NOT_OPEN' };
  }

  const inventoryId = reservation.inventory;
  const qty = reservation.quantity;

  // I1 — single atomic admission + idempotency marker.
  const claim = await Inventory.updateOne(
    {
      _id: inventoryId,
      heldReservations: { $ne: reservation._id }, // idempotency guard
      $expr: {
        $gte: [
          {
            $subtract: [
              '$quantity',
              { $ifNull: ['$reservedQuantity', 0] },
            ],
          },
          qty,
        ],
      }, // availability guard
    },
    {
      $inc: { reservedQuantity: qty },
      $addToSet: { heldReservations: reservation._id },
    }
  );

  if (claim.matchedCount === 1) {
    await markHoldState(reservation._id, HOLD_STATES.HELD, {
      holdAppliedAt: reservation.holdAppliedAt || new Date(),
    });
    return { applied: true };
  }

  // matched 0 → either already applied (retry) or genuinely insufficient stock.
  if (await isHoldApplied(inventoryId, reservation._id)) {
    await markHoldState(reservation._id, HOLD_STATES.HELD, {
      holdAppliedAt: reservation.holdAppliedAt || new Date(),
    });
    return { applied: true, alreadyApplied: true };
  }

  return { applied: false, reason: 'INSUFFICIENT_STOCK' };
}

// ══════════════════════════════════════════════════════════════════════════════
// releaseStockHold
// Undoes a claim (cancel / expiry / rejection). Membership-guarded and
// idempotent: calling it twice releases stock at most once, and it writes the
// RELEASED label only when THIS call actually performed the release.
//
// Returns:
//   { released: true }                          — this call performed the release
//   { released: false, reason: 'NOT_HELD' }     — nothing held by this reservation
//   { released: false, reason: 'ALREADY_RELEASED' }
//   { released: false, reason: 'ALREADY_CONSUMED' }
//   { released: false, reason: 'RESERVATION_NOT_FOUND' }
// ══════════════════════════════════════════════════════════════════════════════
async function releaseStockHold(reservationId) {
  const reservation = await Reservation.findById(reservationId).select(
    'inventory quantity'
  );
  if (!reservation) {
    return { released: false, reason: 'RESERVATION_NOT_FOUND' };
  }

  // I4 — only decrement if THIS reservation is actually holding stock.
  const release = await Inventory.updateOne(
    { _id: reservation.inventory, heldReservations: reservation._id },
    {
      $inc: { reservedQuantity: -reservation.quantity },
      $pull: { heldReservations: reservation._id },
    }
  );

  if (release.matchedCount === 1) {
    await markHoldState(reservation._id, HOLD_STATES.RELEASED, {
      settledAt: new Date(),
    });
    return { released: true };
  }

  // I5 — 0 matches: another terminal transition already settled this hold. Report
  // the current derived state and DO NOT overwrite it.
  const reason = await classifyUnsettledHold(reservation._id);
  return { released: false, reason };
}

// ══════════════════════════════════════════════════════════════════════════════
// consumeStockHold
// Converts a claim into a physical pickup: decrements BOTH `quantity` and
// `reservedQuantity` by the reserved amount, exactly once.
//
// Returns:
//   { consumed: true }                          — this call performed the decrement
//   { consumed: true, alreadyConsumed: true }   — previously consumed
//   { consumed: false, reason: 'INSUFFICIENT_STOCK' }
//   { consumed: false, reason: 'ALREADY_RELEASED' }
//   { consumed: false, reason: 'NOT_HELD' }
//   { consumed: false, reason: 'RESERVATION_NOT_FOUND' }
// ══════════════════════════════════════════════════════════════════════════════
async function consumeStockHold(reservationId) {
  const reservation = await Reservation.findById(reservationId).select(
    'inventory quantity'
  );
  if (!reservation) {
    return { consumed: false, reason: 'RESERVATION_NOT_FOUND' };
  }

  // I4 — membership guard makes the decrement exactly-once; the $expr guard keeps
  // `quantity` from going negative even if the caller is out of order.
  const consume = await Inventory.updateOne(
    {
      _id: reservation.inventory,
      heldReservations: reservation._id,
      $expr: { $gte: ['$quantity', reservation.quantity] },
    },
    {
      $inc: {
        quantity: -reservation.quantity,
        reservedQuantity: -reservation.quantity,
      },
      $pull: { heldReservations: reservation._id },
    }
  );

  if (consume.matchedCount === 1) {
    await markHoldState(reservation._id, HOLD_STATES.CONSUMED, {
      settledAt: new Date(),
    });
    return { consumed: true };
  }

  // Still holding → the $expr guard rejected the decrement (would underflow).
  if (await isHoldApplied(reservation.inventory, reservation._id)) {
    return { consumed: false, reason: 'INSUFFICIENT_STOCK' };
  }

  // I5 — 0 matches and no longer held: settled elsewhere. Report, never rewrite.
  const current = await Reservation.findById(reservation._id).select('+holdState');
  if (current && current.holdState === HOLD_STATES.CONSUMED) {
    return { consumed: true, alreadyConsumed: true };
  }
  if (current && current.holdState === HOLD_STATES.RELEASED) {
    return { consumed: false, reason: 'ALREADY_RELEASED' };
  }
  return { consumed: false, reason: 'NOT_HELD' };
}

// ─── Classify a reservation that is no longer holding stock ───────────────────
async function classifyUnsettledHold(reservationId) {
  const current = await Reservation.findById(reservationId).select('+holdState');
  if (current && current.holdState === HOLD_STATES.CONSUMED) {
    return 'ALREADY_CONSUMED';
  }
  if (current && current.holdState === HOLD_STATES.RELEASED) {
    return 'ALREADY_RELEASED';
  }
  return 'NOT_HELD';
}

// ─── Terminal transition: set status + unset activeKey (frees the unique index) ─
async function closeReservation(reservationId, status) {
  await Reservation.updateOne(
    { _id: reservationId },
    { $set: { status, settledAt: new Date() }, $unset: { activeKey: '' } }
  );
}

// ─── Ensure an open reservation is ACTIVE + HELD (only while still open) ──────
async function ensureActiveHeld(reservation) {
  const set = {
    status: RESERVATION_STATUSES.ACTIVE,
    holdState: HOLD_STATES.HELD,
  };
  if (!reservation.holdAppliedAt) set.holdAppliedAt = new Date();

  await Reservation.updateOne(
    { _id: reservation._id, status: { $in: RESERVATION_OPEN_STATUSES } },
    { $set: set }
  );
}

// ─── Time helper: is this reservation past its expiry instant? ────────────────
function isExpired(reservation, now = Date.now()) {
  return Boolean(reservation.expiresAt) && reservation.expiresAt.getTime() <= now;
}

// ══════════════════════════════════════════════════════════════════════════════
// recoverReservation
// Idempotently repairs a single reservation across the creation AND settlement
// crash windows:
//
//   W1      created PENDING (holdState UNCLAIMED), crash before claim
//                                                     → (re)claim, promote ACTIVE
//   W2      claimed, crash before ACTIVE promotion    → promote ACTIVE
//   W3      terminal but marker lingers               → report (see reconcileInventory)
//   W-settle open, stock already settled, crash before
//           the terminal close (Stage 4)              → FINALIZE the close, NEVER re-claim
//
// F2 — a (re)claim is permitted ONLY in W1, i.e. only for a genuinely fresh
// PENDING reservation whose `holdState` is still UNCLAIMED. Any other
// open-but-not-holding state (notably an ACTIVE reservation with no marker, or a
// marker→state write that was lost) is reported as INCONSISTENT without touching
// stock: that window overlaps with an in-flight settlement (release / consume),
// and guessing there would resurrect stock that was already released or consumed.
//
// W-settle is why settlement happens BEFORE the terminal close: a reservation that
// already released/consumed its hold reports it via the derived `holdState`
// (RELEASED / CONSUMED). Re-claiming here would resurrect cancelled stock, so it is
// forbidden — recovery completes the pending close instead.
//
// It NEVER touches stock beyond the membership-guarded claim, and it never
// rewrites a terminal reservation into an open one.
//
// Returns { status, held, reason? }:
//   'MISSING' | 'TERMINAL'
//   'PROMOTED' | 'RECLAIMED' | 'CONSISTENT'         (held: true)
//   'FINALIZED'                                      (held: false, close completed)
//   'REJECTED'                                       (held: false, stock insufficient)
//   'INCONSISTENT'                                   (held: false, needs a human)
// ══════════════════════════════════════════════════════════════════════════════
async function recoverReservation(reservationId) {
  const reservation = await Reservation.findById(reservationId).select(
    'inventory quantity status expiresAt +holdState +holdAppliedAt'
  );
  if (!reservation) {
    return { status: 'MISSING', held: false };
  }

  // Terminal reservations are never re-opened here.
  if (!RESERVATION_OPEN_STATUSES.includes(reservation.status)) {
    const held = await isHoldApplied(reservation.inventory, reservation._id);
    return { status: 'TERMINAL', held };
  }

  // Already holding → just make the derived state agree with reality.
  if (await isHoldApplied(reservation.inventory, reservation._id)) {
    if (
      reservation.status === RESERVATION_STATUSES.PENDING ||
      reservation.holdState !== HOLD_STATES.HELD
    ) {
      await ensureActiveHeld(reservation);
      return { status: 'PROMOTED', held: true };
    }
    return { status: 'CONSISTENT', held: true };
  }

  // W-settle — open but no longer holding, and the derived state says THIS
  // reservation already settled its hold. Complete the terminal close with the
  // status that settlement implies; never re-claim.
  if (reservation.holdState === HOLD_STATES.RELEASED) {
    const status = isExpired(reservation)
      ? RESERVATION_STATUSES.EXPIRED
      : RESERVATION_STATUSES.CANCELLED;
    await closeReservation(reservation._id, status);
    return { status: 'FINALIZED', held: false };
  }
  if (reservation.holdState === HOLD_STATES.CONSUMED) {
    await closeReservation(reservation._id, RESERVATION_STATUSES.FULFILLED);
    return { status: 'FINALIZED', held: false };
  }

  // F2 — Re-claim stock ONLY for a genuinely fresh PENDING reservation whose hold
  // was never applied (creation window W1: created PENDING, crashed before the
  // claim). Any OTHER open-but-not-holding state is ambiguous: an ACTIVE
  // reservation (or one whose derived state already advanced) can be a settlement
  // in flight, or a settlement whose marker write was lost in window W-settle.
  // Re-claiming there would resurrect stock that cancellation / expiry / pickup
  // already released or consumed, so we never guess — we surface it instead and
  // leave stock untouched.
  const isFreshPending =
    reservation.status === RESERVATION_STATUSES.PENDING &&
    reservation.holdState === HOLD_STATES.UNCLAIMED;

  if (!isFreshPending) {
    return {
      status: 'INCONSISTENT',
      held: false,
      reason: 'HOLD_MARKER_MISSING',
    };
  }

  // Fresh PENDING, hold never applied → claim idempotently, then promote.
  const claim = await claimStockHold(reservation._id);
  if (claim.applied) {
    await ensureActiveHeld(reservation);
    return { status: 'RECLAIMED', held: true };
  }

  if (claim.reason === 'INSUFFICIENT_STOCK') {
    await closeReservation(reservation._id, RESERVATION_STATUSES.REJECTED);
    return { status: 'REJECTED', held: false };
  }

  return { status: 'INCONSISTENT', held: false, reason: claim.reason };
}

// ══════════════════════════════════════════════════════════════════════════════
// reconcileInventory
// Marker hygiene + derived-state repair for one inventory entry.
//
// For every marker it resolves the referenced reservation and:
//   • open (PENDING/ACTIVE)      → `recoverReservation` (repair / promote)
//   • releasable terminal        → `releaseStockHold` (membership-guarded heal)
//   • missing doc, or a terminal status that must NOT be guessed at (FULFILLED)
//                                → counted as UNRESOLVED, stock untouched
//
// It intentionally does NOT write `reservedQuantity` (see invariant I3): the
// counter and marker set are co-mutated atomically, so an absolute
// snapshot-based repair would be both unnecessary and race-prone.
//
// Returns { status, held, released, unresolved }.
// ══════════════════════════════════════════════════════════════════════════════
async function reconcileInventory(inventoryId) {
  const inventory = await Inventory.findById(inventoryId).select(
    '+heldReservations'
  );
  if (!inventory) {
    return { status: 'MISSING', held: 0, released: 0, unresolved: 0 };
  }

  const heldIds = inventory.heldReservations || [];
  if (heldIds.length === 0) {
    return { status: 'CONSISTENT', held: 0, released: 0, unresolved: 0 };
  }

  const docs = await Reservation.find({ _id: { $in: heldIds } })
    .select('status quantity')
    .lean();
  const byId = new Map(docs.map((d) => [String(d._id), d]));

  let held = 0;
  let released = 0;
  let unresolved = 0;

  for (const id of heldIds) {
    const reservationId = String(id);
    const doc = byId.get(reservationId);

    // A4 — never silently under-count a marker we cannot resolve.
    if (!doc) {
      unresolved += 1;
      continue;
    }

    if (RESERVATION_OPEN_STATUSES.includes(doc.status)) {
      // F2 — an open marker that recovery reports as INCONSISTENT (e.g. an ACTIVE
      // reservation with no hold marker) is NOT a trustworthy hold; never count it
      // as held, surface it instead so it is not silently under-counted.
      const outcome = await recoverReservation(reservationId);
      if (outcome.status === 'INCONSISTENT') unresolved += 1;
      else held += 1;
    } else if (RESERVATION_RELEASABLE_STATUSES.includes(doc.status)) {
      const result = await releaseStockHold(reservationId);
      if (result.released) released += 1;
    } else {
      // e.g. FULFILLED with a lingering marker — do not guess.
      unresolved += 1;
    }
  }

  return {
    status: unresolved > 0 ? 'UNRESOLVED' : 'RECONCILED',
    held,
    released,
    unresolved,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// settleReservation
// Single entry point for every TERMINAL transition: cancel, expiry and pickup.
//
// Ordering — SETTLE the hold FIRST, then CLOSE (write status + unset activeKey):
//   1. `releaseStockHold` (cancel / expiry) or `consumeStockHold` (pickup) — both
//      membership-guarded and idempotent, so stock is released at most once and
//      consumed at most once, no matter how many concurrent / repeated callers.
//   2. `closeReservation(status)` — the terminal status + `settledAt`, and
//      `$unset activeKey` so the unique partial index frees up.
//
// A crash between (1) and (2) leaves the reservation OPEN but no longer holding
// stock; the `holdState` written in (1) records which settlement happened, and
// `recoverReservation` finalizes the close from it (window W-settle). The reverse
// order is unsafe: a crash after a FULFILLED close but before consume would strand
// a consumed-on-paper / held-in-fact reservation that reconciliation must never
// guess at.
//
// `intent` ∈ 'CANCEL' | 'EXPIRE' | 'FULFILL'.
//
// Returns { ok, status, reason?, alreadySettled? }:
//   { ok:true,  status }                          — settled (this call or idempotent)
//   { ok:true,  status, alreadySettled:true }     — repeat of an identical transition
//   { ok:false, reason:'EXPIRED', status }        — past expiry; pickup refused, hold released
//   { ok:false, reason:'NOT_ACTIVE', status }     — PENDING; not yet pickable
//   { ok:false, reason:'CONFLICT', status }       — incompatible terminal already set
//   { ok:false, reason:'ALREADY_CONSUMED', status }
//   { ok:false, reason:'INSUFFICIENT_STOCK', status }
//   { ok:false, reason:'NOT_FOUND' }
// ══════════════════════════════════════════════════════════════════════════════
async function settleReservation(reservationId, intent) {
  const reservation = await Reservation.findById(reservationId).select(
    'inventory quantity status expiresAt +holdState'
  );
  if (!reservation) {
    return { ok: false, reason: 'NOT_FOUND' };
  }

  const expired = isExpired(reservation);

  // ── Already terminal ────────────────────────────────────────────────────────
  if (!RESERVATION_OPEN_STATUSES.includes(reservation.status)) {
    // A release-type terminal heals its own lingering marker (idempotent no-op if
    // the hold is already released/consumed). FULFILLED markers are left alone here
    // (reconcileInventory surfaces them as UNRESOLVED — we never guess).
    if (RESERVATION_RELEASABLE_STATUSES.includes(reservation.status)) {
      await releaseStockHold(reservation._id);
    }

    const wanted =
      intent === 'FULFILL'
        ? RESERVATION_STATUSES.FULFILLED
        : intent === 'EXPIRE'
        ? RESERVATION_STATUSES.EXPIRED
        : RESERVATION_STATUSES.CANCELLED;

    if (reservation.status === wanted) {
      return { ok: true, status: reservation.status, alreadySettled: true };
    }
    return { ok: false, reason: 'CONFLICT', status: reservation.status };
  }

  // ── FULFILL (pickup) ────────────────────────────────────────────────────────
  if (intent === 'FULFILL') {
    // Strict expiry for pickup: an expired reservation can never be fulfilled.
    if (expired) {
      const rel = await releaseStockHold(reservation._id);
      const status =
        rel.reason === 'ALREADY_CONSUMED'
          ? RESERVATION_STATUSES.FULFILLED
          : RESERVATION_STATUSES.EXPIRED;
      await closeReservation(reservation._id, status);
      return {
        ok: false,
        reason: status === RESERVATION_STATUSES.FULFILLED ? 'ALREADY_CONSUMED' : 'EXPIRED',
        status,
      };
    }

    // Pickup is defined for ACTIVE reservations (PENDING has no confirmed hold).
    if (reservation.status === RESERVATION_STATUSES.PENDING) {
      return { ok: false, reason: 'NOT_ACTIVE', status: reservation.status };
    }

    const consume = await consumeStockHold(reservation._id);
    if (consume.consumed) {
      await closeReservation(reservation._id, RESERVATION_STATUSES.FULFILLED);
      return { ok: true, status: RESERVATION_STATUSES.FULFILLED };
    }
    if (consume.reason === 'ALREADY_RELEASED' || consume.reason === 'NOT_HELD') {
      // A cancel / expiry won the race — converge on its terminal status.
      const status = expired
        ? RESERVATION_STATUSES.EXPIRED
        : RESERVATION_STATUSES.CANCELLED;
      await closeReservation(reservation._id, status);
      return { ok: false, reason: 'CONFLICT', status };
    }
    // INSUFFICIENT_STOCK or unexpected → leave open so a retry can settle it.
    return {
      ok: false,
      reason: consume.reason || 'INSUFFICIENT_STOCK',
      status: reservation.status,
    };
  }

  // ── CANCEL / EXPIRE (release path) ──────────────────────────────────────────
  const rel = await releaseStockHold(reservation._id);

  if (rel.reason === 'ALREADY_CONSUMED') {
    // Stock was physically taken (a pickup won) — the true terminal is FULFILLED.
    await closeReservation(reservation._id, RESERVATION_STATUSES.FULFILLED);
    return {
      ok: false,
      reason: 'ALREADY_CONSUMED',
      status: RESERVATION_STATUSES.FULFILLED,
    };
  }

  // released | ALREADY_RELEASED | NOT_HELD → the hold is not (or no longer) ours.
  const status =
    intent === 'EXPIRE' || expired
      ? RESERVATION_STATUSES.EXPIRED
      : RESERVATION_STATUSES.CANCELLED;
  await closeReservation(reservation._id, status);
  return { ok: true, status };
}

// ══════════════════════════════════════════════════════════════════════════════
// expireReservations
// Explicit expiry sweeper (never a TTL index): finds OPEN reservations whose
// `expiresAt` has passed and settles each one via `settleReservation(…, 'EXPIRE')`,
// which releases the held stock exactly once and moves them to EXPIRED.
//
// Idempotent and crash-safe by construction: settlement is membership-guarded, so
// re-running the sweep after a partial run is a no-op for already-settled rows and
// finalizes any row whose close did not complete (window W-settle).
//
// Returns { scanned, expired, fulfilled, conflicted }.
// ══════════════════════════════════════════════════════════════════════════════
async function expireReservations({ shopId = null, now = new Date(), limit = 200 } = {}) {
  const query = {
    status: { $in: RESERVATION_OPEN_STATUSES },
    expiresAt: { $lte: now },
  };
  if (shopId) query.shop = shopId;

  const due = await Reservation.find(query)
    .select('_id')
    .sort({ expiresAt: 1 })
    .limit(limit)
    .lean();

  const summary = { scanned: due.length, expired: 0, fulfilled: 0, conflicted: 0 };
  for (const { _id } of due) {
    const outcome = await settleReservation(_id, 'EXPIRE');
    if (outcome.status === RESERVATION_STATUSES.EXPIRED) summary.expired += 1;
    else if (outcome.status === RESERVATION_STATUSES.FULFILLED) summary.fulfilled += 1;
    else summary.conflicted += 1;
  }
  return summary;
}

// ══════════════════════════════════════════════════════════════════════════════
// createExpirySweeper
// Bounded, NON-overlapping, error-contained background expiry sweep (F1).
//
// It reuses `expireReservations` (and therefore the idempotent, membership-guarded
// `settleReservation`), so a sweep releases each hold exactly once and closes the
// reservation as EXPIRED. It never deletes documents and does NOT use a TTL index.
//
// Guarantees
//   • Overlap guard — at most one sweep is in flight per process; a tick that
//     arrives while a sweep is running is skipped (`run()` returns { skipped:true }).
//   • Bounded — each sweep handles at most `limit` reservations.
//   • Error containment — a failing sweep is logged and swallowed; it can never
//     throw into the timer callback and crash the server.
//   • Test determinism — `start()` is a no-op unless `enabled` is true; callers
//     pass `enabled: false` (or rely on the NODE_ENV==='test' default) so tests
//     drive `run()` explicitly instead of relying on wall-clock timers.
//
// Returns { run, start, stop, isRunning }.
// ══════════════════════════════════════════════════════════════════════════════
function createExpirySweeper({
  intervalMs = 60 * 1000,
  limit = 200,
  logger = console,
  sweepFn = expireReservations,
  enabled = process.env.NODE_ENV !== 'test',
} = {}) {
  let inFlight = false;
  let timer = null;

  async function run() {
    if (inFlight) return { skipped: true };
    inFlight = true;
    try {
      const summary = await sweepFn({ limit });
      if (summary && (summary.expired || summary.fulfilled || summary.conflicted)) {
        logger.log(`[expiry-sweep] ${JSON.stringify(summary)}`);
      }
      return summary || {};
    } catch (error) {
      // Never crash the process because of a sweep failure.
      logger.error(`[expiry-sweep] failed: ${error && error.message ? error.message : error}`);
      return { error: error && error.message ? error.message : String(error) };
    } finally {
      inFlight = false;
    }
  }

  function start() {
    if (!enabled || timer) return false;
    timer = setInterval(run, intervalMs);
    // Do not keep the event loop alive just for the sweeper.
    if (typeof timer.unref === 'function') timer.unref();
    return true;
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { run, start, stop, isRunning: () => inFlight };
}

// ══════════════════════════════════════════════════════════════════════════════
// createReservation
// Write-ahead creation: validate availability, commit a durable PENDING record
// (with its `activeKey`), claim stock idempotently, then promote PENDING→ACTIVE.
// Duplicate open reservations for the same (customer, inventory) are rejected by
// the unique partial index on `activeKey`.
//
// Throws an Error with `statusCode` on any failure (controller convention).
// Returns the hydrated Reservation document on success.
// ══════════════════════════════════════════════════════════════════════════════
async function createReservation({ customerId, inventoryId, quantity }) {
  if (!mongoose.isValidObjectId(customerId)) {
    throw httpError(400, 'A valid customer is required to create a reservation.');
  }

  if (!mongoose.isValidObjectId(inventoryId)) {
    throw httpError(400, 'inventory must be a valid MongoDB ObjectId.');
  }

  if (
    !Number.isInteger(quantity) ||
    quantity < RESERVATION_BOUNDS.MIN_UNITS ||
    quantity > RESERVATION_BOUNDS.MAX_UNITS
  ) {
    throw httpError(
      400,
      `quantity must be an integer between ${RESERVATION_BOUNDS.MIN_UNITS} and ${RESERVATION_BOUNDS.MAX_UNITS}.`
    );
  }

  // ── Availability requirements mirror the public search visibility rules ──────
  const inventory = await Inventory.findById(inventoryId).select(
    'shop product pricePaise isActive'
  );
  if (!inventory) {
    throw httpError(404, 'Inventory entry not found.');
  }
  if (!inventory.isActive) {
    throw httpError(409, 'This inventory entry is not available for reservation.');
  }

  // A new reservation requires the shop to be BOTH verified and open.
  // Note: a shop closing LATER does not cancel reservations already made — this
  // gate is only evaluated at creation time.
  const shop = await Shop.findById(inventory.shop).select('isVerified isOpen');
  if (!shop) {
    throw httpError(404, 'Shop not found.');
  }
  if (!shop.isVerified) {
    throw httpError(409, 'This shop is not available for reservations.');
  }
  if (!shop.isOpen) {
    throw httpError(
      409,
      'This shop is currently closed and not accepting reservations.'
    );
  }

  const product = await Product.findById(inventory.product).select('status');
  if (!product || product.status !== PRODUCT_STATUSES.ACTIVE) {
    throw httpError(409, 'This product is not available for reservation.');
  }

  // ── Write-ahead: durable PENDING record BEFORE any stock is claimed ──────────
  let reservation;
  try {
    reservation = await Reservation.create({
      customer: customerId,
      shop: inventory.shop,
      product: inventory.product,
      inventory: inventory._id,
      quantity,
      pricePaise: inventory.pricePaise,
      status: RESERVATION_STATUSES.PENDING,
      holdState: HOLD_STATES.UNCLAIMED,
      expiresAt: new Date(
        Date.now() + RESERVATION_BOUNDS.EXPIRY_MINUTES * 60 * 1000
      ),
      activeKey: buildActiveKey(customerId, inventory._id),
    });
  } catch (err) {
    if (err.code === 11000) {
      throw httpError(
        409,
        'You already have an active reservation for this item.'
      );
    }
    throw err;
  }

  // ── Claim + promote (idempotent, crash-safe) ────────────────────────────────
  const outcome = await recoverReservation(reservation._id);
  if (outcome.status === 'REJECTED') {
    throw httpError(409, 'Insufficient stock available for this reservation.');
  }
  if (!outcome.held) {
    throw httpError(500, 'Reservation could not be activated. Please retry.');
  }

  return Reservation.findById(reservation._id);
}

module.exports = {
  buildActiveKey,
  isHoldApplied,
  claimStockHold,
  releaseStockHold,
  consumeStockHold,
  closeReservation,
  recoverReservation,
  reconcileInventory,
  settleReservation,
  expireReservations,
  createExpirySweeper,
  createReservation,
};
