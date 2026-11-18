/**
 * ph10idortest.js — FindLocal Cross-Seller Inventory IDOR test suite
 *
 * Verifies that one seller cannot read, mutate, or manipulate another seller's
 * inventory resources by changing resource IDs in API requests.
 *
 * Covers:
 *   C1  Seller A GET Seller B's inventory ID            -> 404, no payload leak
 *   C2  Seller A PATCH Seller B's price                 -> 404, B unchanged
 *   C3  Seller A PATCH Seller B's isActive              -> 404, B unchanged
 *   C4  Seller A PATCH Seller B's stock (abs / adjust)  -> 404, B unchanged
 *   C5  Seller A inventory list contains only A's rows
 *   C6  Seller A POST with Seller B's real shop ID      -> 400, B untouched
 *   C7  Malformed inventory IDs on GET/PATCH/stock      -> 400
 *   C8  Seller A creates inventory for B's ACTIVE product -> 201, owned by A's shop
 *   C9  Seller without a shop accessing inventory        -> 404
 *
 * ISOLATION / SAFETY
 *   - This script NEVER touches the shared development database.
 *   - It derives an isolated database name (<db>_ph10idortest_<runid>) from
 *     MONGO_URI, connects to it, seeds fixtures there, and drops ONLY that
 *     database at the end.
 *   - A remote MONGO_URI is refused unless PH10_ALLOW_REMOTE=1 is set.
 *   - The API server is spawned as a child process with MONGO_URI and PORT
 *     overridden to the isolated database / a dedicated test port.
 *   - Cleanup uses the NATIVE MongoDB driver (no registered Mongoose models),
 *     then re-lists databases to verify the isolated database is actually gone.
 *
 * Usage (from the server folder):
 *   node ph10idortest.js
 *
 * Env:
 *   PH10_TEST_PORT   dedicated API port (default 5031)
 *   PH10_ALLOW_REMOTE=1  allow a non-local MONGO_URI (off by default)
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
  u.pathname = `/${baseName}_ph10idortest_${suffix}`;
  return { uri: u.toString(), dbName: u.pathname.slice(1), baseName };
}

const BASE_DB_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/findlocal';
const TEST_RUN = deriveTestUri(BASE_DB_URI, RUN_SUFFIX);

const TEST_PORT = Number(process.env.PH10_TEST_PORT || 5031);

const PASSWORD = 'Ph10Test@12345';
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
  if (hostIsRemote(BASE_HOST) && process.env.PH10_ALLOW_REMOTE !== '1') {
    throw new Error(
      `Refusing to run: MONGO_URI host "${BASE_HOST}" is not local. ` +
        'Set PH10_ALLOW_REMOTE=1 to explicitly allow a remote database.'
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
const GUARD_PREFIX = `${TEST_RUN.baseName}_ph10idortest_`;

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
      `Invalid test port "${TEST_PORT}": set PH10_TEST_PORT to a TCP port between 1 and 65535.`
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
              'PH10_TEST_PORT — this script never terminates the occupying process.'
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

// ─── Fixture builders ─────────────────────────────────────────────────────────
let seq = 0;
function uniq(prefix) {
  seq += 1;
  return `${prefix}${RUN_SUFFIX}${seq}`;
}

async function makeUser(role) {
  const tag = uniq(role);
  return User.create({
    name: `Ph10 ${role} ${tag}`,
    email: `${tag}@ph10.test`.toLowerCase(),
    password: PASSWORD,
    role,
  });
}

async function makeShop(ownerId, { isVerified = true, isOpen = true } = {}) {
  return Shop.create({
    owner: ownerId,
    name: uniq('Shop'),
    address: 'Ph10 Test Address',
    location: { type: 'Point', coordinates: [77.209, 28.6139] },
    isVerified,
    isOpen,
  });
}

async function makeProduct({ status = 'ACTIVE', createdBy } = {}) {
  const tag = uniq('Prod');
  return Product.create({
    name: `Ph10 Product ${tag}`,
    brand: `Ph10Brand ${tag}`,
    category: 'other',
    description: 'Ph10 test product',
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

// Read back an inventory entry straight from the isolated DB. Used to prove a
// rejected cross-seller mutation left the victim's entry unchanged.
async function readInv(id) {
  return Inventory.findById(id)
    .select('shop product pricePaise quantity reservedQuantity isActive')
    .lean();
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

    req.on('error', () =>
      resolve({ status: 0, body: null, cookie: '', raw: '' })
    );
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
  sellerA: null, shopA: null, productA: null, invA: null, cookieA: '',
  sellerB: null, shopB: null, productB: null, invB: null, cookieB: '',
  sellerC: null, cookieC: '', // seller with no shop
};

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
    assertSafeDbName(`${TEST_RUN.baseName}_ph10idortest_notarealsuffix`);
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
    JWT_SECRET: 'ph10-idor-test-only-jwt-secret-4b8a2c6e0d1f3a5c7e9b1d3f5a7c9e0b',
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

  await Promise.all([User.init(), Shop.init(), Product.init(), Inventory.init()]);

  // Seller A — verified shop, ACTIVE product, one inventory entry.
  fx.sellerA = await makeUser('seller');
  fx.shopA = await makeShop(fx.sellerA._id, { isVerified: true, isOpen: true });
  fx.productA = await makeProduct({ status: 'ACTIVE', createdBy: fx.sellerA._id });
  fx.invA = await makeInventory({
    shopId: fx.shopA._id,
    productId: fx.productA._id,
    quantity: 10,
    pricePaise: 5000,
  });

  // Seller B — verified shop, ACTIVE product, one inventory entry (the victim).
  fx.sellerB = await makeUser('seller');
  fx.shopB = await makeShop(fx.sellerB._id, { isVerified: true, isOpen: true });
  fx.productB = await makeProduct({ status: 'ACTIVE', createdBy: fx.sellerB._id });
  fx.invB = await makeInventory({
    shopId: fx.shopB._id,
    productId: fx.productB._id,
    quantity: 20,
    pricePaise: 7000,
  });

  // Seller C — no shop at all.
  fx.sellerC = await makeUser('seller');

  const invACheck = await readInv(fx.invA._id);
  const invBCheck = await readInv(fx.invB._id);
  assert(
    invACheck && invBCheck &&
      String(invACheck.shop) === String(fx.shopA._id) &&
      String(invBCheck.shop) === String(fx.shopB._id),
    'B1 two sellers each with a verified shop and a seeded inventory entry'
  );

  fx.cookieA = await loginUser(fx.sellerA);
  assert(fx.cookieA !== '', 'B2 Seller A authenticated over HTTP');
  fx.cookieB = await loginUser(fx.sellerB);
  assert(fx.cookieB !== '', 'B3 Seller B authenticated over HTTP');
  fx.cookieC = await loginUser(fx.sellerC);
  assert(fx.cookieC !== '', 'B4 no-shop Seller C authenticated over HTTP');
}

// ══════════════════════════════════════════════════════════════════════════════
// Section C — Cross-seller IDOR tests (Seller A attacking Seller B)
// ══════════════════════════════════════════════════════════════════════════════

// C1 — Seller A GET Seller B's inventory by ID.
async function testC1_getForeign() {
  section("C1. Seller A GET Seller B's inventory → 404");
  const res = await request({
    port: TEST_PORT,
    method: 'GET',
    path: `/api/v1/inventory/${fx.invB._id}`,
    cookie: fx.cookieA,
  });
  assert(res.status === 404, `C1 foreign GET → 404 (got ${res.status})`);
  assert(
    res.status === 404 && !(res.body && res.body.data && res.body.data.inventory),
    'C1 foreign GET leaks no inventory payload'
  );
}

// C2 — Seller A PATCH Seller B's price.
async function testC2_patchForeignPrice() {
  section("C2. Seller A PATCH Seller B's price → 404, unchanged");
  const before = await readInv(fx.invB._id);
  const res = await request({
    port: TEST_PORT,
    method: 'PATCH',
    path: `/api/v1/inventory/${fx.invB._id}`,
    body: { pricePaise: 123 },
    cookie: fx.cookieA,
  });
  assert(res.status === 404, `C2 foreign PATCH price → 404 (got ${res.status})`);
  const after = await readInv(fx.invB._id);
  assert(
    after && before && after.pricePaise === before.pricePaise,
    `C2 Seller B price unchanged (${before && before.pricePaise} → ${after && after.pricePaise})`
  );
}

// C3 — Seller A PATCH Seller B's isActive.
async function testC3_patchForeignIsActive() {
  section("C3. Seller A PATCH Seller B's isActive → 404, unchanged");
  const before = await readInv(fx.invB._id);
  const res = await request({
    port: TEST_PORT,
    method: 'PATCH',
    path: `/api/v1/inventory/${fx.invB._id}`,
    body: { isActive: false },
    cookie: fx.cookieA,
  });
  assert(res.status === 404, `C3 foreign PATCH isActive → 404 (got ${res.status})`);
  const after = await readInv(fx.invB._id);
  assert(
    after && before && after.isActive === before.isActive,
    `C3 Seller B isActive unchanged (${before && before.isActive} → ${after && after.isActive})`
  );
}

// C4 — Seller A PATCH Seller B's stock (both supported modes).
async function testC4_patchForeignStock() {
  section("C4. Seller A PATCH Seller B's stock → 404, unchanged");
  const before = await readInv(fx.invB._id);

  const abs = await request({
    port: TEST_PORT,
    method: 'PATCH',
    path: `/api/v1/inventory/${fx.invB._id}/stock`,
    body: { quantity: 1 },
    cookie: fx.cookieA,
  });
  assert(abs.status === 404, `C4 absolute stock → 404 (got ${abs.status})`);
  const afterAbs = await readInv(fx.invB._id);
  assert(
    afterAbs && before && afterAbs.quantity === before.quantity,
    `C4 Seller B quantity unchanged after absolute set (${afterAbs && afterAbs.quantity})`
  );

  const adj = await request({
    port: TEST_PORT,
    method: 'PATCH',
    path: `/api/v1/inventory/${fx.invB._id}/stock`,
    body: { adjust: -5 },
    cookie: fx.cookieA,
  });
  assert(adj.status === 404, `C4 adjust stock → 404 (got ${adj.status})`);
  const afterAdj = await readInv(fx.invB._id);
  assert(
    afterAdj && before &&
      afterAdj.quantity === before.quantity &&
      afterAdj.reservedQuantity === before.reservedQuantity,
    `C4 Seller B quantity/reserved unchanged after adjust (${afterAdj && afterAdj.quantity}/${afterAdj && afterAdj.reservedQuantity})`
  );
}

// C5 — Seller A inventory list is scoped to Seller A's shop.
async function testC5_listIsolation() {
  section("C5. Seller A inventory list contains only Seller A's entries");
  const res = await request({
    port: TEST_PORT,
    method: 'GET',
    path: '/api/v1/inventory',
    cookie: fx.cookieA,
  });
  assert(res.status === 200, `C5 list → 200 (got ${res.status})`);
  const rows = (res.body && res.body.data && res.body.data.inventory) || [];
  const shopAId = String(fx.shopA._id);
  assert(
    res.status === 200 && rows.length > 0 && rows.every((r) => String(r.shop) === shopAId),
    "C5 every row belongs to Seller A's shop"
  );
  assert(
    !rows.some((r) => String(r._id) === String(fx.invB._id)),
    "C5 Seller B's entry is absent from Seller A's list"
  );
}

// C6 — Seller A POST attempting to target Seller B's shop ID.
async function testC6_createWithForeignShop() {
  section("C6. Seller A POST with Seller B's real shop ID → 400, B untouched");
  const beforeCount = await Inventory.countDocuments({ shop: fx.shopB._id });
  const res = await request({
    port: TEST_PORT,
    method: 'POST',
    path: '/api/v1/inventory',
    body: {
      product: String(fx.productA._id),
      pricePaise: 100,
      shop: String(fx.shopB._id),
    },
    cookie: fx.cookieA,
  });
  assert(res.status === 400, `C6 POST with foreign shop → 400 (got ${res.status})`);
  const afterCount = await Inventory.countDocuments({ shop: fx.shopB._id });
  assert(
    afterCount === beforeCount,
    `C6 Seller B inventory count unchanged (${beforeCount} → ${afterCount})`
  );
}

// C7 — Malformed inventory IDs are rejected before any ownership logic.
async function testC7_malformedIds() {
  section('C7. Malformed inventory IDs → 400');
  const bad = 'not-an-id';

  const g = await request({
    port: TEST_PORT,
    method: 'GET',
    path: `/api/v1/inventory/${bad}`,
    cookie: fx.cookieA,
  });
  assert(g.status === 400, `C7 GET malformed id → 400 (got ${g.status})`);

  const p = await request({
    port: TEST_PORT,
    method: 'PATCH',
    path: `/api/v1/inventory/${bad}`,
    body: { isActive: false },
    cookie: fx.cookieA,
  });
  assert(p.status === 400, `C7 PATCH malformed id → 400 (got ${p.status})`);

  const s = await request({
    port: TEST_PORT,
    method: 'PATCH',
    path: `/api/v1/inventory/${bad}/stock`,
    body: { adjust: 1 },
    cookie: fx.cookieA,
  });
  assert(s.status === 400, `C7 stock PATCH malformed id → 400 (got ${s.status})`);
}

// C8 — Products are a shared catalog: Seller A may list Seller B's ACTIVE
// product, but the created inventory must belong to Seller A's own shop.
async function testC8_foreignProductSharedCatalog() {
  section("C8. Seller A creates inventory for Seller B's ACTIVE product → 201 (own shop)");
  const beforeCount = await Inventory.countDocuments({ shop: fx.shopB._id });
  const res = await request({
    port: TEST_PORT,
    method: 'POST',
    path: '/api/v1/inventory',
    body: {
      product: String(fx.productB._id),
      pricePaise: 100,
      quantity: 1,
    },
    cookie: fx.cookieA,
  });
  assert(res.status === 201, `C8 POST with foreign ACTIVE product → 201 (got ${res.status})`);

  const created = res.body && res.body.data && res.body.data.inventory;
  assert(
    created && String(created.shop) === String(fx.shopA._id),
    `C8 created inventory belongs to Seller A's shop (got ${created && created.shop})`
  );

  const afterCount = await Inventory.countDocuments({ shop: fx.shopB._id });
  assert(
    afterCount === beforeCount,
    `C8 Seller B inventory count unchanged (${beforeCount} → ${afterCount})`
  );
}

// C9 — A seller with no shop cannot reach any inventory resource.
async function testC9_noShopSeller() {
  section('C9. Seller without a shop cannot access inventory → 404');
  const list = await request({
    port: TEST_PORT,
    method: 'GET',
    path: '/api/v1/inventory',
    cookie: fx.cookieC,
  });
  assert(list.status === 404, `C9 no-shop GET list → 404 (got ${list.status})`);

  const byId = await request({
    port: TEST_PORT,
    method: 'GET',
    path: `/api/v1/inventory/${fx.invA._id}`,
    cookie: fx.cookieC,
  });
  assert(byId.status === 404, `C9 no-shop GET by id → 404 (got ${byId.status})`);
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
  assert(droppedOk, 'D2 isolated database was verified absent after drop (guarded by this run\'s name)');

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
  console.log('FindLocal — Cross-Seller Inventory IDOR test suite');
  console.log(`  Isolated test database: ${TEST_RUN.dbName}`);
  console.log(`  API test port:          ${TEST_PORT}`);
  console.log(`  Remote host allowed:    ${process.env.PH10_ALLOW_REMOTE === '1' ? 'yes' : 'no'}`);

  try {
    await testSetup();
    await testFixturesAndAuth();

    await testC1_getForeign();
    await testC2_patchForeignPrice();
    await testC3_patchForeignIsActive();
    await testC4_patchForeignStock();
    await testC5_listIsolation();
    await testC6_createWithForeignShop();
    await testC7_malformedIds();
    await testC8_foreignProductSharedCatalog();
    await testC9_noShopSeller();
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
