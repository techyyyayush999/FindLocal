/**
 * ph11concurrencytest.js — FindLocal inventory + reservation concurrency suite
 *
 * Exercises the atomic-stock and stock-hold guarantees under real concurrent
 * requests/calls. The development MongoDB is standalone (no multi-document
 * transactions), so every guarantee here rests on SINGLE-DOCUMENT atomicity
 * plus membership-based truth (`heldReservations`).
 *
 * Covers:
 *   C1  Two concurrent absolute stock updates (last-writer-wins; reserved guard)
 *   C2  Two concurrent adjustments — no lost update ($inc is atomic)
 *   C3  Concurrent reductions must never cross reservedQuantity
 *   C4  Two different customers competing for limited stock (no oversell)
 *   C5  Reservation claim racing with seller stock reduction
 *   C6  Reservation cancellation racing with pickup (exactly one stock effect)
 *   C7  Reservation creation racing with inventory deactivation (F2 characterization)
 *   C8  Multiple concurrent releaseStockHold calls for one reservation
 *
 * ISOLATION / SAFETY
 *   - This script NEVER touches the shared development database.
 *   - It derives an isolated database name (<db>_ph11concurrencytest_<runid>)
 *     from MONGO_URI, connects to it, seeds fixtures there, and drops ONLY that
 *     database at the end.
 *   - A remote MONGO_URI is refused unless PH11_ALLOW_REMOTE=1 is set.
 *   - The API server is spawned as a child process with MONGO_URI and PORT
 *     overridden to the isolated database / a dedicated test port, and is
 *     terminated (and verified exited) BEFORE the database is dropped.
 *   - Cleanup uses the NATIVE MongoDB driver (no registered Mongoose models),
 *     then re-lists databases to verify the isolated database is actually gone.
 *
 * Usage (from the server folder):
 *   node ph11concurrencytest.js
 *
 * Env:
 *   PH11_TEST_PORT      dedicated API port (default 5032)
 *   PH11_ALLOW_REMOTE=1 allow a non-local MONGO_URI (off by default)
 */

const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
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
  u.pathname = `/${baseName}_ph11concurrencytest_${suffix}`;
  return { uri: u.toString(), dbName: u.pathname.slice(1), baseName };
}

const BASE_DB_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/findlocal';
const TEST_RUN = deriveTestUri(BASE_DB_URI, RUN_SUFFIX);

const TEST_PORT = Number(process.env.PH11_TEST_PORT || 5032);

const PASSWORD = 'Ph11Test@12345';
const COOKIE_NAME = 'findlocal_token';

// ─── Remote database safety gate ──────────────────────────────────────────────
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
  if (hostIsRemote(BASE_HOST) && process.env.PH11_ALLOW_REMOTE !== '1') {
    throw new Error(
      `Refusing to run: MONGO_URI host "${BASE_HOST}" is not local. ` +
        'Set PH11_ALLOW_REMOTE=1 to explicitly allow a remote database.'
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
const GUARD_PREFIX = `${TEST_RUN.baseName}_ph11concurrencytest_`;

function assertSafeDbName(name) {
  if (name !== TEST_RUN.dbName) {
    throw new Error(
      `Refusing to operate on database "${name}" — not this run's isolated database.`
    );
  }
}

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Port validation & preflight ──────────────────────────────────────────────
function validatePorts() {
  if (!Number.isInteger(TEST_PORT) || TEST_PORT < 1 || TEST_PORT > 65535) {
    throw new Error(
      `Invalid test port "${TEST_PORT}": set PH11_TEST_PORT to a TCP port between 1 and 65535.`
    );
  }
}

// Probes whether a port is free by briefly binding it, then releasing it. It
// NEVER touches or terminates whatever process may already hold the port.
function assertPortFree(port, label) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', (err) => {
      const code = err && err.code;
      if (code === 'EADDRINUSE') {
        reject(
          new Error(
            `Port ${port} (${label}) is already in use. Free it or set an alternate port via ` +
              'PH11_TEST_PORT — this script never terminates the occupying process.'
          )
        );
      } else {
        reject(
          new Error(
            `Port preflight failed for ${port} (${label}): ${err && err.message ? err.message : err}`
          )
        );
      }
    });
    probe.once('listening', () => probe.close(() => resolve()));
    probe.listen(port, '127.0.0.1');
  });
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

// ─── Fixture builders ─────────────────────────────────────────────────────────
let seq = 0;
function uniq(prefix) {
  seq += 1;
  return `${prefix}${RUN_SUFFIX}${seq}`;
}

async function makeUser(role) {
  const tag = uniq(role);
  return User.create({
    name: `Ph11 ${role} ${tag}`,
    email: `${tag}@ph11.test`.toLowerCase(),
    password: PASSWORD,
    role,
  });
}

async function makeShop(ownerId, { isVerified = true, isOpen = true } = {}) {
  return Shop.create({
    owner: ownerId,
    name: uniq('Shop'),
    address: 'Ph11 Test Address',
    location: { type: 'Point', coordinates: [77.209, 28.6139] },
    isVerified,
    isOpen,
  });
}

async function makeProduct({ status = 'ACTIVE', createdBy } = {}) {
  const tag = uniq('Prod');
  return Product.create({
    name: `Ph11 Product ${tag}`,
    brand: `Ph11Brand ${tag}`,
    category: 'other',
    description: 'Ph11 test product',
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

// Build a reservation and drive it to ACTIVE + HELD through the real recovery
// primitive (claim → promote), exactly as createReservation does.
async function makeActiveReservation({
  customerId,
  shopId,
  productId,
  inventoryId,
  quantity = 1,
} = {}) {
  const reservation = await Reservation.create({
    customer: customerId,
    shop: shopId,
    product: productId,
    inventory: inventoryId,
    quantity,
    pricePaise: 5000,
    status: RESERVATION_STATUSES.PENDING,
    holdState: HOLD_STATES.UNCLAIMED,
    expiresAt: new Date(Date.now() + 120 * 60 * 1000),
    activeKey: svc.buildActiveKey(customerId, inventoryId),
  });
  await svc.recoverReservation(reservation._id);
  return reservation;
}

// Read back an inventory entry (including the internal hold markers) straight
// from the isolated DB, to assert the true post-race stock state.
async function readInv(id) {
  return Inventory.findById(id)
    .select('shop product pricePaise quantity reservedQuantity isActive +heldReservations')
    .lean();
}

// Read back a reservation with its internal settlement markers.
async function readRes(id) {
  return Reservation.findById(id)
    .select(
      'customer shop product inventory quantity status expiresAt +holdState +holdAppliedAt +settledAt +activeKey'
    )
    .lean();
}

// The core stock invariant that must hold after every relevant case.
function invariantHolds(inv) {
  return Boolean(
    inv && inv.quantity >= inv.reservedQuantity && inv.reservedQuantity >= 0
  );
}

function markerCount(inv) {
  return (inv && inv.heldReservations ? inv.heldReservations.length : 0);
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────
function request({ port, method = 'GET', path: reqPath, body = null, cookie = '', timeoutMs = 5000 }) {
  return new Promise((resolve) => {
    const payload = body === null ? null : Buffer.from(JSON.stringify(body));
    const headers = {};
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }
    if (cookie) headers['Cookie'] = cookie;

    const req = http.request(
      { hostname: 'localhost', port, path: reqPath, method, headers, timeout: timeoutMs },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = JSON.parse(data);
          } catch {
            /* non-JSON body */
          }
          const setCookies = res.headers['set-cookie'] || [];
          let authCookie = '';
          for (const c of setCookies) {
            if (c.startsWith(`${COOKIE_NAME}=`)) {
              authCookie = c.split(';')[0];
              break;
            }
          }
          resolve({ status: res.statusCode, body: parsed, cookie: authCookie, raw: data });
        });
      }
    );

    // A transport error or timeout resolves with status 0 — an expected-status
    // assertion on it will therefore FAIL rather than silently pass.
    req.on('error', () => resolve({ status: 0, body: null, cookie: '', raw: '' }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, body: null, cookie: '', raw: '' });
    });

    if (payload) req.write(payload);
    req.end();
  });
}

async function loginUser(user) {
  const res = await request({
    port: TEST_PORT,
    method: 'POST',
    path: '/api/v1/auth/login',
    body: { email: user.email, password: PASSWORD },
  });
  return res.status === 200 ? res.cookie : '';
}

// Thin route helpers (all requests hit the spawned child server).
function stockUpdate(inventoryId, body, cookie) {
  return request({
    port: TEST_PORT,
    method: 'PATCH',
    path: `/api/v1/inventory/${inventoryId}/stock`,
    body,
    cookie,
  });
}

function patchInventory(inventoryId, body, cookie) {
  return request({
    port: TEST_PORT,
    method: 'PATCH',
    path: `/api/v1/inventory/${inventoryId}`,
    body,
    cookie,
  });
}

function createReservation(cookie, inventoryId, quantity) {
  return request({
    port: TEST_PORT,
    method: 'POST',
    path: '/api/v1/reservations',
    body: { inventory: String(inventoryId), quantity },
    cookie,
  });
}

// ─── Child-process helpers ────────────────────────────────────────────────────
let testChild = null;

function spawnServer(env) {
  return spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: { ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function startCapture(child) {
  const state = { out: '', err: '' };
  if (child.stdout) child.stdout.on('data', (chunk) => (state.out += chunk.toString()));
  if (child.stderr) child.stderr.on('data', (chunk) => (state.err += chunk.toString()));
  return state;
}

// Kill only a child process this suite created.
function killChild(child) {
  if (!child || child.killed) return;
  try {
    child.kill();
  } catch {
    /* already gone */
  }
}

// Wait for a child to actually terminate, with a bounded timeout and a
// force-kill fallback that targets ONLY the child handle passed in.
function waitForChildExit(child, timeoutMs = 5000) {
  if (!child) return Promise.resolve();
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolve();
    };
    const onExit = () => finish();
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      finish();
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

async function stopChild(child) {
  if (!child) return;
  killChild(child);
  await waitForChildExit(child, 5000);
}

// Resolve only once the freshly spawned child has answered the health probe with
// the expected payload. Rejects early if the child errors or exits, so a failed
// startup is detected immediately instead of after the full timeout.
function waitForChildStartup(child, port, label, capture, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
      fn(arg);
    };
    const tail = () => (capture && capture.err ? `: ${capture.err.trim().slice(0, 300)}` : '');
    const onExit = (code) =>
      finish(
        reject,
        new Error(`${label} child server exited before becoming healthy (code ${code})${tail()}`)
      );
    const onError = (err) =>
      finish(
        reject,
        new Error(
          `${label} child server could not be spawned: ${err && err.message ? err.message : err}`
        )
      );

    const timer = setTimeout(
      () =>
        finish(
          reject,
          new Error(
            `${label} child server did not become healthy on port ${port} within ${timeoutMs}ms`
          )
        ),
      timeoutMs
    );

    child.once('exit', onExit);
    child.once('error', onError);

    (async () => {
      while (!settled) {
        // Require the exact health payload so an unrelated listener that might
        // have grabbed the port cannot be mistaken for our child.
        const res = await request({ port, path: '/api/v1/health' });
        if (settled) return;
        if (res.status === 200 && res.body && res.body.status === 'ok') {
          finish(resolve);
          return;
        }
        await sleep(300);
      }
    })();
  });
}

// ─── Cleanup: drop ONLY the isolated database (native driver + verify) ─────────
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
    // exact name is gone; otherwise treat the cleanup as failed.
    const { databases } = await client.db().admin().listDatabases();
    if (databases.some((d) => d.name === run.dbName)) {
      throw new Error(`database "${run.dbName}" still exists after dropDatabase()`);
    }
    console.log(`  Cleanup: dropped and verified absent ${run.dbName}`);
  } finally {
    // Always close the cleanup connection.
    try {
      await client.close();
    } catch {
      /* already closed */
    }
  }
}

// ─── Shared fixture state ─────────────────────────────────────────────────────
const fx = {
  seller: null,
  shop: null,
  sellerCookie: '',
  customer1: null,
  customer2: null,
  cookie1: '',
  cookie2: '',
};

// Create a fresh product + inventory under the shared seller's shop, so each
// case works on an uncontaminated stock row (unique {shop, product} index).
async function makeCaseInventory({ quantity = 10, isActive = true } = {}) {
  const product = await makeProduct({ status: 'ACTIVE', createdBy: fx.seller._id });
  const inventory = await makeInventory({
    shopId: fx.shop._id,
    productId: product._id,
    quantity,
    isActive,
  });
  return { product, inventory };
}

// Create an inventory row and place `heldQuantity` units on hold via a real
// ACTIVE reservation (keeps reservedQuantity and the marker set consistent).
async function makeHeldInventory({ quantity = 10, heldQuantity, customer = fx.customer1 }) {
  const { product, inventory } = await makeCaseInventory({ quantity });
  const reservation = await makeActiveReservation({
    customerId: customer._id,
    shopId: fx.shop._id,
    productId: product._id,
    inventoryId: inventory._id,
    quantity: heldQuantity,
  });
  return { product, inventory, reservation };
}

// ══════════════════════════════════════════════════════════════════════════════
// Section A — Setup: safety gates, isolated connection, child server
// ══════════════════════════════════════════════════════════════════════════════
async function testSetup() {
  section('A. Setup');

  // Refuse a remote database unless explicitly allowed. Runs before any
  // connection or spawn so a shared/production cluster is never touched.
  assertRemoteAllowed();

  assert(
    TEST_RUN.dbName.startsWith(GUARD_PREFIX) && TEST_RUN.dbName.includes(RUN_SUFFIX),
    `A1 isolated test database name is unique and guarded (${TEST_RUN.dbName})`
  );

  // The guard must reject anything outside this run.
  let guardRejectedBase = false;
  try {
    assertSafeDbName('findlocal');
  } catch {
    guardRejectedBase = true;
  }
  let guardRejectedForeignRun = false;
  try {
    assertSafeDbName(`${TEST_RUN.baseName}_ph11concurrencytest_notarealsuffix`);
  } catch {
    guardRejectedForeignRun = true;
  }
  assert(
    guardRejectedBase && guardRejectedForeignRun,
    'A2 database-name guard rejects anything outside this run'
  );

  // Port configuration must be valid and the port must be free before spawning.
  validatePorts();
  await assertPortFree(TEST_PORT, 'test-mode');
  assert(TEST_PORT > 0, `A3 dedicated test port is available (${TEST_PORT})`);

  // Connect the parent (for fixture seeding, read-back and cleanup). The
  // connection name is checked FATALLY: a mismatch aborts before any write/drop.
  await mongoose.connect(TEST_RUN.uri, { serverSelectionTimeoutMS: 5000 });
  if (mongoose.connection.name !== TEST_RUN.dbName) {
    throw new Error(
      `Refusing to run: connected to "${mongoose.connection.name}", expected "${TEST_RUN.dbName}".`
    );
  }
  assert(true, `A4 parent is connected to the isolated database only (${mongoose.connection.name})`);

  // Guard the database name, then spawn the test-mode API server.
  assertSafeDbName(TEST_RUN.dbName);
  testChild = spawnServer({
    ...process.env,
    MONGO_URI: TEST_RUN.uri,
    PORT: String(TEST_PORT),
    NODE_ENV: 'test',
    // Deterministic test-only values so the child boots without a .env:
    // server.js aborts startup when JWT_SECRET (>=32 chars, non-placeholder)
    // or CORS_ORIGIN (valid http(s) origin, never "*") are missing.
    JWT_SECRET: 'ph11-concurrency-test-only-jwt-secret-1a3c5e7b9d0f2a4c6e8b0d2f4a6c8e10',
    CORS_ORIGIN: 'http://localhost:5199',
  });
  const capture = startCapture(testChild);

  // A failed startup throws (hard failure) — later sections never run.
  await waitForChildStartup(testChild, TEST_PORT, 'test-mode', capture);
  assert(true, `A5 test-mode child server is healthy on port ${TEST_PORT}`);
}

// ══════════════════════════════════════════════════════════════════════════════
// Section B — Fixtures and authentication
// ══════════════════════════════════════════════════════════════════════════════
async function testFixturesAndAuth() {
  section('B. Fixtures and authentication');

  await Promise.all([
    User.init(),
    Shop.init(),
    Product.init(),
    Inventory.init(),
    Reservation.init(),
  ]);

  // One verified, open seller shop owns every inventory row in this suite.
  fx.seller = await makeUser('seller');
  fx.shop = await makeShop(fx.seller._id, { isVerified: true, isOpen: true });
  assert(Boolean(fx.shop && fx.shop.isVerified), 'B1 seller has a verified, open shop');

  fx.sellerCookie = await loginUser(fx.seller);
  assert(fx.sellerCookie !== '', 'B2 seller authenticated over HTTP');

  fx.customer1 = await makeUser('customer');
  fx.customer2 = await makeUser('customer');
  fx.cookie1 = await loginUser(fx.customer1);
  fx.cookie2 = await loginUser(fx.customer2);
  assert(fx.cookie1 !== '', 'B3 customer 1 authenticated over HTTP');
  assert(fx.cookie2 !== '', 'B4 customer 2 authenticated over HTTP');
}

// ══════════════════════════════════════════════════════════════════════════════
// C1 — Two concurrent absolute stock updates
// ══════════════════════════════════════════════════════════════════════════════
async function testC1_absoluteConcurrent() {
  section('C1. Two concurrent absolute stock updates');

  // A: unconstrained — both accepted; the absolute value is last-writer-wins.
  const a = await makeCaseInventory({ quantity: 10 });
  const [r4, r7] = await Promise.all([
    stockUpdate(a.inventory._id, { quantity: 4 }, fx.sellerCookie),
    stockUpdate(a.inventory._id, { quantity: 7 }, fx.sellerCookie),
  ]);
  const invA = await readInv(a.inventory._id);
  assert(
    r4.status === 200 && r7.status === 200,
    `C1A both absolute updates accepted (got ${r4.status}, ${r7.status})`
  );
  assert(
    invA.quantity === 4 || invA.quantity === 7,
    `C1A final quantity is one of the submitted values (got ${invA.quantity})`
  );
  assert(
    invA.reservedQuantity === 0,
    `C1A reservedQuantity unchanged at 0 (got ${invA.reservedQuantity})`
  );
  assert(markerCount(invA) === 0, 'C1A no hold markers created');
  assert(invariantHolds(invA), 'C1A invariant quantity >= reservedQuantity >= 0 holds');

  // B: stock on hold — an absolute value BELOW reservedQuantity must be refused,
  // one at/above it must be accepted. Deterministic regardless of ordering.
  const b = await makeHeldInventory({ quantity: 10, heldQuantity: 5 }); // reserved 5
  const [r2, r9] = await Promise.all([
    stockUpdate(b.inventory._id, { quantity: 2 }, fx.sellerCookie),
    stockUpdate(b.inventory._id, { quantity: 9 }, fx.sellerCookie),
  ]);
  const invB = await readInv(b.inventory._id);
  assert(r2.status === 409, `C1B absolute below reservedQuantity → 409 (got ${r2.status})`);
  assert(r9.status === 200, `C1B absolute at/above reservedQuantity → 200 (got ${r9.status})`);
  assert(
    invB.quantity === 9 && invB.reservedQuantity === 5,
    `C1B refused update left stock untouched (q=${invB.quantity}, r=${invB.reservedQuantity})`
  );
  assert(invariantHolds(invB), 'C1B invariant holds with reserved stock');
}

// ══════════════════════════════════════════════════════════════════════════════
// C2 — Two concurrent adjustments; verify no lost update
// ══════════════════════════════════════════════════════════════════════════════
async function testC2_adjustNoLostUpdate() {
  section('C2. Two concurrent stock adjustments — no lost update');
  const { inventory } = await makeCaseInventory({ quantity: 10 });

  const [ra, rb] = await Promise.all([
    stockUpdate(inventory._id, { adjust: 3 }, fx.sellerCookie),
    stockUpdate(inventory._id, { adjust: 5 }, fx.sellerCookie),
  ]);
  const inv = await readInv(inventory._id);

  assert(
    ra.status === 200 && rb.status === 200,
    `C2 both adjustments accepted (got ${ra.status}, ${rb.status})`
  );
  assert(
    inv.quantity === 18,
    `C2 both adjustments applied atomically, no lost update (expected 18, got ${inv.quantity})`
  );
  assert(
    inv.reservedQuantity === 0,
    `C2 reservedQuantity unchanged at 0 (got ${inv.reservedQuantity})`
  );
  assert(invariantHolds(inv), 'C2 invariant holds');
}

// ══════════════════════════════════════════════════════════════════════════════
// C3 — Concurrent reductions must not violate reservedQuantity
// ══════════════════════════════════════════════════════════════════════════════
async function testC3_reductionReservedGuard() {
  section('C3. Concurrent reductions must not cross reservedQuantity');
  const { inventory } = await makeHeldInventory({ quantity: 10, heldQuantity: 3 }); // avail 7

  // Each -5 alone is legal (10-5=5 >= 3); together they would reach 0 < 3, so
  // exactly one must be accepted and the other refused (409).
  const [r1, r2] = await Promise.all([
    stockUpdate(inventory._id, { adjust: -5 }, fx.sellerCookie),
    stockUpdate(inventory._id, { adjust: -5 }, fx.sellerCookie),
  ]);
  const inv = await readInv(inventory._id);

  const okCount = [r1, r2].filter((r) => r.status === 200).length;
  const conflictCount = [r1, r2].filter((r) => r.status === 409).length;

  assert(okCount === 1, `C3 exactly one reduction accepted (got ${okCount}/2)`);
  assert(conflictCount === 1, `C3 exactly one reduction refused with 409 (got ${conflictCount}/2)`);
  assert(
    inv.quantity === 5 && inv.reservedQuantity === 3,
    `C3 final state respects reserved stock (q=${inv.quantity}, r=${inv.reservedQuantity})`
  );
  assert(invariantHolds(inv), 'C3 invariant quantity >= reservedQuantity >= 0 holds');
}

// ══════════════════════════════════════════════════════════════════════════════
// C4 — Two different customers competing for limited stock
// ══════════════════════════════════════════════════════════════════════════════
async function testC4_twoCustomersCompete() {
  section('C4. Two customers compete for limited stock');
  const { inventory } = await makeCaseInventory({ quantity: 3 });

  const [r1, r2] = await Promise.all([
    createReservation(fx.cookie1, inventory._id, 2),
    createReservation(fx.cookie2, inventory._id, 2),
  ]);
  const inv = await readInv(inventory._id);

  const created = [r1, r2].filter((r) => r.status === 201).length;
  const refused = [r1, r2].filter((r) => r.status === 409).length;

  assert(created === 1, `C4 exactly one reservation created (got ${created}/2)`);
  assert(refused === 1, `C4 exactly one reservation refused with 409 (got ${refused}/2)`);
  assert(
    inv.reservedQuantity === 2,
    `C4 reservedQuantity equals a single hold (got ${inv.reservedQuantity})`
  );
  assert(
    markerCount(inv) === 1,
    `C4 exactly one hold marker (got ${markerCount(inv)})`
  );
  assert(invariantHolds(inv), 'C4 invariant holds (no oversell)');

  const loser = r1.status === 409 ? r1 : r2;
  assert(
    Boolean(loser.body) && /insufficient stock/i.test(String(loser.body.message)),
    `C4 losing request reports insufficient stock (got "${loser.body && loser.body.message}")`
  );

  const winner = r1.status === 201 ? r1 : r2;
  const winnerId =
    winner.body && winner.body.data && winner.body.data.reservation
      ? winner.body.data.reservation._id
      : null;
  const winnerRes = winnerId ? await readRes(winnerId) : null;
  assert(
    winnerRes && winnerRes.status === RESERVATION_STATUSES.ACTIVE,
    `C4 winning reservation is ACTIVE (got ${winnerRes && winnerRes.status})`
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// C5 — Reservation claim racing with seller stock reduction
// ══════════════════════════════════════════════════════════════════════════════
async function testC5_claimRacingSellerReduction() {
  section('C5. Reservation claim racing with seller stock reduction');

  // A: numbers chosen so BOTH operations succeed in either ordering, which makes
  // the final state deterministic.
  const a = await makeCaseInventory({ quantity: 10 });
  const [sa, ra] = await Promise.all([
    stockUpdate(a.inventory._id, { adjust: -3 }, fx.sellerCookie),
    createReservation(fx.cookie1, a.inventory._id, 2),
  ]);
  const invA = await readInv(a.inventory._id);
  assert(
    sa.status === 200 && ra.status === 201,
    `C5A seller reduction and reservation both succeed (got ${sa.status}, ${ra.status})`
  );
  assert(
    invA.quantity === 7 && invA.reservedQuantity === 2,
    `C5A deterministic final state (q=${invA.quantity}, r=${invA.reservedQuantity})`
  );
  assert(invariantHolds(invA), 'C5A invariant holds');

  // B: tightly constrained — the ordering decides which side loses, so only a
  // LEGAL OUTCOME SET can be asserted.
  const b = await makeCaseInventory({ quantity: 2 });
  const [sb, rb] = await Promise.all([
    stockUpdate(b.inventory._id, { adjust: -2 }, fx.sellerCookie),
    createReservation(fx.cookie1, b.inventory._id, 1),
  ]);
  const invB = await readInv(b.inventory._id);

  const sellerWon = sb.status === 200 && rb.status === 409;
  const claimWon = sb.status === 409 && rb.status === 201;
  const legalPair =
    (sellerWon && invB.quantity === 0 && invB.reservedQuantity === 0) ||
    (claimWon && invB.quantity === 2 && invB.reservedQuantity === 1);

  assert(
    legalPair,
    `C5B outcome is a legal ordering (seller=${sb.status}, res=${rb.status}, q=${invB.quantity}, r=${invB.reservedQuantity})`
  );
  assert(invariantHolds(invB), 'C5B invariant holds');
}

// ══════════════════════════════════════════════════════════════════════════════
// C6 — Reservation cancellation racing with pickup
// ══════════════════════════════════════════════════════════════════════════════
async function testC6_cancelRacingPickup() {
  section('C6. Reservation cancellation racing with pickup');
  const { inventory, reservation } = await makeHeldInventory({
    quantity: 5,
    heldQuantity: 2,
    customer: fx.customer1,
  });

  const pre = await readRes(reservation._id);
  assert(
    pre.status === RESERVATION_STATUSES.ACTIVE && pre.holdState === HOLD_STATES.HELD,
    `C6 precondition: reservation ACTIVE + HELD (got ${pre.status}/${pre.holdState})`
  );

  // Actual route behaviour verified against the implementation:
  //   * the winning settlement returns 200;
  //   * the losing one maps a non-ok settle outcome (`CONFLICT`) to 409.
  const [cancel, pickup] = await Promise.all([
    request({
      port: TEST_PORT,
      method: 'PATCH',
      path: `/api/v1/reservations/mine/${reservation._id}/cancel`,
      cookie: fx.cookie1,
    }),
    request({
      port: TEST_PORT,
      method: 'PATCH',
      path: `/api/v1/reservations/shop/${reservation._id}/pickup`,
      cookie: fx.sellerCookie,
    }),
  ]);

  const inv = await readInv(inventory._id);
  const res = await readRes(reservation._id);

  const okCount = [cancel, pickup].filter((r) => r.status === 200).length;
  const conflictCount = [cancel, pickup].filter((r) => r.status === 409).length;

  assert(okCount === 1, `C6 exactly one settlement succeeded (got ${okCount}/2)`);
  assert(conflictCount === 1, `C6 exactly one settlement refused with 409 (got ${conflictCount}/2)`);
  assert(inv.reservedQuantity === 0, `C6 reservedQuantity released to 0 (got ${inv.reservedQuantity})`);
  assert(markerCount(inv) === 0, 'C6 no hold markers remain');
  assert(invariantHolds(inv), 'C6 invariant holds');

  if (cancel.status === 200) {
    assert(
      res.status === RESERVATION_STATUSES.CANCELLED && inv.quantity === 5,
      `C6 cancel winner: CANCELLED and stock untouched (status=${res.status}, q=${inv.quantity})`
    );
  } else {
    assert(
      res.status === RESERVATION_STATUSES.FULFILLED && inv.quantity === 3,
      `C6 pickup winner: FULFILLED and stock consumed (status=${res.status}, q=${inv.quantity})`
    );
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// C7 — Reservation creation racing with inventory deactivation (F2)
// ══════════════════════════════════════════════════════════════════════════════
// F2 is a TOCTOU window inside createReservation: the `isActive` availability
// read happens at request time, but the stock claim is a separate write. If a
// deactivation commits between those two steps, the reservation can still be
// created. The window is NOT controllable without a production-only hook, which
// this suite deliberately avoids. Therefore C7:
//   (a) proves the read-time guard deterministically (a COMMITTED deactivation
//       refuses creation), and
//   (b) runs the race repeatedly and asserts only SAFETY INVARIANTS that must
//       hold whatever the interleaving, and CHARACTERISES (never asserts) how
//       often creation won. It does NOT report PASS merely because the window
//       was never hit — the invariants are the pass criterion.
async function testC7_createRacingDeactivation() {
  section('C7. Reservation creation racing with inventory deactivation (F2)');

  // (a) Deterministic control — committed deactivation must refuse creation.
  const ctl = await makeCaseInventory({ quantity: 5 });
  const deactivateControl = await patchInventory(
    ctl.inventory._id,
    { isActive: false },
    fx.sellerCookie
  );
  assert(
    deactivateControl.status === 200,
    `C7 control: deactivation accepted (got ${deactivateControl.status})`
  );
  const ctlRes = await createReservation(fx.cookie1, ctl.inventory._id, 1);
  assert(
    ctlRes.status === 409,
    `C7 control: creation after a committed deactivation → 409 (got ${ctlRes.status})`
  );

  // (b) Concurrent race, repeated over a bounded number of fresh inventories.
  const ITERATIONS = 10;
  let created = 0;
  let refused = 0;
  let allDeactivationsOk = true;
  let allLegalStatuses = true;
  let allInvariantsHold = true;
  let holdsConsistent = true;

  for (let i = 0; i < ITERATIONS; i++) {
    const { inventory } = await makeCaseInventory({ quantity: 5 });
    const [deact, create] = await Promise.all([
      patchInventory(inventory._id, { isActive: false }, fx.sellerCookie),
      createReservation(fx.cookie1, inventory._id, 1),
    ]);
    const inv = await readInv(inventory._id);

    if (deact.status !== 200) allDeactivationsOk = false;
    if (create.status !== 201 && create.status !== 409) allLegalStatuses = false;
    if (!invariantHolds(inv)) allInvariantsHold = false;

    if (create.status === 201) {
      created++;
      if (inv.reservedQuantity !== 1 || markerCount(inv) !== 1) holdsConsistent = false;
    } else if (create.status === 409) {
      refused++;
      if (inv.reservedQuantity !== 0 || markerCount(inv) !== 0) holdsConsistent = false;
    }
  }

  assert(allDeactivationsOk, 'C7 every concurrent deactivation returned 200');
  assert(allLegalStatuses, 'C7 every concurrent creation returned only 201 or 409 (no 0/5xx)');
  assert(
    allInvariantsHold,
    'C7 no inventory ever violated quantity >= reservedQuantity >= 0 during the race'
  );
  assert(
    holdsConsistent,
    'C7 counter and hold markers stayed consistent with each creation outcome'
  );

  // Characterisation only — NOT an assertion. A 201 here is not necessarily a
  // bug (creation may legally precede the deactivation commit); a 409 does not
  // prove the window was closed. The result neither proves nor disproves F2.
  console.log(
    `  C7 characterization: ${created}/${ITERATIONS} concurrent creations succeeded while ` +
      `deactivation was in flight, ${refused}/${ITERATIONS} refused. ` +
      'The isActive TOCTOU window is not directly observable without a production hook.'
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// C8 — Multiple concurrent releaseStockHold calls for the same reservation
// ══════════════════════════════════════════════════════════════════════════════
async function testC8_duplicateRelease() {
  section('C8. Multiple concurrent releases for one reservation');
  const { inventory, reservation } = await makeHeldInventory({
    quantity: 5,
    heldQuantity: 2,
    customer: fx.customer1,
  });

  const pre = await readInv(inventory._id);
  assert(
    pre.reservedQuantity === 2 && markerCount(pre) === 1,
    `C8 precondition: reservation holds 2 units (r=${pre.reservedQuantity}, markers=${markerCount(pre)})`
  );

  // Direct service calls: the membership guard must make the decrement
  // exactly-once, and only the primitive exposes the per-call reason.
  const results = await Promise.all(
    Array.from({ length: 5 }, () => svc.releaseStockHold(reservation._id))
  );
  const inv = await readInv(inventory._id);

  const releasedCount = results.filter((r) => r && r.released).length;
  assert(releasedCount === 1, `C8 exactly one release took effect (got ${releasedCount}/5)`);
  assert(
    results
      .filter((r) => r && !r.released)
      .every((r) => r.reason === 'NOT_HELD' || r.reason === 'ALREADY_RELEASED'),
    'C8 every losing release reported a distinct no-op reason'
  );
  assert(
    inv.reservedQuantity === 0,
    `C8 reservedQuantity released exactly once to 0 (got ${inv.reservedQuantity})`
  );
  assert(markerCount(inv) === 0, 'C8 hold marker removed exactly once');
  assert(
    inv.quantity === 5,
    `C8 physical quantity untouched by release (got ${inv.quantity})`
  );
  assert(invariantHolds(inv), 'C8 invariant holds');
}

// ══════════════════════════════════════════════════════════════════════════════
// Section D — Teardown
// ══════════════════════════════════════════════════════════════════════════════
async function teardown() {
  section('D. Teardown');

  // Terminate the child FIRST and await real exit before touching the database
  // it was using. Works even after a partial setup failure.
  if (testChild) {
    await stopChild(testChild);
  }
  const stillRunning = testChild && testChild.exitCode === null && testChild.signalCode === null;
  assert(!stillRunning, 'D1 test child server was terminated and has actually exited');
  testChild = null;

  // Drop ONLY the isolated database and verify it is gone. Any residual database
  // (or any error) makes D2 fail.
  let droppedOk = false;
  try {
    await dropIsolatedDb(TEST_RUN);
    droppedOk = true;
  } catch (err) {
    console.error(`  Cleanup warning (${TEST_RUN.dbName}): ${err.message}`);
  }
  assert(droppedOk, "D2 isolated database was verified absent after drop (guarded by this run's name)");

  if (mongoose.connection.readyState !== 0) {
    try {
      await mongoose.disconnect();
    } catch {
      /* already disconnected */
    }
  }
  assert(mongoose.connection.readyState === 0, 'D3 MongoDB connection is closed');
}

// ══════════════════════════════════════════════════════════════════════════════
// Runner
// ══════════════════════════════════════════════════════════════════════════════
async function main() {
  console.log('FindLocal — Inventory concurrency test suite (PH11)');
  console.log(`  Isolated test database: ${TEST_RUN.dbName}`);
  console.log(`  API test port:          ${TEST_PORT}`);
  console.log(`  Remote host allowed:    ${process.env.PH11_ALLOW_REMOTE === '1' ? 'yes' : 'no'}`);

  try {
    await testSetup();
    await testFixturesAndAuth();

    await testC1_absoluteConcurrent();
    await testC2_adjustNoLostUpdate();
    await testC3_reductionReservedGuard();
    await testC4_twoCustomersCompete();
    await testC5_claimRacingSellerReduction();
    await testC6_cancelRacingPickup();
    await testC7_createRacingDeactivation();
    await testC8_duplicateRelease();
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
