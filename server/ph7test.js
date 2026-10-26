/**
 * ph7test.js — FindLocal Phase 7 Reservation Tests
 *
 * Covers:
 *   A. Ledger / service-level correctness (direct DB, isolated test database)
 *      - same-reservation concurrent claim (idempotent)
 *      - different-reservation oversell boundary
 *      - concurrent release vs consume
 *      - reconciliation racing with a claim
 *      - stale terminal markers, missing Reservation docs, FULFILLED markers
 *      - duplicate activeKey, activeKey reuse after closure
 *      - serialization guards
 *   A2. Stage 4 settlement (direct DB)
 *      - cancel releases once + idempotent; pickup consumes once + idempotent
 *      - expired reservation cannot be picked up (hold released)
 *      - crash between settlement and close is finalized by recovery
 *      - concurrent cancel vs pickup → exactly one stock effect
 *      - expiry sweep releases exactly once (no TTL), idempotent
 *      - incompatible terminal transitions refused
 *   B. HTTP API integration (spawns its own server)
 *      - POST /api/v1/reservations validation, auth, stock, shop/product state
 *      - duplicate active reservation
 *      - customer + seller read endpoints and their data scope
 *      - response serialization
 *   C. Stage 4 settlement over HTTP
 *      - customer cancel (own) and seller cancel (own shop), 404 cross-scope
 *      - seller pickup + idempotency; expired pickup → 409
 *      - auth/role/validation on the settlement routes
 *      - seller expiry sweep scoped to the seller's own shop
 *
 * ISOLATION / SAFETY
 *   - This script NEVER touches the shared development database.
 *   - It derives an isolated database name (<db>_ph7test_<runid>) from MONGO_URI,
 *     connects to it, and drops ONLY that database at the end.
 *   - The API server is spawned as a child process with MONGO_URI and PORT
 *     overridden to the isolated database / a test port, and is killed at the end.
 *
 * Usage (from the server folder):
 *   node ph7test.js
 */

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const mongoose = require('mongoose');

require('dotenv').config({ path: path.join(__dirname, '.env') });

const RUN_SUFFIX = `${Date.now().toString(36)}${Math.random()
  .toString(36)
  .slice(2, 6)}`;

const BASE_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/findlocal';
const TEST_PORT = Number(process.env.PH7_TEST_PORT || 5099);
const API_BASE = `http://localhost:${TEST_PORT}/api/v1`;
const PASSWORD = 'Ph7Test@12345';

// ─── Derive an isolated test database from MONGO_URI ──────────────────────────
function deriveTestUri(uri, suffix) {
  const u = new URL(uri);
  const baseName = u.pathname.replace(/^\//, '') || 'findlocal';
  u.pathname = `/${baseName}_ph7test_${suffix}`;
  return { uri: u.toString(), dbName: u.pathname.slice(1), baseName };
}

const { uri: TEST_URI, dbName: TEST_DB_NAME, baseName: BASE_DB_NAME } =
  deriveTestUri(BASE_URI, RUN_SUFFIX);

// ─── Counters ─────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
let skipped = 0;
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

function skip(label) {
  console.log(`  SKIP: ${label}`);
  skipped++;
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

// ══════════════════════════════════════════════════════════════════════════════
// HTTP helper
// ══════════════════════════════════════════════════════════════════════════════
function request(method, requestPath, { body = null, cookie = '' } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(API_BASE + requestPath);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: { 'Content-Type': 'application/json' },
    };
    if (cookie) options.headers.Cookie = cookie;

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        const setCookies = res.headers['set-cookie'] || [];
        let responseCookie = '';
        for (const c of setCookies) {
          if (c.startsWith('findlocal_token=')) responseCookie = c.split(';')[0];
        }
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          parsed = data;
        }
        resolve({ status: res.statusCode, body: parsed, cookie: responseCookie });
      });
    });
    req.on('error', reject);
    if (body !== null) req.write(JSON.stringify(body));
    req.end();
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// Fixture builders (direct model usage, isolated DB)
// ══════════════════════════════════════════════════════════════════════════════
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

let seq = 0;
function uniq(prefix) {
  seq += 1;
  return `${prefix}${RUN_SUFFIX}${seq}`;
}

async function makeUser(role) {
  const tag = uniq(role);
  return User.create({
    name: `Ph7 ${role} ${tag}`,
    email: `${tag}@ph7.test`.toLowerCase(),
    password: PASSWORD,
    role,
  });
}

async function makeShop(ownerId, { isVerified = true, isOpen = true } = {}) {
  return Shop.create({
    owner: ownerId,
    name: uniq('Shop'),
    address: 'Ph7 Test Address',
    location: { type: 'Point', coordinates: [77.209, 28.6139] },
    isVerified,
    isOpen,
  });
}

async function makeProduct({ status = 'ACTIVE', createdBy } = {}) {
  const tag = uniq('Prod');
  return Product.create({
    name: `Ph7 Product ${tag}`,
    brand: `Ph7Brand ${tag}`,
    category: 'other',
    description: 'Ph7 test product',
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

// Convenience: create an OPEN reservation and drive it to ACTIVE + HELD through the
// real recovery primitive (claim → promote), exactly as createReservation does.
async function makeActiveReservation({
  customerId,
  shopId,
  productId,
  inventoryId,
  quantity = 1,
  expiresAt = null,
} = {}) {
  const r = await makeReservation({
    customerId,
    shopId,
    productId,
    inventoryId,
    quantity,
    activeKey: svc.buildActiveKey(customerId, inventoryId),
    expiresAt,
  });
  await svc.recoverReservation(r._id);
  return r;
}

const PAST = () => new Date(Date.now() - 60 * 1000);

// Convenience: a fully wired, isolated listing (seller + shop + product + inv)
async function makeListing({
  quantity = 10,
  isVerified = true,
  isOpen = true,
  productStatus = 'ACTIVE',
  isActive = true,
  pricePaise = 5000,
} = {}) {
  const seller = await makeUser('seller');
  const shop = await makeShop(seller._id, { isVerified, isOpen });
  const product = await makeProduct({ status: productStatus, createdBy: seller._id });
  const inventory = await makeInventory({
    shopId: shop._id,
    productId: product._id,
    quantity,
    pricePaise,
    isActive,
  });
  return { seller, shop, product, inventory };
}

async function readInv(id) {
  return Inventory.findById(id).select('+heldReservations').lean();
}

async function readRes(id) {
  return Reservation.findById(id)
    .select('+holdState +holdAppliedAt +settledAt +activeKey')
    .lean();
}

const INTERNAL_RESERVATION_KEYS = [
  'activeKey',
  'holdState',
  'holdAppliedAt',
  'settledAt',
];

function jsonLeaksInternals(obj) {
  if (!obj || typeof obj !== 'object') return false;
  return (
    INTERNAL_RESERVATION_KEYS.some((k) => k in obj) || 'heldReservations' in obj
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION A — Ledger / service-level correctness
// ══════════════════════════════════════════════════════════════════════════════

async function testA1_concurrentSameClaim() {
  section('A1. Same-reservation concurrent claim (idempotent)');
  const customer = await makeUser('customer');
  const { shop, product, inventory } = await makeListing({ quantity: 5 });
  const r1 = await makeReservation({
    customerId: customer._id,
    shopId: shop._id,
    productId: product._id,
    inventoryId: inventory._id,
    quantity: 2,
    activeKey: svc.buildActiveKey(customer._id, inventory._id),
  });

  const results = await Promise.all(
    Array.from({ length: 10 }, () => svc.claimStockHold(r1._id))
  );

  const inv = await readInv(inventory._id);
  assert(
    inv.reservedQuantity === 2,
    `reservedQuantity === 2 after 10 concurrent claims (got ${inv.reservedQuantity})`
  );
  const markerCount = (inv.heldReservations || []).filter(
    (h) => String(h) === String(r1._id)
  ).length;
  assert(markerCount === 1, `marker present exactly once (got ${markerCount})`);
  const applied = results.filter((r) => r && r.applied).length;
  assert(applied >= 1, `at least one claim applied (got ${applied}/10)`);
  const res = await readRes(r1._id);
  assert(res.holdState === HOLD_STATES.HELD, `holdState HELD (got ${res.holdState})`);
}

async function testA2_oversellBoundary() {
  section('A2. Different-reservation oversell boundary');
  const c1 = await makeUser('customer');
  const c2 = await makeUser('customer');
  const { shop, product, inventory } = await makeListing({ quantity: 3 });

  const r1 = await makeReservation({
    customerId: c1._id,
    shopId: shop._id,
    productId: product._id,
    inventoryId: inventory._id,
    quantity: 2,
    activeKey: svc.buildActiveKey(c1._id, inventory._id),
  });
  const r2 = await makeReservation({
    customerId: c2._id,
    shopId: shop._id,
    productId: product._id,
    inventoryId: inventory._id,
    quantity: 2,
    activeKey: svc.buildActiveKey(c2._id, inventory._id),
  });

  const [a, b] = await Promise.all([
    svc.claimStockHold(r1._id),
    svc.claimStockHold(r2._id),
  ]);

  const inv = await readInv(inventory._id);
  assert(
    inv.reservedQuantity === 2,
    `reservedQuantity === 2 (only one claim) (got ${inv.reservedQuantity})`
  );
  const applied = [a, b].filter((r) => r && r.applied).length;
  assert(applied === 1, `exactly one claim applied (got ${applied})`);
  const loser = [a, b].find((r) => r && !r.applied);
  assert(
    Boolean(loser) && loser.reason === 'INSUFFICIENT_STOCK',
    `loser reason INSUFFICIENT_STOCK (got ${loser && loser.reason})`
  );
  assert(
    (inv.heldReservations || []).length === 1,
    `exactly one marker (got ${(inv.heldReservations || []).length})`
  );
}

async function testA3_releaseVsConsume() {
  section('A3. Concurrent release vs consume');
  const customer = await makeUser('customer');
  const { shop, product, inventory } = await makeListing({ quantity: 5 });
  const r1 = await makeReservation({
    customerId: customer._id,
    shopId: shop._id,
    productId: product._id,
    inventoryId: inventory._id,
    quantity: 2,
    activeKey: svc.buildActiveKey(customer._id, inventory._id),
  });

  const claim = await svc.claimStockHold(r1._id);
  assert(claim.applied === true, 'precondition: claim applied');
  const preInv = await readInv(inventory._id);
  assert(preInv.reservedQuantity === 2, 'precondition: reservedQuantity === 2');

  const [rel, con] = await Promise.all([
    svc.releaseStockHold(r1._id),
    svc.consumeStockHold(r1._id),
  ]);

  const inv = await readInv(inventory._id);
  assert(
    inv.reservedQuantity === 0,
    `reservedQuantity settles to 0 (got ${inv.reservedQuantity})`
  );
  assert(
    !(inv.heldReservations || []).some((h) => String(h) === String(r1._id)),
    'marker removed'
  );

  const effects = (rel.released ? 1 : 0) + (con.consumed ? 1 : 0);
  assert(effects === 1, `exactly one of release/consume took effect (got ${effects})`);

  if (rel.released) {
    assert(inv.quantity === 5, `release winner leaves quantity 5 (got ${inv.quantity})`);
    assert(con.reason === 'ALREADY_RELEASED' || con.reason === 'NOT_HELD',
      `losing consume reported a distinct reason (got ${con.reason})`);
  } else {
    assert(inv.quantity === 3, `consume winner leaves quantity 3 (got ${inv.quantity})`);
    assert(rel.reason === 'ALREADY_CONSUMED' || rel.reason === 'NOT_HELD',
      `losing release reported a distinct reason (got ${rel.reason})`);
  }
}

async function testA4_reconcileRacingClaim() {
  section('A4. Reconciliation racing with a claim');
  const c1 = await makeUser('customer');
  const c2 = await makeUser('customer');
  const { shop, product, inventory } = await makeListing({ quantity: 10 });

  // Stale releasable marker: a CANCELLED reservation that never released.
  const stale = await makeReservation({
    customerId: c1._id,
    shopId: shop._id,
    productId: product._id,
    inventoryId: inventory._id,
    quantity: 3,
    status: RESERVATION_STATUSES.CANCELLED,
    holdState: HOLD_STATES.HELD,
  });
  await Inventory.updateOne(
    { _id: inventory._id },
    { $inc: { reservedQuantity: 3 }, $addToSet: { heldReservations: stale._id } }
  );

  // A live PENDING reservation that is NOT yet claimed.
  const live = await makeReservation({
    customerId: c2._id,
    shopId: shop._id,
    productId: product._id,
    inventoryId: inventory._id,
    quantity: 3,
    activeKey: svc.buildActiveKey(c2._id, inventory._id),
  });

  await Promise.all([
    svc.reconcileInventory(inventory._id),
    svc.claimStockHold(live._id),
    svc.claimStockHold(live._id),
  ]);

  const inv = await readInv(inventory._id);
  assert(
    inv.reservedQuantity === 3,
    `reservedQuantity === 3 (no clobber, no oversell) (got ${inv.reservedQuantity})`
  );
  const markers = (inv.heldReservations || []).map(String);
  assert(
    markers.length === 1 && markers[0] === String(live._id),
    `only the live reservation's marker remains (got [${markers.join(',')}])`
  );
}

async function testA5_staleTerminalMarkers() {
  section('A5. Stale terminal markers are healed by release');
  const c1 = await makeUser('customer');
  const { shop, product, inventory } = await makeListing({ quantity: 5 });
  const stale = await makeReservation({
    customerId: c1._id,
    shopId: shop._id,
    productId: product._id,
    inventoryId: inventory._id,
    quantity: 2,
    status: RESERVATION_STATUSES.EXPIRED,
    holdState: HOLD_STATES.HELD,
  });
  await Inventory.updateOne(
    { _id: inventory._id },
    { $inc: { reservedQuantity: 2 }, $addToSet: { heldReservations: stale._id } }
  );

  const result = await svc.reconcileInventory(inventory._id);
  const inv = await readInv(inventory._id);
  assert(result.released === 1, `released 1 stale marker (got ${result.released})`);
  assert(result.unresolved === 0, `unresolved 0 (got ${result.unresolved})`);
  assert(inv.reservedQuantity === 0, `reservedQuantity healed to 0 (got ${inv.reservedQuantity})`);
  assert((inv.heldReservations || []).length === 0, 'marker removed');
}

async function testA6_missingReservationDoc() {
  section('A6. Missing Reservation document is surfaced, stock untouched');
  const { inventory } = await makeListing({ quantity: 5 });
  const phantom = new mongoose.Types.ObjectId();
  await Inventory.updateOne(
    { _id: inventory._id },
    { $inc: { reservedQuantity: 2 }, $addToSet: { heldReservations: phantom } }
  );

  const result = await svc.reconcileInventory(inventory._id);
  const inv = await readInv(inventory._id);
  assert(result.unresolved === 1, `unresolved === 1 (got ${result.unresolved})`);
  assert(result.status === 'UNRESOLVED', `status UNRESOLVED (got ${result.status})`);
  assert(
    inv.reservedQuantity === 2,
    `reservedQuantity unchanged (never guessed) (got ${inv.reservedQuantity})`
  );
  assert(
    (inv.heldReservations || []).some((h) => String(h) === String(phantom)),
    'unresolvable marker left in place'
  );
}

async function testA7_fulfilledMarkers() {
  section('A7. FULFILLED markers are never guessed at');
  const c1 = await makeUser('customer');
  const { shop, product, inventory } = await makeListing({ quantity: 5 });
  const f = await makeReservation({
    customerId: c1._id,
    shopId: shop._id,
    productId: product._id,
    inventoryId: inventory._id,
    quantity: 2,
    status: RESERVATION_STATUSES.FULFILLED,
    holdState: HOLD_STATES.HELD,
  });
  await Inventory.updateOne(
    { _id: inventory._id },
    { $inc: { reservedQuantity: 2 }, $addToSet: { heldReservations: f._id } }
  );

  const result = await svc.reconcileInventory(inventory._id);
  const inv = await readInv(inventory._id);
  assert(result.unresolved === 1, `unresolved === 1 (got ${result.unresolved})`);
  assert(result.status === 'UNRESOLVED', `status UNRESOLVED (got ${result.status})`);
  assert(
    inv.reservedQuantity === 2,
    `reservedQuantity unchanged (got ${inv.reservedQuantity})`
  );
  assert(
    (inv.heldReservations || []).some((h) => String(h) === String(f._id)),
    'FULFILLED marker left in place'
  );
}

async function testA8_duplicateActiveKey() {
  section('A8. Duplicate activeKey is rejected at the DB level');
  const c1 = await makeUser('customer');
  const { shop, product, inventory } = await makeListing({ quantity: 5 });
  const key = `dup_${RUN_SUFFIX}`;

  await makeReservation({
    customerId: c1._id,
    shopId: shop._id,
    productId: product._id,
    inventoryId: inventory._id,
    quantity: 1,
    activeKey: key,
  });

  let code = null;
  try {
    await makeReservation({
      customerId: c1._id,
      shopId: shop._id,
      productId: product._id,
      inventoryId: inventory._id,
      quantity: 1,
      activeKey: key,
    });
  } catch (err) {
    code = err.code;
  }
  assert(code === 11000, `duplicate activeKey rejected with E11000 (got ${code})`);
}

async function testA9_activeKeyReuseAfterClosure() {
  section('A9. activeKey is freed on closure and reusable');
  const c1 = await makeUser('customer');
  const { shop, product, inventory } = await makeListing({ quantity: 5 });
  const key = `reuse_${RUN_SUFFIX}`;

  const r1 = await makeReservation({
    customerId: c1._id,
    shopId: shop._id,
    productId: product._id,
    inventoryId: inventory._id,
    quantity: 1,
    activeKey: key,
  });

  await svc.closeReservation(r1._id, RESERVATION_STATUSES.CANCELLED);
  const closed = await readRes(r1._id);
  assert(closed.activeKey === undefined, `activeKey unset after close (got ${closed.activeKey})`);
  assert(
    closed.status === RESERVATION_STATUSES.CANCELLED,
    `status CANCELLED (got ${closed.status})`
  );

  let r2 = null;
  let errCode = null;
  try {
    r2 = await makeReservation({
      customerId: c1._id,
      shopId: shop._id,
      productId: product._id,
      inventoryId: inventory._id,
      quantity: 1,
      activeKey: key,
    });
  } catch (err) {
    errCode = err.code;
  }
  assert(Boolean(r2), `same activeKey accepted after closure (err=${errCode})`);
}

async function testA10_serialization() {
  section('A10. Serialization guards');
  const c1 = await makeUser('customer');
  const { shop, product, inventory } = await makeListing({ quantity: 5 });
  const r = await makeReservation({
    customerId: c1._id,
    shopId: shop._id,
    productId: product._id,
    inventoryId: inventory._id,
    quantity: 2,
    holdState: HOLD_STATES.HELD,
    activeKey: `ser_${RUN_SUFFIX}`,
  });
  await Reservation.updateOne({ _id: r._id }, { $set: { settledAt: new Date() } });

  const rDoc = await Reservation.findById(r._id);
  const rJson = rDoc.toJSON();
  assert(
    !INTERNAL_RESERVATION_KEYS.some((k) => k in rJson),
    `reservation toJSON hides internals (keys: ${Object.keys(rJson).join(',')})`
  );
  assert(rJson.quantity === 2 && rJson.status === 'PENDING', 'reservation toJSON keeps public fields');

  const invDoc = await Inventory.findById(inventory._id);
  const invJson = invDoc.toJSON();
  assert(!('heldReservations' in invJson), 'inventory toJSON hides heldReservations');
  assert(
    typeof invJson.availableQuantity === 'number',
    `inventory toJSON exposes availableQuantity (got ${invJson.availableQuantity})`
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION A2 — Stage 4 settlement: cancel / pickup / expiry / recovery
// ══════════════════════════════════════════════════════════════════════════════

async function testA11_cancelReleasesOnce() {
  section('A11. Cancel releases stock once and closes CANCELLED');
  const customer = await makeUser('customer');
  const { shop, product, inventory } = await makeListing({ quantity: 5 });
  const r = await makeActiveReservation({
    customerId: customer._id,
    shopId: shop._id,
    productId: product._id,
    inventoryId: inventory._id,
    quantity: 2,
  });

  const pre = await readInv(inventory._id);
  assert(pre.reservedQuantity === 2, `precondition: 2 held (got ${pre.reservedQuantity})`);

  const o1 = await svc.settleReservation(r._id, 'CANCEL');
  assert(o1.ok === true, `cancel ok (got ${JSON.stringify(o1)})`);
  assert(o1.status === 'CANCELLED', `status CANCELLED (got ${o1.status})`);

  const inv = await readInv(inventory._id);
  assert(inv.reservedQuantity === 0, `reservedQuantity 0 after cancel (got ${inv.reservedQuantity})`);
  assert(inv.quantity === 5, `quantity untouched by cancel (got ${inv.quantity})`);
  assert((inv.heldReservations || []).length === 0, 'marker removed');

  const res = await readRes(r._id);
  assert(res.status === 'CANCELLED', `reservation CANCELLED (got ${res.status})`);
  assert(res.activeKey === undefined, `activeKey freed (got ${res.activeKey})`);

  // Repeated cancel must be a no-op (at-most-once release).
  const o2 = await svc.settleReservation(r._id, 'CANCEL');
  assert(o2.ok === true && o2.alreadySettled === true, `repeat cancel idempotent (got ${JSON.stringify(o2)})`);
  const inv2 = await readInv(inventory._id);
  assert(inv2.reservedQuantity === 0, `no double release (got ${inv2.reservedQuantity})`);
  assert(inv2.quantity === 5, `quantity still 5 (got ${inv2.quantity})`);
}

async function testA12_pickupConsumesOnce() {
  section('A12. Pickup consumes stock once and closes FULFILLED');
  const customer = await makeUser('customer');
  const { shop, product, inventory } = await makeListing({ quantity: 5 });
  const r = await makeActiveReservation({
    customerId: customer._id,
    shopId: shop._id,
    productId: product._id,
    inventoryId: inventory._id,
    quantity: 3,
  });

  const o1 = await svc.settleReservation(r._id, 'FULFILL');
  assert(o1.ok === true, `pickup ok (got ${JSON.stringify(o1)})`);
  assert(o1.status === 'FULFILLED', `status FULFILLED (got ${o1.status})`);

  const inv = await readInv(inventory._id);
  assert(inv.quantity === 2, `quantity 5-3=2 (got ${inv.quantity})`);
  assert(inv.reservedQuantity === 0, `reservedQuantity 0 (got ${inv.reservedQuantity})`);
  assert((inv.heldReservations || []).length === 0, 'marker removed');

  // Repeated pickup must not decrement again.
  const o2 = await svc.settleReservation(r._id, 'FULFILL');
  assert(o2.ok === true && o2.alreadySettled === true, `repeat pickup idempotent (got ${JSON.stringify(o2)})`);
  const inv2 = await readInv(inventory._id);
  assert(inv2.quantity === 2, `quantity still 2 (no double decrement) (got ${inv2.quantity})`);
  assert(inv2.reservedQuantity === 0, `reservedQuantity still 0 (got ${inv2.reservedQuantity})`);
}

async function testA13_expiredCannotBeFulfilled() {
  section('A13. Expired reservation cannot be picked up; hold released');
  const customer = await makeUser('customer');
  const { shop, product, inventory } = await makeListing({ quantity: 5 });
  const r = await makeActiveReservation({
    customerId: customer._id,
    shopId: shop._id,
    productId: product._id,
    inventoryId: inventory._id,
    quantity: 2,
    expiresAt: PAST(),
  });

  const pre = await readInv(inventory._id);
  assert(pre.reservedQuantity === 2, `precondition: held while expired (got ${pre.reservedQuantity})`);

  const o = await svc.settleReservation(r._id, 'FULFILL');
  assert(o.ok === false, `pickup refused (got ${JSON.stringify(o)})`);
  assert(o.reason === 'EXPIRED', `reason EXPIRED (got ${o.reason})`);
  assert(o.status === 'EXPIRED', `status EXPIRED (got ${o.status})`);

  const inv = await readInv(inventory._id);
  assert(inv.quantity === 5, `quantity NOT consumed (got ${inv.quantity})`);
  assert(inv.reservedQuantity === 0, `hold released (got ${inv.reservedQuantity})`);
  const res = await readRes(r._id);
  assert(res.status === 'EXPIRED', `reservation EXPIRED (got ${res.status})`);
}

async function testA14_recoveryWidowSettleBeforeClose() {
  section('A14. Recovery: crash between settlement and close (W-settle)');

  // (a) release settled, close not reached → recovery must finalize CANCELLED, never re-claim.
  const c1 = await makeUser('customer');
  const l1 = await makeListing({ quantity: 5 });
  const r1 = await makeActiveReservation({
    customerId: c1._id,
    shopId: l1.shop._id,
    productId: l1.product._id,
    inventoryId: l1.inventory._id,
    quantity: 2,
  });
  await svc.releaseStockHold(r1._id); // simulate the settlement half of a crash
  const mid1 = await readRes(r1._id);
  assert(mid1.status === 'ACTIVE' && mid1.holdState === 'RELEASED',
    `mid-state open+RELEASED (got ${mid1.status}/${mid1.holdState})`);

  const rec1 = await svc.recoverReservation(r1._id);
  assert(rec1.status === 'FINALIZED', `recovery finalized release window (got ${rec1.status})`);
  const after1 = await readRes(r1._id);
  assert(after1.status === 'CANCELLED', `finalized to CANCELLED (got ${after1.status})`);
  const inv1 = await readInv(l1.inventory._id);
  assert(inv1.reservedQuantity === 0, `no re-claim / no double release (got ${inv1.reservedQuantity})`);
  assert(inv1.quantity === 5, `quantity untouched (got ${inv1.quantity})`);

  // (b) consume settled, close not reached → recovery must finalize FULFILLED, no double decrement.
  const c2 = await makeUser('customer');
  const l2 = await makeListing({ quantity: 5 });
  const r2 = await makeActiveReservation({
    customerId: c2._id,
    shopId: l2.shop._id,
    productId: l2.product._id,
    inventoryId: l2.inventory._id,
    quantity: 2,
  });
  await svc.consumeStockHold(r2._id); // simulate the settlement half of a crash
  const mid2 = await readRes(r2._id);
  assert(mid2.status === 'ACTIVE' && mid2.holdState === 'CONSUMED',
    `mid-state open+CONSUMED (got ${mid2.status}/${mid2.holdState})`);

  const rec2 = await svc.recoverReservation(r2._id);
  assert(rec2.status === 'FINALIZED', `recovery finalized consume window (got ${rec2.status})`);
  const after2 = await readRes(r2._id);
  assert(after2.status === 'FULFILLED', `finalized to FULFILLED (got ${after2.status})`);
  const inv2 = await readInv(l2.inventory._id);
  assert(inv2.quantity === 3, `quantity 5-2=3 not double-decremented (got ${inv2.quantity})`);
  assert(inv2.reservedQuantity === 0, `reservedQuantity 0 (got ${inv2.reservedQuantity})`);
}

async function testA15_concurrentCancelVsPickup() {
  section('A15. Concurrent cancel vs pickup: exactly one stock effect');
  const customer = await makeUser('customer');
  const { shop, product, inventory } = await makeListing({ quantity: 5 });
  const r = await makeActiveReservation({
    customerId: customer._id,
    shopId: shop._id,
    productId: product._id,
    inventoryId: inventory._id,
    quantity: 2,
  });

  const [c, p] = await Promise.all([
    svc.settleReservation(r._id, 'CANCEL'),
    svc.settleReservation(r._id, 'FULFILL'),
  ]);

  const inv = await readInv(inventory._id);
  assert(inv.reservedQuantity === 0, `reservedQuantity settles to 0 (got ${inv.reservedQuantity})`);
  assert((inv.heldReservations || []).length === 0, 'marker removed');
  const wins = (c.ok ? 1 : 0) + (p.ok ? 1 : 0);
  assert(wins === 1, `exactly one operation took effect (got ${wins})`);

  const res = await readRes(r._id);
  if (c.ok) {
    assert(inv.quantity === 5, `cancel winner: quantity 5 (got ${inv.quantity})`);
    assert(res.status === 'CANCELLED', `cancel winner: status CANCELLED (got ${res.status})`);
    assert(p.ok === false, `pickup reported failure (got ${JSON.stringify(p)})`);
  } else {
    assert(inv.quantity === 3, `pickup winner: quantity 3 (got ${inv.quantity})`);
    assert(res.status === 'FULFILLED', `pickup winner: status FULFILLED (got ${res.status})`);
    assert(c.ok === false, `cancel reported failure (got ${JSON.stringify(c)})`);
  }
}

async function testA16_expirySweep() {
  section('A16. Expiry sweep releases overdue holds exactly once');
  const c1 = await makeUser('customer');
  const c2 = await makeUser('customer');
  const c3 = await makeUser('customer');
  const { shop, product, inventory } = await makeListing({ quantity: 10 });

  const r1 = await makeActiveReservation({
    customerId: c1._id, shopId: shop._id, productId: product._id,
    inventoryId: inventory._id, quantity: 1, expiresAt: PAST(),
  });
  const r2 = await makeActiveReservation({
    customerId: c2._id, shopId: shop._id, productId: product._id,
    inventoryId: inventory._id, quantity: 2, expiresAt: PAST(),
  });
  const r3 = await makeActiveReservation({
    customerId: c3._id, shopId: shop._id, productId: product._id,
    inventoryId: inventory._id, quantity: 3, expiresAt: PAST(),
  });

  const pre = await readInv(inventory._id);
  assert(pre.reservedQuantity === 6, `precondition: 6 held (got ${pre.reservedQuantity})`);

  const summary = await svc.expireReservations({ shopId: shop._id, limit: 50 });
  assert(summary.scanned === 3, `scanned 3 (got ${summary.scanned})`);
  assert(summary.expired === 3, `expired 3 (got ${summary.expired})`);

  const inv = await readInv(inventory._id);
  assert(inv.reservedQuantity === 0, `all holds released (got ${inv.reservedQuantity})`);
  assert(inv.quantity === 10, `quantity untouched by expiry (got ${inv.quantity})`);

  for (const r of [r1, r2, r3]) {
    const doc = await readRes(r._id);
    assert(doc.status === 'EXPIRED', `reservation ${String(r._id).slice(-4)} EXPIRED (got ${doc.status})`);
  }

  // Idempotent: a second sweep finds nothing and changes nothing.
  const summary2 = await svc.expireReservations({ shopId: shop._id, limit: 50 });
  assert(summary2.scanned === 0, `second sweep scanned 0 (got ${summary2.scanned})`);
  const inv2 = await readInv(inventory._id);
  assert(inv2.reservedQuantity === 0, `no double release on re-sweep (got ${inv2.reservedQuantity})`);
}

async function testA17_terminalConflicts() {
  section('A17. Incompatible terminal transitions are refused');

  // Cancel after pickup → CONFLICT, no extra stock effect.
  const customer = await makeUser('customer');
  const { shop, product, inventory } = await makeListing({ quantity: 5 });
  const r = await makeActiveReservation({
    customerId: customer._id, shopId: shop._id, productId: product._id,
    inventoryId: inventory._id, quantity: 2,
  });
  const pick = await svc.settleReservation(r._id, 'FULFILL');
  assert(pick.ok === true, 'precondition: pickup succeeded');

  const lateCancel = await svc.settleReservation(r._id, 'CANCEL');
  assert(lateCancel.ok === false, `cancel after pickup refused (got ${JSON.stringify(lateCancel)})`);
  assert(lateCancel.reason === 'CONFLICT', `reason CONFLICT (got ${lateCancel.reason})`);
  assert(lateCancel.status === 'FULFILLED', `status FULFILLED (got ${lateCancel.status})`);
  const inv = await readInv(inventory._id);
  assert(inv.quantity === 3, `no extra stock change (got ${inv.quantity})`);
  assert(inv.reservedQuantity === 0, `reservedQuantity 0 (got ${inv.reservedQuantity})`);

  // Pickup on a PENDING (unclaimed) reservation → NOT_ACTIVE, stock untouched.
  const c2 = await makeUser('customer');
  const l2 = await makeListing({ quantity: 5 });
  const pending = await makeReservation({
    customerId: c2._id, shopId: l2.shop._id, productId: l2.product._id,
    inventoryId: l2.inventory._id, quantity: 2,
    activeKey: svc.buildActiveKey(c2._id, l2.inventory._id),
  });
  const notReady = await svc.settleReservation(pending._id, 'FULFILL');
  assert(notReady.ok === false && notReady.reason === 'NOT_ACTIVE',
    `PENDING pickup refused with NOT_ACTIVE (got ${JSON.stringify(notReady)})`);
  const inv2 = await readInv(l2.inventory._id);
  assert(inv2.reservedQuantity === 0, `PENDING pickup left stock untouched (got ${inv2.reservedQuantity})`);

  // Missing reservation → NOT_FOUND.
  const missing = await svc.settleReservation(new mongoose.Types.ObjectId(), 'CANCEL');
  assert(missing.ok === false && missing.reason === 'NOT_FOUND',
    `missing reservation -> NOT_FOUND (got ${JSON.stringify(missing)})`);
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION A3 — Stage 5 hardening: F2 recovery race + F1 expiry sweeper
// ══════════════════════════════════════════════════════════════════════════════

async function waitFor(predicate, timeoutMs = 3000, stepMs = 25) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}

async function testA18_recoveryDoesNotReclaim() {
  section('A18. F2: recovery never re-claims for an ACTIVE reservation with no hold marker');

  // (a) The exact reported race window: an ACTIVE reservation that is no longer in
  // `heldReservations` while its derived `holdState` still reads HELD (the instant
  // between the settlement's marker removal and its state write). The old code
  // re-claimed here and resurrected stock; recovery must now refuse and surface it.
  const c1 = await makeUser('customer');
  const l1 = await makeListing({ quantity: 5 });
  const r1 = await makeReservation({
    customerId: c1._id, shopId: l1.shop._id, productId: l1.product._id,
    inventoryId: l1.inventory._id, quantity: 2,
    status: RESERVATION_STATUSES.ACTIVE, holdState: HOLD_STATES.HELD,
    activeKey: svc.buildActiveKey(c1._id, l1.inventory._id),
  });
  const pre1 = await readInv(l1.inventory._id);
  assert(pre1.reservedQuantity === 0, `precondition: no stock held (got ${pre1.reservedQuantity})`);

  const rec1 = await svc.recoverReservation(r1._id);
  assert(rec1.status === 'INCONSISTENT',
    `ACTIVE + missing marker reported INCONSISTENT (got ${rec1.status})`);
  assert(rec1.held === false, `INCONSISTENT is not reported as held (got ${rec1.held})`);
  const inv1 = await readInv(l1.inventory._id);
  assert(inv1.reservedQuantity === 0,
    `F2: stock NOT resurrected (got ${inv1.reservedQuantity})`);
  assert(!(inv1.heldReservations || []).some((h) => String(h) === String(r1._id)),
    'F2: no marker fabricated');
  const after1 = await readRes(r1._id);
  assert(after1.status === 'ACTIVE', `status left open for a human (got ${after1.status})`);

  // (b) Same window racing an actual release: recovery must not resurrect the hold
  // the concurrent release just dropped (the reported release-vs-recovery race).
  const c2 = await makeUser('customer');
  const l2 = await makeListing({ quantity: 5 });
  const r2 = await makeReservation({
    customerId: c2._id, shopId: l2.shop._id, productId: l2.product._id,
    inventoryId: l2.inventory._id, quantity: 2,
    status: RESERVATION_STATUSES.ACTIVE, holdState: HOLD_STATES.HELD,
    activeKey: svc.buildActiveKey(c2._id, l2.inventory._id),
  });
  await Promise.all([
    svc.releaseStockHold(r2._id),
    svc.recoverReservation(r2._id),
  ]);
  const inv2 = await readInv(l2.inventory._id);
  assert(inv2.reservedQuantity === 0,
    `F2 race: reservedQuantity never resurrected (got ${inv2.reservedQuantity})`);
  assert(inv2.quantity === 5, `F2 race: quantity untouched (got ${inv2.quantity})`);
  assert(!(inv2.heldReservations || []).some((h) => String(h) === String(r2._id)),
    'F2 race: marker not resurrected');

  // (c) A genuinely fresh PENDING + UNCLAIMED reservation is still reclaimable (W1).
  const c3 = await makeUser('customer');
  const l3 = await makeListing({ quantity: 5 });
  const fresh = await makeReservation({
    customerId: c3._id, shopId: l3.shop._id, productId: l3.product._id,
    inventoryId: l3.inventory._id, quantity: 2,
    status: RESERVATION_STATUSES.PENDING, holdState: HOLD_STATES.UNCLAIMED,
    activeKey: svc.buildActiveKey(c3._id, l3.inventory._id),
  });
  const rec3 = await svc.recoverReservation(fresh._id);
  assert(rec3.status === 'RECLAIMED', `fresh PENDING reclaimed (got ${rec3.status})`);
  assert(rec3.held === true, 'fresh PENDING reported as held');
  const inv3 = await readInv(l3.inventory._id);
  assert(inv3.reservedQuantity === 2, `fresh PENDING claimed 2 (got ${inv3.reservedQuantity})`);
  const after3 = await readRes(fresh._id);
  assert(after3.status === 'ACTIVE', `fresh PENDING promoted to ACTIVE (got ${after3.status})`);

  // (d) Concurrency storm: reconcile alongside a cancel must stay consistent.
  const c4 = await makeUser('customer');
  const l4 = await makeListing({ quantity: 5 });
  const r4 = await makeActiveReservation({
    customerId: c4._id, shopId: l4.shop._id, productId: l4.product._id,
    inventoryId: l4.inventory._id, quantity: 2,
  });
  await Promise.all([
    svc.reconcileInventory(l4.inventory._id),
    svc.settleReservation(r4._id, 'CANCEL'),
  ]);
  const inv4 = await readInv(l4.inventory._id);
  assert(inv4.reservedQuantity === 0,
    `storm: reservedQuantity consistent at 0 (got ${inv4.reservedQuantity})`);
  assert(inv4.quantity === 5, `storm: quantity untouched (got ${inv4.quantity})`);
  assert((inv4.heldReservations || []).length === 0, 'storm: no lingering markers');
}

async function testA19_expirySweeper() {
  section('A19. F1: bounded, non-overlapping, error-contained expiry sweeper');

  // (a) Test-mode determinism: scheduling is a no-op when disabled.
  const off = svc.createExpirySweeper({ enabled: false, intervalMs: 10 });
  assert(off.start() === false, 'start() is a no-op when disabled (test mode)');
  off.stop();
  assert(off.isRunning() === false, 'nothing in flight when disabled');

  // (b) One sweep releases every overdue hold exactly once, closing EXPIRED.
  const c1 = await makeUser('customer');
  const c2 = await makeUser('customer');
  const { shop, product, inventory } = await makeListing({ quantity: 10 });
  const r1 = await makeActiveReservation({
    customerId: c1._id, shopId: shop._id, productId: product._id,
    inventoryId: inventory._id, quantity: 2, expiresAt: PAST(),
  });
  const r2 = await makeActiveReservation({
    customerId: c2._id, shopId: shop._id, productId: product._id,
    inventoryId: inventory._id, quantity: 3, expiresAt: PAST(),
  });
  const sweeper = svc.createExpirySweeper({ enabled: false, limit: 50 });
  const s1 = await sweeper.run();
  assert(s1.expired === 2, `sweep expired 2 (got ${s1.expired})`);
  const inv = await readInv(inventory._id);
  assert(inv.reservedQuantity === 0, `all holds released once (got ${inv.reservedQuantity})`);
  assert(inv.quantity === 10, `quantity untouched by expiry (got ${inv.quantity})`);
  for (const r of [r1, r2]) {
    const d = await readRes(r._id);
    assert(d.status === 'EXPIRED', `reservation EXPIRED (got ${d.status})`);
  }

  // (c) Repeated sweeps are idempotent — no double release.
  const s2 = await sweeper.run();
  assert(s2.scanned === 0, `repeat sweep scans nothing (got ${s2.scanned})`);
  const inv2 = await readInv(inventory._id);
  assert(inv2.reservedQuantity === 0, `repeat sweep: still 0 (got ${inv2.reservedQuantity})`);
  assert(inv2.quantity === 10, `repeat sweep: quantity still 10 (got ${inv2.quantity})`);

  // (d) Overlap guard: a tick arriving mid-sweep is skipped.
  const [first, second] = await Promise.all([sweeper.run(), sweeper.run()]);
  assert(second.skipped === true, `concurrent run skipped (got ${JSON.stringify(second)})`);
  assert(first.skipped !== true, 'first concurrent run executed the sweep');

  // (e) Error containment: a failing sweep is swallowed, never thrown.
  const boom = svc.createExpirySweeper({
    enabled: false,
    sweepFn: async () => {
      throw new Error('sweep boom');
    },
  });
  let thrown = null;
  let outcome = null;
  try {
    outcome = await boom.run();
  } catch (err) {
    thrown = err;
  }
  assert(thrown === null, 'run() did not throw on sweep failure');
  assert(outcome && outcome.error === 'sweep boom',
    `run() reported the error (got ${JSON.stringify(outcome)})`);

  // (f) Automatic (timer-driven) expiry: a started sweeper drains overdue holds.
  const c3 = await makeUser('customer');
  const l2 = await makeListing({ quantity: 5 });
  const r3 = await makeActiveReservation({
    customerId: c3._id, shopId: l2.shop._id, productId: l2.product._id,
    inventoryId: l2.inventory._id, quantity: 2, expiresAt: PAST(),
  });
  const auto = svc.createExpirySweeper({ enabled: true, intervalMs: 40, limit: 50 });
  assert(auto.start() === true, 'auto sweeper started');
  const drained = await waitFor(async () => {
    const d = await readRes(r3._id);
    return d.status === RESERVATION_STATUSES.EXPIRED;
  }, 3000);
  auto.stop();
  assert(drained, 'timer-driven sweep expired the reservation');
  const inv3 = await readInv(l2.inventory._id);
  assert(inv3.reservedQuantity === 0, `auto sweep released once (got ${inv3.reservedQuantity})`);
  assert(inv3.quantity === 5, `auto sweep left quantity untouched (got ${inv3.quantity})`);

  // After stop(), the sweeper no longer fires and there is nothing left to do.
  const stopped = await svc.createExpirySweeper({ enabled: false }).run();
  assert(stopped.scanned === 0, 'post-stop sweep finds nothing left');
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION B — HTTP API integration
// ══════════════════════════════════════════════════════════════════════════════

function waitForHealth(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = async () => {
      try {
        const res = await request('GET', '/health');
        if (res.status === 200) return resolve(true);
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) return resolve(false);
      setTimeout(tick, 300);
    };
    tick();
  });
}

async function loginUser(user) {
  const res = await request('POST', '/auth/login', {
    body: { email: user.email, password: PASSWORD },
  });
  if (res.status !== 200 || !res.cookie) {
    throw new Error(`Login failed for ${user.email} (status ${res.status})`);
  }
  return res.cookie;
}

async function testB0_health() {
  section('B0. Spawned API server health');
  const res = await request('GET', '/health');
  assert(res.status === 200, `health 200 (got ${res.status})`);
}

async function testB1_validation(customerCookie) {
  section('B1. POST /reservations validation (400)');
  const { inventory } = await makeListing({ quantity: 10 });
  const goodId = String(inventory._id);

  const cases = [
    { body: {}, label: 'empty body' },
    { body: { inventory: 'not-an-id', quantity: 1 }, label: 'invalid inventory id' },
    { body: { inventory: goodId }, label: 'missing quantity' },
    { body: { inventory: goodId, quantity: 0 }, label: 'quantity 0 (below min)' },
    { body: { inventory: goodId, quantity: 11 }, label: 'quantity 11 (above max)' },
    { body: { inventory: goodId, quantity: 1.5 }, label: 'quantity 1.5 (non-integer)' },
    { body: { inventory: goodId, quantity: 2, foo: 'bar' }, label: 'unknown field' },
  ];

  for (const c of cases) {
    const res = await request('POST', '/reservations', {
      cookie: customerCookie,
      body: c.body,
    });
    assert(res.status === 400, `${c.label} -> 400 (got ${res.status})`);
    assert(
      res.body && res.body.success === false,
      `${c.label} -> success false`
    );
  }
}

async function testB2_auth(customerCookie, sellerCookie) {
  section('B2. Auth / role enforcement');
  const { inventory } = await makeListing({ quantity: 10 });
  const body = { inventory: String(inventory._id), quantity: 1 };

  const noAuth = await request('POST', '/reservations', { body });
  assert(noAuth.status === 401, `unauthenticated -> 401 (got ${noAuth.status})`);

  const asSeller = await request('POST', '/reservations', {
    cookie: sellerCookie,
    body,
  });
  assert(asSeller.status === 403, `seller -> 403 (got ${asSeller.status})`);

  const myAsSeller = await request('GET', '/reservations/mine', { cookie: sellerCookie });
  assert(myAsSeller.status === 403, `seller on /mine -> 403 (got ${myAsSeller.status})`);

  const shopAsCustomer = await request('GET', '/reservations/shop', { cookie: customerCookie });
  assert(shopAsCustomer.status === 403, `customer on /shop -> 403 (got ${shopAsCustomer.status})`);
}

async function testB3_createSuccess(customerCookie) {
  section('B3. Successful reservation creation (201)');
  const { inventory } = await makeListing({ quantity: 10, pricePaise: 4500 });

  const res = await request('POST', '/reservations', {
    cookie: customerCookie,
    body: { inventory: String(inventory._id), quantity: 3 },
  });
  assert(res.status === 201, `create -> 201 (got ${res.status})`);
  const r = res.body && res.body.data && res.body.data.reservation;
  assert(Boolean(r), 'response contains reservation');

  if (r) {
    assert(r.status === 'ACTIVE', `status ACTIVE (got ${r.status})`);
    assert(r.quantity === 3, `quantity 3 (got ${r.quantity})`);
    assert(r.pricePaise === 4500, `price snapshot 4500 (got ${r.pricePaise})`);
    assert(
      String(r.inventory) === String(inventory._id),
      'inventory reference matches'
    );

    const expected = Date.now() + 120 * 60 * 1000;
    const delta = Math.abs(new Date(r.expiresAt).getTime() - expected);
    assert(
      delta < 60000,
      `expiresAt ~= now + 120min (delta ${Math.round(delta / 1000)}s)`
    );

    assert(!jsonLeaksInternals(r), 'response hides internal reservation fields');
  }

  const inv = await readInv(inventory._id);
  assert(inv.reservedQuantity === 3, `inventory reservedQuantity 3 (got ${inv.reservedQuantity})`);

  return r;
}

async function testB4_insufficientStock(customerCookie) {
  section('B4. Insufficient stock (409)');
  const { inventory } = await makeListing({ quantity: 1 });
  const res = await request('POST', '/reservations', {
    cookie: customerCookie,
    body: { inventory: String(inventory._id), quantity: 5 },
  });
  assert(res.status === 409, `insufficient stock -> 409 (got ${res.status})`);
  assert(
    typeof res.body.message === 'string' && /insufficient stock/i.test(res.body.message),
    `message mentions insufficient stock (got "${res.body && res.body.message}")`
  );
  const inv = await readInv(inventory._id);
  assert(inv.reservedQuantity === 0, `no phantom stock held (got ${inv.reservedQuantity})`);
}

async function testB5_shopStateGating(customerCookie) {
  section('B5. Shop verification / open gating (409)');

  const unverified = await makeListing({ quantity: 10, isVerified: false, isOpen: true });
  const resUnverified = await request('POST', '/reservations', {
    cookie: customerCookie,
    body: { inventory: String(unverified.inventory._id), quantity: 1 },
  });
  assert(resUnverified.status === 409, `unverified shop -> 409 (got ${resUnverified.status})`);

  const closed = await makeListing({ quantity: 10, isVerified: true, isOpen: false });
  const resClosed = await request('POST', '/reservations', {
    cookie: customerCookie,
    body: { inventory: String(closed.inventory._id), quantity: 1 },
  });
  assert(resClosed.status === 409, `closed shop -> 409 (got ${resClosed.status})`);
  assert(
    typeof resClosed.body.message === 'string' && /closed/i.test(resClosed.body.message),
    `closed-shop message is distinct (got "${resClosed.body && resClosed.body.message}")`
  );
}

async function testB6_productAndInventoryGating(customerCookie) {
  section('B6. Product status / inventory active gating (409)');

  const pendingProduct = await makeListing({ quantity: 10, productStatus: 'PENDING' });
  const resPending = await request('POST', '/reservations', {
    cookie: customerCookie,
    body: { inventory: String(pendingProduct.inventory._id), quantity: 1 },
  });
  assert(resPending.status === 409, `non-ACTIVE product -> 409 (got ${resPending.status})`);

  const inactiveInv = await makeListing({ quantity: 10, isActive: false });
  const resInactive = await request('POST', '/reservations', {
    cookie: customerCookie,
    body: { inventory: String(inactiveInv.inventory._id), quantity: 1 },
  });
  assert(resInactive.status === 409, `inactive inventory -> 409 (got ${resInactive.status})`);
}

async function testB7_duplicateActiveReservation(customerCookie) {
  section('B7. Duplicate active reservation (409, distinct message)');
  const { inventory } = await makeListing({ quantity: 10 });
  const body = { inventory: String(inventory._id), quantity: 1 };

  const first = await request('POST', '/reservations', { cookie: customerCookie, body });
  assert(first.status === 201, `first create -> 201 (got ${first.status})`);

  const second = await request('POST', '/reservations', { cookie: customerCookie, body });
  assert(second.status === 409, `second create -> 409 (got ${second.status})`);
  assert(
    typeof second.body.message === 'string' && /active reservation/i.test(second.body.message),
    `duplicate message is distinct (got "${second.body && second.body.message}")`
  );

  const inv = await readInv(inventory._id);
  assert(
    inv.reservedQuantity === 1,
    `only one unit held after duplicate attempt (got ${inv.reservedQuantity})`
  );
}

async function testB8_readEndpoints(customerCookie, sellerCookie) {
  section('B8. Customer + seller read endpoints and data scope');

  // Dedicated listing + reservation owned by the "primary" customer.
  const seller = await makeUser('seller');
  const shop = await makeShop(seller._id, { isVerified: true, isOpen: true });
  const product = await makeProduct({ status: 'ACTIVE', createdBy: seller._id });
  const inventory = await makeInventory({ shopId: shop._id, productId: product._id, quantity: 10 });
  const sellerCookie2 = await loginUser(seller);

  const primary = await makeUser('customer');
  const primaryCookie = await loginUser(primary);

  const created = await request('POST', '/reservations', {
    cookie: primaryCookie,
    body: { inventory: String(inventory._id), quantity: 2 },
  });
  assert(created.status === 201, `primary create -> 201 (got ${created.status})`);
  const createdId = created.body.data.reservation._id;

  // Customer list
  const mine = await request('GET', '/reservations/mine', { cookie: primaryCookie });
  assert(mine.status === 200, `GET /mine -> 200 (got ${mine.status})`);
  const mineRows = (mine.body && mine.body.data && mine.body.data.reservations) || [];
  assert(
    mineRows.some((r) => String(r._id) === String(createdId)),
    'GET /mine includes own reservation'
  );
  assert(
    !mineRows.some((r) => jsonLeaksInternals(r)),
    'GET /mine rows hide internal fields'
  );

  // Customer detail (own)
  const detail = await request('GET', `/reservations/mine/${createdId}`, {
    cookie: primaryCookie,
  });
  assert(detail.status === 200, `GET /mine/:id own -> 200 (got ${detail.status})`);

  // Another customer cannot see it
  const otherCookie = await loginUser(await makeUser('customer'));
  const foreign = await request('GET', `/reservations/mine/${createdId}`, {
    cookie: otherCookie,
  });
  assert(foreign.status === 404, `other customer GET /mine/:id -> 404 (got ${foreign.status})`);

  // Seller list (own shop only)
  const shopList = await request('GET', '/reservations/shop', { cookie: sellerCookie2 });
  assert(shopList.status === 200, `GET /shop -> 200 (got ${shopList.status})`);
  const shopRows = (shopList.body && shopList.body.data && shopList.body.data.reservations) || [];
  assert(
    shopRows.some((r) => String(r._id) === String(createdId)),
    "GET /shop includes the shop's reservation"
  );
  assert(
    shopRows.every((r) => String(r.shop) === String(shop._id)),
    'GET /shop is scoped to the seller shop'
  );
  assert(
    !shopRows.some((r) => jsonLeaksInternals(r)),
    'GET /shop rows hide internal fields'
  );

  // A different seller sees none of this shop's reservations
  const otherSeller = await makeUser('seller');
  await makeShop(otherSeller._id, { isVerified: true, isOpen: true });
  const otherSellerCookie = await loginUser(otherSeller);
  const otherShopList = await request('GET', '/reservations/shop', { cookie: otherSellerCookie });
  const otherRows = (otherShopList.body && otherShopList.body.data && otherShopList.body.data.reservations) || [];
  assert(
    !otherRows.some((r) => String(r._id) === String(createdId)),
    'another seller cannot see this shop reservations'
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION C — HTTP settlement endpoints (cancel / pickup / expiry)
// ══════════════════════════════════════════════════════════════════════════════

// Build a listing + logged-in seller + logged-in customer whose reservation was
// created over HTTP (so it is ACTIVE + HELD through the real controller path).
async function httpFixture({ quantity = 10, customerQty = 2 } = {}) {
  const seller = await makeUser('seller');
  const shop = await makeShop(seller._id, { isVerified: true, isOpen: true });
  const product = await makeProduct({ status: 'ACTIVE', createdBy: seller._id });
  const inventory = await makeInventory({
    shopId: shop._id,
    productId: product._id,
    quantity,
  });
  const sellerCookie = await loginUser(seller);
  const customer = await makeUser('customer');
  const customerCookie = await loginUser(customer);

  const created = await request('POST', '/reservations', {
    cookie: customerCookie,
    body: { inventory: String(inventory._id), quantity: customerQty },
  });
  const reservation =
    created.body && created.body.data && created.body.data.reservation;

  return { seller, shop, product, inventory, sellerCookie, customer, customerCookie, created, reservation };
}

async function testC1_customerCancel(customerCookie) {
  section('C1. Customer cancels own reservation (200, idempotent)');
  const fx = await httpFixture({ quantity: 5, customerQty: 2 });
  assert(fx.created.status === 201, `fixture create 201 (got ${fx.created.status})`);
  const id = fx.reservation._id;

  const before = await readInv(fx.inventory._id);
  assert(before.reservedQuantity === 2, `precondition: 2 held (got ${before.reservedQuantity})`);

  const cancel = await request('PATCH', `/reservations/mine/${id}/cancel`, {
    cookie: fx.customerCookie,
  });
  assert(cancel.status === 200, `cancel -> 200 (got ${cancel.status})`);
  const body = cancel.body && cancel.body.data && cancel.body.data.reservation;
  assert(body && body.status === 'CANCELLED', `status CANCELLED (got ${body && body.status})`);
  assert(!jsonLeaksInternals(body), 'cancel response hides internal fields');

  const inv = await readInv(fx.inventory._id);
  assert(inv.reservedQuantity === 0, `stock released (got ${inv.reservedQuantity})`);
  assert(inv.quantity === 5, `quantity untouched (got ${inv.quantity})`);

  // Repeat is idempotent.
  const again = await request('PATCH', `/reservations/mine/${id}/cancel`, {
    cookie: fx.customerCookie,
  });
  assert(again.status === 200, `repeat cancel -> 200 (got ${again.status})`);
  const inv2 = await readInv(fx.inventory._id);
  assert(inv2.reservedQuantity === 0 && inv2.quantity === 5, `no double effect on repeat`);
}

async function testC2_customerCancelScope() {
  section('C2. Customer cannot cancel another customer reservation (404)');
  const fx = await httpFixture({ quantity: 5, customerQty: 1 });
  const otherCookie = await loginUser(await makeUser('customer'));
  const res = await request('PATCH', `/reservations/mine/${fx.reservation._id}/cancel`, {
    cookie: otherCookie,
  });
  assert(res.status === 404, `foreign cancel -> 404 (got ${res.status})`);
}

async function testC3_sellerCancelScope() {
  section('C3. Seller cancels own shop reservation; other seller 404');
  const fx = await httpFixture({ quantity: 5, customerQty: 2 });

  // Another seller cannot touch it.
  const otherSeller = await makeUser('seller');
  await makeShop(otherSeller._id, { isVerified: true, isOpen: true });
  const otherSellerCookie = await loginUser(otherSeller);
  const foreign = await request('PATCH', `/reservations/shop/${fx.reservation._id}/cancel`, {
    cookie: otherSellerCookie,
  });
  assert(foreign.status === 404, `other seller cancel -> 404 (got ${foreign.status})`);

  // Owning seller can.
  const own = await request('PATCH', `/reservations/shop/${fx.reservation._id}/cancel`, {
    cookie: fx.sellerCookie,
  });
  assert(own.status === 200, `owning seller cancel -> 200 (got ${own.status})`);
  const body = own.body && own.body.data && own.body.data.reservation;
  assert(body && body.status === 'CANCELLED', `status CANCELLED (got ${body && body.status})`);
  assert(!jsonLeaksInternals(body), 'seller cancel response hides internal fields');

  const inv = await readInv(fx.inventory._id);
  assert(inv.reservedQuantity === 0, `stock released (got ${inv.reservedQuantity})`);
  assert(inv.quantity === 5, `quantity untouched (got ${inv.quantity})`);
}

async function testC4_sellerPickup() {
  section('C4. Seller pickups own shop reservation (200, idempotent)');
  const fx = await httpFixture({ quantity: 5, customerQty: 3 });
  const id = fx.reservation._id;

  const pick = await request('PATCH', `/reservations/shop/${id}/pickup`, {
    cookie: fx.sellerCookie,
  });
  assert(pick.status === 200, `pickup -> 200 (got ${pick.status})`);
  const body = pick.body && pick.body.data && pick.body.data.reservation;
  assert(body && body.status === 'FULFILLED', `status FULFILLED (got ${body && body.status})`);
  assert(!jsonLeaksInternals(body), 'pickup response hides internal fields');

  const inv = await readInv(fx.inventory._id);
  assert(inv.quantity === 2, `quantity 5-3=2 (got ${inv.quantity})`);
  assert(inv.reservedQuantity === 0, `reservedQuantity 0 (got ${inv.reservedQuantity})`);

  // Repeat must not double-decrement.
  const again = await request('PATCH', `/reservations/shop/${id}/pickup`, {
    cookie: fx.sellerCookie,
  });
  assert(again.status === 200, `repeat pickup -> 200 (got ${again.status})`);
  const inv2 = await readInv(fx.inventory._id);
  assert(inv2.quantity === 2, `no double decrement on repeat (got ${inv2.quantity})`);
  assert(inv2.reservedQuantity === 0, `reservedQuantity still 0 (got ${inv2.reservedQuantity})`);
}

async function testC5_expiredPickupRefused() {
  section('C5. Expired reservation cannot be picked up (409, hold released)');
  const fx = await httpFixture({ quantity: 5, customerQty: 2 });
  await Reservation.updateOne(
    { _id: fx.reservation._id },
    { $set: { expiresAt: PAST() } }
  );

  const pick = await request('PATCH', `/reservations/shop/${fx.reservation._id}/pickup`, {
    cookie: fx.sellerCookie,
  });
  assert(pick.status === 409, `expired pickup -> 409 (got ${pick.status})`);
  assert(
    typeof pick.body.message === 'string' && /expired/i.test(pick.body.message),
    `message mentions expiry (got "${pick.body && pick.body.message}")`
  );

  const inv = await readInv(fx.inventory._id);
  assert(inv.quantity === 5, `quantity NOT consumed (got ${inv.quantity})`);
  assert(inv.reservedQuantity === 0, `hold released (got ${inv.reservedQuantity})`);
  const doc = await readRes(fx.reservation._id);
  assert(doc.status === 'EXPIRED', `reservation EXPIRED (got ${doc.status})`);
}

async function testC6_authAndValidation(customerCookie, sellerCookie) {
  section('C6. Settlement auth / validation');
  const fx = await httpFixture({ quantity: 5, customerQty: 1 });
  const id = fx.reservation._id;

  // Customer cannot use the seller pickup route.
  const custPick = await request('PATCH', `/reservations/shop/${id}/pickup`, {
    cookie: fx.customerCookie,
  });
  assert(custPick.status === 403, `customer pickup -> 403 (got ${custPick.status})`);

  // Seller cannot use the customer cancel route.
  const sellCancel = await request('PATCH', `/reservations/mine/${id}/cancel`, {
    cookie: sellerCookie,
  });
  assert(sellCancel.status === 403, `seller on /mine cancel -> 403 (got ${sellCancel.status})`);

  // Unauthenticated is rejected.
  const noAuth = await request('PATCH', `/reservations/mine/${id}/cancel`);
  assert(noAuth.status === 401, `unauthenticated cancel -> 401 (got ${noAuth.status})`);

  // Invalid ObjectId is a validation error.
  const badId = await request('PATCH', `/reservations/mine/not-an-id/cancel`, {
    cookie: fx.customerCookie,
  });
  assert(badId.status === 400, `invalid id -> 400 (got ${badId.status})`);

  // Seller pickup on another shop's reservation → 404.
  const foreign = await request('PATCH', `/reservations/shop/${id}/pickup`, {
    cookie: sellerCookie,
  });
  assert(foreign.status === 404, `seller pickup on foreign shop -> 404 (got ${foreign.status})`);
}

async function testC7_sellerExpirySweep() {
  section('C7. Seller expiry sweep is scoped to the seller shop');
  const fx = await httpFixture({ quantity: 5, customerQty: 2 });
  await Reservation.updateOne(
    { _id: fx.reservation._id },
    { $set: { expiresAt: PAST() } }
  );

  // A second shop with its own overdue, held reservation.
  const seller2 = await makeUser('seller');
  const shop2 = await makeShop(seller2._id, { isVerified: true, isOpen: true });
  const product2 = await makeProduct({ status: 'ACTIVE', createdBy: seller2._id });
  const inventory2 = await makeInventory({ shopId: shop2._id, productId: product2._id, quantity: 5 });
  const customer2 = await makeUser('customer');
  const otherRes = await makeActiveReservation({
    customerId: customer2._id,
    shopId: shop2._id,
    productId: product2._id,
    inventoryId: inventory2._id,
    quantity: 2,
    expiresAt: PAST(),
  });

  const sweep = await request('POST', '/reservations/shop/expire', {
    cookie: fx.sellerCookie,
  });
  assert(sweep.status === 200, `sweep -> 200 (got ${sweep.status})`);
  const summary = sweep.body && sweep.body.data && sweep.body.data.summary;
  assert(summary && summary.expired >= 1, `summary reports an expiry (got ${JSON.stringify(summary)})`);

  const own = await readRes(fx.reservation._id);
  assert(own.status === 'EXPIRED', `own shop reservation EXPIRED (got ${own.status})`);
  const ownInv = await readInv(fx.inventory._id);
  assert(ownInv.reservedQuantity === 0, `own shop stock released (got ${ownInv.reservedQuantity})`);

  const foreign = await readRes(otherRes._id);
  assert(foreign.status === 'ACTIVE', `other shop reservation untouched (got ${foreign.status})`);
  const foreignInv = await readInv(inventory2._id);
  assert(foreignInv.reservedQuantity === 2, `other shop stock still held (got ${foreignInv.reservedQuantity})`);
}

// ══════════════════════════════════════════════════════════════════════════════
// Runner
// ══════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('\n=== FindLocal Phase 7 Reservation Tests ===');
  console.log(`  Base database (from .env): ${BASE_DB_NAME}`);
  console.log(`  Isolated test database:    ${TEST_DB_NAME}`);
  console.log(`  API test port:             ${TEST_PORT}`);

  let connected = false;
  let server = null;

  try {
    section('Setup: connect to isolated test database');
    await mongoose.connect(TEST_URI);
    connected = true;
    console.log(`  Connected: ${mongoose.connection.host}/${mongoose.connection.name}`);
    assert(mongoose.connection.name === TEST_DB_NAME, `using isolated DB ${TEST_DB_NAME}`);

    // Build required indexes before relying on unique-index behaviour.
    await Promise.all([
      User.init(),
      Shop.init(),
      Product.init(),
      Inventory.init(),
      Reservation.init(),
    ]);
    console.log('  Indexes ensured.');

    // ── Section A ────────────────────────────────────────────────────────────
    await testA1_concurrentSameClaim();
    await testA2_oversellBoundary();
    await testA3_releaseVsConsume();
    await testA4_reconcileRacingClaim();
    await testA5_staleTerminalMarkers();
    await testA6_missingReservationDoc();
    await testA7_fulfilledMarkers();
    await testA8_duplicateActiveKey();
    await testA9_activeKeyReuseAfterClosure();
    await testA10_serialization();

    // ── Section A2 — Stage 4 settlement ──────────────────────────────────────
    await testA11_cancelReleasesOnce();
    await testA12_pickupConsumesOnce();
    await testA13_expiredCannotBeFulfilled();
    await testA14_recoveryWidowSettleBeforeClose();
    await testA15_concurrentCancelVsPickup();
    await testA16_expirySweep();
    await testA17_terminalConflicts();

    // ── Section A3 — Stage 5 hardening (F1/F2) ───────────────────────────────
    await testA18_recoveryDoesNotReclaim();
    await testA19_expirySweeper();
  } catch (err) {
    console.error('\nUnexpected error in Section A:', err.message);
    failed++;
    failures.push(`Section A error: ${err.message}`);
  }

  // ── Section B — spawn an isolated API server ───────────────────────────────
  try {
    section('Setup: spawn isolated API server');
    server = spawn(process.execPath, ['server.js'], {
      cwd: __dirname,
      env: {
        ...process.env,
        MONGO_URI: TEST_URI,
        PORT: String(TEST_PORT),
        NODE_ENV: 'test',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let serverOutput = '';
    server.stdout.on('data', (d) => (serverOutput += d.toString()));
    server.stderr.on('data', (d) => (serverOutput += d.toString()));

    const ready = await waitForHealth();
    if (!ready) {
      skip(`API server did not become healthy on port ${TEST_PORT}; Section B skipped.`);
      console.log(serverOutput.trim());
    } else {
      console.log(`  API server ready on port ${TEST_PORT}.`);
      assert(true, 'isolated API server started');

      // Login/registration fixtures over HTTP
      const customer = await makeUser('customer');
      const customerCookie = await loginUser(customer);

      const seller = await makeUser('seller');
      await makeShop(seller._id, { isVerified: true, isOpen: true });
      const sellerCookie = await loginUser(seller);

      await testB0_health();
      await testB1_validation(customerCookie);
      await testB2_auth(customerCookie, sellerCookie);
      await testB3_createSuccess(customerCookie);
      await testB4_insufficientStock(customerCookie);
      await testB5_shopStateGating(customerCookie);
      await testB6_productAndInventoryGating(customerCookie);
      await testB7_duplicateActiveReservation(customerCookie);
      await testB8_readEndpoints(customerCookie, sellerCookie);

      // ── Section C — Stage 4 settlement over HTTP ────────────────────────────
      await testC1_customerCancel(customerCookie);
      await testC2_customerCancelScope();
      await testC3_sellerCancelScope();
      await testC4_sellerPickup();
      await testC5_expiredPickupRefused();
      await testC6_authAndValidation(customerCookie, sellerCookie);
      await testC7_sellerExpirySweep();
    }
  } catch (err) {
    console.error('\nUnexpected error in Section B:', err.message);
    failed++;
    failures.push(`Section B error: ${err.message}`);
  } finally {
    if (server && !server.killed) {
      try {
        server.kill();
      } catch {
        /* ignore */
      }
    }

    // ── Cleanup: drop ONLY the isolated test database ─────────────────────────
    if (connected) {
      section('Cleanup');
      try {
        await mongoose.connection.db.dropDatabase();
        console.log(`  Dropped isolated test database: ${TEST_DB_NAME}`);
      } catch (err) {
        console.error(`  Cleanup failed: ${err.message}`);
        failed++;
        failures.push('cleanup: dropDatabase failed');
      }
      try {
        await mongoose.disconnect();
      } catch (err) {
        console.error(`  Disconnect error: ${err.message}`);
      }
    }
  }

  console.log('\n========================================');
  console.log(
    `Results: ${passed} passed, ${failed} failed, ${skipped} skipped, ${
      passed + failed + skipped
    } total`
  );
  if (failures.length) {
    console.log('Failures:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  console.log('========================================');

  process.exitCode = failed > 0 ? 1 : 0;
}

main();
