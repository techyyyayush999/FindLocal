/**
 * ph12test.js — FindLocal PH12 C1 regression suite
 *
 * Verifies the PH12 C1 fix: an `isActive: true` predicate was added to the
 * atomic Inventory claim filter inside `claimStockHold()` so that inventory
 * eligibility is checked ATOMICALLY with the stock claim.
 *
 * PHASE STATUS — PH12 C1: CLOSED
 *   - Production fix: atomic `isActive: true` predicate added to the Inventory
 *     claim filter in `claimStockHold()` (reservation.service.js).
 *   - Runtime result: 62 passed, 0 failed, exit code 0.
 *   - Isolated database dropped and its absence verified.
 *   - Mongoose connection closed; development DB untouched.
 *   - Final audit: PASS WITH FINDINGS — 0 Critical, 0 High, 0 Medium;
 *     4 accepted Low findings (see KNOWN LIMITATION below).
 *   - Cross-reference: PH11 C7 (HTTP-level F2-A race characterization).
 *
 * Covers (service level, direct model usage, isolated database):
 *   1. Inactive inventory — direct `claimStockHold()` rejection.
 *   2. Inactive inventory — `recoverReservation()` reaches REJECTED with no
 *      stock / marker / activeKey leak.
 *   3. Active inventory control — claim succeeds.
 *   4. Already-applied hold followed by deactivation — a retry returns
 *      `alreadyApplied` without a duplicate stock decrement.
 *   5. Reactivation and a legitimate subsequent reservation — the old activeKey
 *      is freed and a new reservation succeeds.
 *
 * These assertions are DETERMINISTIC and service level. The HTTP-level F2-A
 * race is NOT asserted here (the pre-check at creation time returns before the
 * claim, and the window is not controllable); that stays a characterization in
 * PH11 C7. Every case below drives the claim on an inventory whose `isActive`
 * state is already committed, which is exactly what the fix makes atomic.
 *
 * KNOWN LIMITATION — 4 accepted Low findings (encoded as comments, NOT
 * assertions). All were accepted in the final audit (PASS WITH FINDINGS; 0
 * Critical / 0 High / 0 Medium):
 *   1. A claim that loses to an inactive inventory still reports
 *      `reason: 'INSUFFICIENT_STOCK'` (the error classification was
 *      intentionally left unchanged), i.e. the API surfaces a generic 409
 *      rather than a distinct "inactive" message.
 *   2. The HTTP-level F2-A race is not asserted here; it remains a
 *      characterization in PH11 C7 (the window is not controllable at the
 *      service level).
 *   3. `isListPrivilegeError` is a best-effort heuristic: on a restricted
 *      account the post-drop absence check is reported INCONCLUSIVE (never a
 *      silent pass) and still fails the run with a distinct diagnostic.
 *   4. Several assertions are coupled to internal return strings
 *      (e.g. `reason: 'INSUFFICIENT_STOCK'`, hold states); a change to those
 *      service contracts requires this suite to be updated in lockstep.
 *
 * ISOLATION / SAFETY
 *   - This script NEVER touches the shared development database.
 *   - It derives an isolated database name (<db>_ph12test_<runid>) from MONGO_URI,
 *     connects to it, seeds fixtures there, and drops ONLY that database at the
 *     end using the NATIVE MongoDB driver (no registered Mongoose models during
 *     the drop, so auto-indexing cannot recreate it).
 *   - A remote MONGO_URI is refused unless PH12_ALLOW_REMOTE=1 is set.
 *   - The connected database name is checked FATALLY before any write/drop.
 *   - No application server is started and no HTTP is performed.
 *
 * Usage (from the server folder):
 *   node ph12test.js
 *
 * Env:
 *   PH12_ALLOW_REMOTE=1   allow a non-local MONGO_URI (off by default)
 */

const path = require('path');
const mongoose = require('mongoose');

require('dotenv').config({ path: path.join(__dirname, '.env') });

// Native MongoDB driver, obtained via Mongoose so no extra dependency is added
// and the exact driver version already in use is guaranteed. Used ONLY for
// cleanup: it registers no models and performs no auto-indexing.
const { MongoClient } = mongoose.mongo;

// ─── Per-run identity ─────────────────────────────────────────────────────────
const RUN_SUFFIX = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// ─── Derive an isolated test database from MONGO_URI ──────────────────────────
function deriveTestUri(uri, suffix) {
  const u = new URL(uri);
  const baseName = u.pathname.replace(/^\//, '') || 'findlocal';
  u.pathname = `/${baseName}_ph12test_${suffix}`;
  return { uri: u.toString(), dbName: u.pathname.slice(1), baseName };
}

const BASE_DB_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/findlocal';
const TEST_RUN = deriveTestUri(BASE_DB_URI, RUN_SUFFIX);

// ─── Remote database safety gate (PH11 pattern) ───────────────────────────────
// Only the host is ever surfaced — never credentials and never the full URI.
function uriHost(uri) {
  try {
    return new URL(uri).host || '(unknown)';
  } catch {
    return '(unparseable)';
  }
}

function hostIsRemote(host) {
  return !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host);
}

const BASE_HOST = uriHost(BASE_DB_URI);

function assertRemoteAllowed() {
  if (hostIsRemote(BASE_HOST) && process.env.PH12_ALLOW_REMOTE !== '1') {
    throw new Error(
      `Refusing to run: MONGO_URI host "${BASE_HOST}" is not local. ` +
        'Set PH12_ALLOW_REMOTE=1 to explicitly allow a remote database.'
    );
  }
}

// Extract the database name embedded in a connection URI, so the guarded name
// can be cross-checked against the URI actually targeted. No credentials and no
// full URI are ever surfaced.
function uriDbName(uri) {
  try {
    return decodeURIComponent(new URL(uri).pathname.replace(/^\//, ''));
  } catch {
    return '';
  }
}

// ─── Database-name guard ──────────────────────────────────────────────────────
// Every database operation in this suite must reference the ONE isolated name
// that belongs to THIS run. Exact equality only — no substring/prefix matching.
const GUARD_PREFIX = `${TEST_RUN.baseName}_ph12test_`;

function assertSafeDbName(name) {
  if (name !== TEST_RUN.dbName) {
    throw new Error(
      `Refusing to operate on database "${name}" — not this run's isolated database.`
    );
  }
}

// M3 — pre-connect precondition. This THROWS (it does not merely record a
// failure), so a failed guard aborts before any connection or write can occur.
function assertIsolatedNameOrThrow(name) {
  if (!name.startsWith(GUARD_PREFIX) || !name.includes(RUN_SUFFIX)) {
    throw new Error(
      `Refusing to run: isolated database name "${name}" failed the per-run guard.`
    );
  }
}

// ─── Run-scoped safety flags ──────────────────────────────────────────────────
// H1 — cleanup may open a MongoDB connection and drop a database ONLY after the
//      remote safety gate has passed. Set true exactly once, after
//      assertRemoteAllowed() succeeds and nothing else.
let remoteGatePassed = false;
// M2 — cleanup may drop ONLY if setup actually established a Mongoose connection.
//      If setup never connected, teardown must NOT open a second connection.
let mongooseConnected = false;

// ─── Test bookkeeping ─────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, label) {
  if (condition) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.error(`  FAIL: ${label}`);
    failed++;
    failures.push(label);
  }
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

// ─── Model imports (direct, isolated DB) ──────────────────────────────────────
const User = require('./src/models/User.model');
const Shop = require('./src/models/Shop.model');
const Product = require('./src/models/Product.model');
const Inventory = require('./src/models/Inventory.model');
const Reservation = require('./src/models/Reservation.model');
const svc = require('./src/services/reservation.service');
const {
  RESERVATION_STATUSES,
  HOLD_STATES,
} = require('./src/constants/reservationConstants');

// ─── Fixture builders (fully isolated per case) ───────────────────────────────
let seq = 0;
function uniq(prefix) {
  seq += 1;
  return `${prefix}${RUN_SUFFIX}${seq}`;
}

const PASSWORD = 'Ph12Test@12345';

async function makeUser(role) {
  const tag = uniq(role);
  return User.create({
    name: `Ph12 ${role} ${tag}`,
    email: `${tag}@ph12.test`.toLowerCase(),
    password: PASSWORD,
    role,
  });
}

async function makeShop(ownerId, { isVerified = true, isOpen = true } = {}) {
  return Shop.create({
    owner: ownerId,
    name: uniq('Shop'),
    address: 'Ph12 Test Address',
    location: { type: 'Point', coordinates: [77.209, 28.6139] },
    isVerified,
    isOpen,
  });
}

async function makeProduct({ status = 'ACTIVE', createdBy } = {}) {
  const tag = uniq('Prod');
  return Product.create({
    name: `Ph12 Product ${tag}`,
    brand: `Ph12Brand ${tag}`,
    category: 'other',
    description: 'Ph12 test product',
    status,
    createdBy,
  });
}

async function makeInventory({
  shopId,
  productId,
  quantity = 10,
  pricePaise = 5000,
  isActive = true,
} = {}) {
  return Inventory.create({
    shop: shopId,
    product: productId,
    pricePaise,
    quantity,
    reservedQuantity: 0,
    isActive,
  });
}

async function makeReservation({
  customerId,
  shopId,
  productId,
  inventoryId,
  quantity = 1,
  pricePaise = 5000,
  status = RESERVATION_STATUSES.PENDING,
  holdState = HOLD_STATES.UNCLAIMED,
  activeKey = null,
  expiresAt = null,
} = {}) {
  const doc = {
    customer: customerId,
    shop: shopId,
    product: productId,
    inventory: inventoryId,
    quantity,
    pricePaise,
    status,
    holdState,
    expiresAt: expiresAt || new Date(Date.now() + 120 * 60 * 1000),
  };
  if (activeKey) doc.activeKey = activeKey;
  return Reservation.create(doc);
}

// Build a fully isolated case: its own seller, shop, product, inventory and
// customer. A unique {shop, product} pair guarantees the stock row is
// uncontaminated by any other case.
async function makeCase({ quantity = 5, isActive = true } = {}) {
  const seller = await makeUser('seller');
  const shop = await makeShop(seller._id, { isVerified: true, isOpen: true });
  const product = await makeProduct({ status: 'ACTIVE', createdBy: seller._id });
  const inventory = await makeInventory({
    shopId: shop._id,
    productId: product._id,
    quantity,
    isActive,
  });
  const customer = await makeUser('customer');
  return { seller, shop, product, inventory, customer };
}

// Create a fresh PENDING reservation for a case (with its activeKey set, exactly
// as createReservation does).
async function makePendingReservation({ shop, product, inventory, customer, quantity = 1 }) {
  return makeReservation({
    customerId: customer._id,
    shopId: shop._id,
    productId: product._id,
    inventoryId: inventory._id,
    quantity,
    activeKey: svc.buildActiveKey(customer._id, inventory._id),
  });
}

// ─── Read-back helpers (assert the TRUE database state) ───────────────────────
async function readInv(id) {
  return Inventory.findById(id)
    .select('quantity reservedQuantity isActive +heldReservations')
    .lean();
}

async function readRes(id) {
  return Reservation.findById(id)
    .select('status quantity +holdState +holdAppliedAt +settledAt +activeKey')
    .lean();
}

// The core stock invariant that must hold after every relevant case.
function invariantHolds(inv) {
  return Boolean(
    inv && inv.quantity >= inv.reservedQuantity && inv.reservedQuantity >= 0
  );
}

function markerCount(inv) {
  return inv && inv.heldReservations ? inv.heldReservations.length : 0;
}

// ─── M1 — distinguish an authorization limitation from a real drop failure ────
// `listDatabases` requires a cluster privilege. If the account lacks it the drop
// may still have succeeded, so absence verification becomes INCONCLUSIVE — never
// a confirmed absence, and never a silently-passed cleanup.
function isListPrivilegeError(err) {
  if (!err) return false;
  if (err.code === 13 || err.codeName === 'Unauthorized') return true;
  return /not authorized|unauthorized|requires authentication/i.test(
    String(err.message || '')
  );
}

// ─── Cleanup: drop ONLY the isolated database (native driver + verify) ─────────
// Returns:
//   { dropped: true,  verified: true }                         — verified absent
//   { dropped: true,  verified: false, inconclusive: true,
//     reason: 'LIST_PRIVILEGE' }                               — drop issued, unverified
// Throws on a guard failure or an actual drop failure.
async function dropIsolatedDb(run) {
  // Guard first — never touch a database outside this run.
  assertSafeDbName(run.dbName);
  // The URI must point at exactly the guarded database, not merely a name that
  // happens to be accepted by the guard.
  const uriName = uriDbName(run.uri);
  if (uriName !== run.dbName) {
    throw new Error(
      `Refusing to drop: URI target "${uriName}" does not match guarded "${run.dbName}".`
    );
  }

  // Drop with the NATIVE driver, NOT Mongoose: a Mongoose connection triggers
  // auto-index building for registered models, which can recreate the database
  // immediately after the drop. The native client registers no models.
  const client = new MongoClient(run.uri, { serverSelectionTimeoutMS: 5000 });
  try {
    await client.connect();
    await client.db(run.dbName).dropDatabase();

    // A resolved dropDatabase() is NOT proof of deletion. Re-list and confirm the
    // exact name is gone. M1: a listing-privilege failure yields INCONCLUSIVE,
    // not a false "verified absent" and not an unqualified pass.
    try {
      const { databases } = await client.db().admin().listDatabases();
      if (databases.some((d) => d.name === run.dbName)) {
        throw new Error(`database "${run.dbName}" still exists after dropDatabase()`);
      }
      console.log(`  Cleanup: dropped and verified absent ${run.dbName}`);
      return { dropped: true, verified: true };
    } catch (verifyErr) {
      if (isListPrivilegeError(verifyErr)) {
        console.error(
          `  Cleanup: dropped ${run.dbName}, but absence could not be verified (account lacks listDatabases privilege).`
        );
        return { dropped: true, verified: false, inconclusive: true, reason: 'LIST_PRIVILEGE' };
      }
      throw verifyErr;
    }
  } finally {
    try {
      await client.close();
    } catch {
      /* already closed */
    }
  }
}

// ─── Disconnect the parent connection if (and only if) it exists ──────────────
// M2 — used by teardown so a partially established connection is always released
// without ever opening a new one.
async function safeDisconnect() {
  if (mongoose.connection.readyState !== 0) {
    try {
      await mongoose.disconnect();
    } catch {
      /* already disconnected */
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Section A — Setup: safety gates + isolated connection
// ══════════════════════════════════════════════════════════════════════════════
async function testSetup() {
  section('A. Setup');

  // Refuse a remote database unless explicitly allowed. Runs before any
  // connection or write so a shared/production cluster is never touched.
  assertRemoteAllowed();
  // H1 — the gate has passed; ONLY now may teardown open a connection / drop.
  remoteGatePassed = true;

  // M3 — fail FAST (throw) before any connection if the isolated name is wrong.
  assertIsolatedNameOrThrow(TEST_RUN.dbName);
  assert(true, `A1 isolated test database name is unique and guarded (${TEST_RUN.dbName})`);

  // Connect the parent (fixture seeding, read-back, cleanup). The connection name
  // is checked FATALLY: a mismatch aborts before any write/drop.
  await mongoose.connect(TEST_RUN.uri, { serverSelectionTimeoutMS: 5000 });
  // M2 — a connection now exists, so teardown may proceed to clean up.
  mongooseConnected = true;
  if (mongoose.connection.name !== TEST_RUN.dbName) {
    throw new Error(
      `Refusing to run: connected to "${mongoose.connection.name}", expected "${TEST_RUN.dbName}".`
    );
  }
  assert(true, `A2 parent is connected to the isolated database only (${mongoose.connection.name})`);

  assertSafeDbName(mongoose.connection.name);

  // Build required indexes (including the unique partial index on activeKey)
  // before relying on any index-dependent behaviour.
  await Promise.all([
    User.init(),
    Shop.init(),
    Product.init(),
    Inventory.init(),
    Reservation.init(),
  ]);
  assert(true, 'A3 model indexes ensured');
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. Inactive inventory — direct claimStockHold() rejection
// ══════════════════════════════════════════════════════════════════════════════
async function test1_claimRejectsInactive() {
  section('1. Inactive inventory — direct claimStockHold() rejection');

  // Fresh, fully isolated fixture.
  const { shop, product, inventory, customer } = await makeCase({
    quantity: 5,
    isActive: false,
  });
  const reservation = await makePendingReservation({
    shop,
    product,
    inventory,
    customer,
    quantity: 2,
  });

  const claim = await svc.claimStockHold(reservation._id);

  assert(claim.applied === false, `1 claim not applied (got ${JSON.stringify(claim)})`);
  assert(
    claim.reason === 'INSUFFICIENT_STOCK',
    `1 reason is INSUFFICIENT_STOCK (got ${claim.reason})`
  );

  const inv = await readInv(inventory._id);
  const res = await readRes(reservation._id);

  assert(inv.reservedQuantity === 0, `1 reservedQuantity unchanged at 0 (got ${inv.reservedQuantity})`);
  assert(markerCount(inv) === 0, `1 no heldReservations marker created (got ${markerCount(inv)})`);
  assert(inv.quantity === 5, `1 physical quantity unchanged at 5 (got ${inv.quantity})`);
  assert(invariantHolds(inv), '1 invariant quantity >= reservedQuantity >= 0 holds');

  // The primitive does not transition lifecycle state: the reservation stays open
  // but never claimed.
  assert(res.status === RESERVATION_STATUSES.PENDING, `1 reservation stays PENDING (got ${res.status})`);
  assert(res.holdState === HOLD_STATES.UNCLAIMED, `1 holdState stays UNCLAIMED (got ${res.holdState})`);
}

// ══════════════════════════════════════════════════════════════════════════════
// 2. Inactive inventory — recoverReservation() reaches REJECTED, no leak
// ══════════════════════════════════════════════════════════════════════════════
async function test2_recoverRejectsInactive() {
  section('2. Inactive inventory — recoverReservation() reaches REJECTED');

  // SEPARATE fresh fixture from test 1 — no shared state.
  const { shop, product, inventory, customer } = await makeCase({
    quantity: 5,
    isActive: false,
  });
  const reservation = await makePendingReservation({
    shop,
    product,
    inventory,
    customer,
    quantity: 3,
  });

  // Precondition: activeKey is present while the reservation is open.
  const pre = await readRes(reservation._id);
  assert(Boolean(pre.activeKey), '2 precondition: activeKey present before recovery');

  const outcome = await svc.recoverReservation(reservation._id);

  assert(outcome.status === 'REJECTED', `2 recovery reports REJECTED (got ${outcome.status})`);
  assert(outcome.held === false, `2 recovery reports not held (got ${outcome.held})`);

  const inv = await readInv(inventory._id);
  const res = await readRes(reservation._id);

  assert(inv.reservedQuantity === 0, `2 reservedQuantity unchanged at 0 (got ${inv.reservedQuantity})`);
  assert(markerCount(inv) === 0, `2 no heldReservations marker remains (got ${markerCount(inv)})`);
  assert(inv.quantity === 5, `2 physical quantity unchanged at 5 (got ${inv.quantity})`);
  assert(invariantHolds(inv), '2 invariant quantity >= reservedQuantity >= 0 holds');

  assert(res.status === RESERVATION_STATUSES.REJECTED, `2 reservation terminal REJECTED (got ${res.status})`);
  assert(!res.activeKey, `2 activeKey freed, no leak (got ${String(res.activeKey)})`);
  assert(Boolean(res.settledAt), '2 settledAt recorded on the terminal close');
}

// ══════════════════════════════════════════════════════════════════════════════
// 3. Active inventory control — claim succeeds
// ══════════════════════════════════════════════════════════════════════════════
async function test3_activeControl() {
  section('3. Active inventory control — claim succeeds');

  const { shop, product, inventory, customer } = await makeCase({
    quantity: 5,
    isActive: true,
  });
  const reservation = await makePendingReservation({
    shop,
    product,
    inventory,
    customer,
    quantity: 2,
  });

  const claim = await svc.claimStockHold(reservation._id);
  assert(claim.applied === true, `3 claim applied on active inventory (got ${JSON.stringify(claim)})`);

  let inv = await readInv(inventory._id);
  assert(inv.reservedQuantity === 2, `3 reservedQuantity === 2 (got ${inv.reservedQuantity})`);
  assert(markerCount(inv) === 1, `3 one heldReservations marker (got ${markerCount(inv)})`);
  assert(inv.quantity === 5, `3 physical quantity unchanged at 5 (got ${inv.quantity})`);
  assert(invariantHolds(inv), '3 invariant holds after claim');

  // Recovery promotes the claimed PENDING reservation to ACTIVE + HELD.
  const promoted = await svc.recoverReservation(reservation._id);
  assert(promoted.status === 'PROMOTED', `3 recovery promotes to ACTIVE (got ${promoted.status})`);
  assert(promoted.held === true, '3 recovered reservation is held');

  inv = await readInv(inventory._id);
  const res = await readRes(reservation._id);
  assert(res.status === RESERVATION_STATUSES.ACTIVE, `3 reservation ACTIVE (got ${res.status})`);
  assert(res.holdState === HOLD_STATES.HELD, `3 holdState HELD (got ${res.holdState})`);
  assert(Boolean(res.activeKey), '3 activeKey still present while open');
  assert(inv.reservedQuantity === 2 && markerCount(inv) === 1, '3 held state consistent after promotion');
  assert(invariantHolds(inv), '3 invariant holds after promotion');
}

// ══════════════════════════════════════════════════════════════════════════════
// 4. Already-applied hold, then deactivation — retry is alreadyApplied
// ══════════════════════════════════════════════════════════════════════════════
async function test4_alreadyAppliedAfterDeactivation() {
  section('4. Already-applied hold + deactivation — retry returns alreadyApplied');

  const { shop, product, inventory, customer } = await makeCase({
    quantity: 5,
    isActive: true,
  });
  const reservation = await makePendingReservation({
    shop,
    product,
    inventory,
    customer,
    quantity: 2,
  });

  // Apply the hold for real (claim → promote), exactly as creation does.
  const first = await svc.recoverReservation(reservation._id);
  assert(first.status === 'RECLAIMED', `4 precondition: initial claim+promote (got ${first.status})`);

  const preInv = await readInv(inventory._id);
  const preRes = await readRes(reservation._id);
  assert(preInv.reservedQuantity === 2, `4 precondition: reservedQuantity === 2 (got ${preInv.reservedQuantity})`);
  assert(markerCount(preInv) === 1, `4 precondition: one marker (got ${markerCount(preInv)})`);
  assert(preRes.status === RESERVATION_STATUSES.ACTIVE, `4 precondition: ACTIVE (got ${preRes.status})`);

  // Deactivate the inventory AFTER the hold was applied.
  await Inventory.updateOne({ _id: inventory._id }, { $set: { isActive: false } });

  // A retry must report alreadyApplied and must NOT double-decrement.
  const retry = await svc.claimStockHold(reservation._id);
  assert(retry.applied === true, `4 retry still reports applied (got ${JSON.stringify(retry)})`);
  assert(retry.alreadyApplied === true, `4 retry reports alreadyApplied (got ${retry.alreadyApplied})`);

  const inv = await readInv(inventory._id);
  const res = await readRes(reservation._id);
  assert(inv.reservedQuantity === 2, `4 reservedQuantity NOT decremented twice (got ${inv.reservedQuantity})`);
  assert(markerCount(inv) === 1, `4 marker count stays exactly one (got ${markerCount(inv)})`);
  assert(inv.quantity === 5, `4 physical quantity untouched at 5 (got ${inv.quantity})`);
  assert(inv.isActive === false, '4 deactivation persisted');
  assert(invariantHolds(inv), '4 invariant holds after retry');

  // An existing HELD reservation remains HELD after deactivation + retry.
  assert(res.status === RESERVATION_STATUSES.ACTIVE, `4 reservation remains ACTIVE (got ${res.status})`);
  assert(res.holdState === HOLD_STATES.HELD, `4 reservation remains HELD (got ${res.holdState})`);
  assert(Boolean(res.activeKey), '4 activeKey still present for the open reservation');
}

// ══════════════════════════════════════════════════════════════════════════════
// 5. Reactivation and legitimate subsequent reservation
// ══════════════════════════════════════════════════════════════════════════════
async function test5_reactivateAndReserve() {
  section('5. Reactivation + legitimate subsequent reservation');

  const { shop, product, inventory, customer } = await makeCase({
    quantity: 5,
    isActive: false,
  });

  // Rejected attempt on the inactive inventory.
  const rejected = await makePendingReservation({
    shop,
    product,
    inventory,
    customer,
    quantity: 2,
  });
  const outcome = await svc.recoverReservation(rejected._id);
  assert(outcome.status === 'REJECTED', `5 first attempt REJECTED (got ${outcome.status})`);

  const rejectedRes = await readRes(rejected._id);
  assert(rejectedRes.status === RESERVATION_STATUSES.REJECTED, `5 rejected reservation terminal (got ${rejectedRes.status})`);
  assert(!rejectedRes.activeKey, '5 rejected reservation freed its activeKey');

  // Reactivate the inventory.
  await Inventory.updateOne({ _id: inventory._id }, { $set: { isActive: true } });

  // A legitimate subsequent reservation for the SAME customer + inventory must
  // now succeed — possible only because the old activeKey was freed.
  const fresh = await makePendingReservation({
    shop,
    product,
    inventory,
    customer,
    quantity: 2,
  });
  const freshOutcome = await svc.recoverReservation(fresh._id);
  assert(freshOutcome.status === 'RECLAIMED', `5 subsequent reservation applied (got ${freshOutcome.status})`);
  assert(freshOutcome.held === true, '5 subsequent reservation is held');

  const inv = await readInv(inventory._id);
  const res = await readRes(fresh._id);

  assert(res.status === RESERVATION_STATUSES.ACTIVE, `5 new reservation ACTIVE (got ${res.status})`);
  assert(res.holdState === HOLD_STATES.HELD, `5 new reservation HELD (got ${res.holdState})`);
  assert(
    res.activeKey === svc.buildActiveKey(customer._id, inventory._id),
    `5 new reservation carries its activeKey (got ${String(res.activeKey)})`
  );
  assert(inv.reservedQuantity === 2, `5 new hold reserved === 2 (got ${inv.reservedQuantity})`);
  assert(markerCount(inv) === 1, `5 exactly one marker for the new hold (got ${markerCount(inv)})`);
  assert(inv.quantity === 5, '5 physical quantity unchanged at 5');
  assert(invariantHolds(inv), '5 invariant holds');

  // The old (rejected) reservation is untouched and still holds nothing.
  const rejectedInv = await readInv(inventory._id);
  assert(
    !(rejectedInv.heldReservations || []).some((h) => String(h) === String(rejected._id)),
    '5 rejected reservation left no marker behind'
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Section Z — Teardown
// ══════════════════════════════════════════════════════════════════════════════
async function teardown() {
  section('Z. Teardown');

  // H1 — the remote safety gate governs cleanup too. If it did not pass, open NO
  // MongoDB connection and drop NOTHING; the original gate failure already
  // produced a non-zero exit.
  if (!remoteGatePassed) {
    console.log(
      '  Cleanup skipped: remote safety gate did not pass — no MongoDB connection will be opened and no database will be dropped.'
    );
    assert(
      false,
      'Z1 cleanup skipped because the remote safety gate did not pass (remote database safety preserved)'
    );
  } else if (!mongooseConnected) {
    // M2 — setup never established a connection; do not open a second one.
    console.log(
      '  Cleanup skipped: setup never established a MongoDB connection — nothing to drop.'
    );
    assert(true, 'Z1 cleanup skipped because setup established no MongoDB connection');
  } else {
    // A connection exists → drop ONLY the isolated database and verify it.
    let result = null;
    try {
      result = await dropIsolatedDb(TEST_RUN);
    } catch (err) {
      console.error(`  Cleanup failure (${TEST_RUN.dbName}): ${err.message}`);
    }

    if (result && result.verified) {
      assert(true, 'Z1 isolated database dropped and verified absent');
    } else if (result && result.inconclusive) {
      // M1 — drop was issued but absence could not be confirmed (privilege limit).
      console.error(
        `  Cleanup inconclusive (${TEST_RUN.dbName}): drop was issued but absence could not be verified — account lacks listDatabases privilege (authorization limitation, not a confirmed drop failure).`
      );
      assert(
        false,
        'Z1 isolated database cleanup could not be fully verified (authorization limitation)'
      );
    } else {
      assert(false, `Z1 isolated database was NOT verified absent (${TEST_RUN.dbName})`);
    }
  }

  // Always release any connection (partial or full). Never opens a new one.
  await safeDisconnect();
  assert(mongoose.connection.readyState === 0, 'Z2 MongoDB connection is closed');
}

// ══════════════════════════════════════════════════════════════════════════════
// Runner
// ══════════════════════════════════════════════════════════════════════════════
async function main() {
  console.log('FindLocal — PH12 C1 regression suite');
  console.log(`  Isolated test database: ${TEST_RUN.dbName}`);
  console.log(`  Remote host allowed:    ${process.env.PH12_ALLOW_REMOTE === '1' ? 'yes' : 'no'}`);

  try {
    await testSetup();

    await test1_claimRejectsInactive();
    await test2_recoverRejectsInactive();
    await test3_activeControl();
    await test4_alreadyAppliedAfterDeactivation();
    await test5_reactivateAndReserve();
  } catch (err) {
    console.error(`\nUnexpected suite error: ${err.message}`);
    failed++;
    failures.push(`suite error: ${err.message}`);
  } finally {
    // Cleanup must always run — even after a partial setup failure.
    try {
      await teardown();
    } catch (err) {
      console.error(`\nTeardown error: ${err.message}`);
      failed++;
      failures.push(`teardown error: ${err.message}`);
    }
  }

  console.log('\n========================================');
  console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  if (failures.length) {
    console.log('Failures:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  console.log('========================================');

  process.exitCode = failed > 0 ? 1 : 0;
}

// A rejection escaping main() — e.g. a failure thrown by the finally-block
// cleanup — must still exit non-zero.
main().catch((error) => {
  console.error(`Fatal test runner error: ${error && error.message ? error.message : error}`);
  process.exitCode = 1;
});
