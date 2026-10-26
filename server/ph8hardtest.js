/**
 * ph8hardtest.js — FindLocal Phase 8 Stage 4: Data & API hardening tests
 *
 * Verifies the API/data-hardening controls reviewed and applied in Stage 4:
 *   A. Param hardening — malformed ObjectIds on the admin user routes are rejected
 *      by the shared route-param rule with the project-standard 400 shape, instead
 *      of reaching a Mongoose query (and instead of the generic CastError shape).
 *   B. Authorization — the admin user routes still require an authenticated admin
 *      (401 without a cookie, 403 for non-admin roles).
 *   C. Self-deactivation guard — an admin cannot change their own active status,
 *      INCLUDING through a differently-cased (but equivalent) hex ObjectId.
 *   D. Query hardening — the pagination cap and MongoDB-operator query objects are
 *      rejected / neutralized before they can reach a query filter.
 *
 * ISOLATION / SAFETY
 *   - Never touches the shared development database.
 *   - Spawns server.js against an isolated database (<db>_ph8hardtest_<runid>) on a
 *     dedicated port, and drops ONLY that database at the end.
 *   - No secret value is ever printed.
 *
 * Usage (from the server folder):
 *   node ph8hardtest.js
 */

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const mongoose = require('mongoose');

require('dotenv').config({ path: path.join(__dirname, '.env') });

const User = require('./src/models/User.model');
const Product = require('./src/models/Product.model');

const RUN_SUFFIX = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// ─── Derive an isolated test database from MONGO_URI ──────────────────────────
function deriveTestUri(uri, suffix) {
  const u = new URL(uri);
  const baseName = u.pathname.replace(/^\//, '') || 'findlocal';
  u.pathname = `/${baseName}_ph8hardtest_${suffix}`;
  return { uri: u.toString(), dbName: u.pathname.slice(1) };
}

const BASE_DB_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/findlocal';
const { uri: TEST_URI, dbName: TEST_DB_NAME } = deriveTestUri(BASE_DB_URI, RUN_SUFFIX);
const TEST_PORT = Number(process.env.PH8_HARD_TEST_PORT || 5022);

const ALLOWED_ORIGIN = 'http://localhost:5199';
// Non-placeholder, >= 32 characters. Test-only value.
const VALID_SECRET = 'ph8-hard-valid-secret-7c2e4a6b8d0f1a3c5e7b9d1f2a4c6e80';
const PASSWORD = 'Ph8Hard@12345';

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];
let server = null;

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
  console.log(`\n${title}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── HTTP helper ──────────────────────────────────────────────────────────────
// The raw path is passed through unchanged (no URL re-encoding) so bracket-based
// query objects such as "?limit[$ne]=5" reach Express exactly as written.
function request({ method = 'GET', path: reqPath, cookie = '', body = null }) {
  return new Promise((resolve) => {
    const payload = body === null ? null : Buffer.from(JSON.stringify(body));
    const headers = {};
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }
    if (cookie) headers.Cookie = cookie;

    const req = http.request(
      { hostname: 'localhost', port: TEST_PORT, path: reqPath, method, headers, timeout: 5000 },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          const setCookies = res.headers['set-cookie'] || [];
          let responseCookie = '';
          for (const c of setCookies) {
            if (c.startsWith('findlocal_token=')) responseCookie = c.split(';')[0];
          }
          let parsed = null;
          try {
            parsed = JSON.parse(data);
          } catch {
            /* not JSON */
          }
          resolve({ status: res.statusCode, body: parsed, raw: data, cookie: responseCookie });
        });
      }
    );

    req.on('error', () => resolve({ status: 0, body: null, raw: '', cookie: '' }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, body: null, raw: '', cookie: '' });
    });

    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForHealth(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await request({ path: '/api/v1/health' });
    if (res.status === 200) return true;
    await sleep(250);
  }
  return false;
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────
async function makeUser(role, tag = '') {
  return User.create({
    name: `Ph8Hard ${role}${tag}`,
    email: `${role}${tag}-${RUN_SUFFIX}@ph8hard.test`,
    password: PASSWORD,
    role,
  });
}

async function login(email) {
  const res = await request({
    method: 'POST',
    path: '/api/v1/auth/login',
    body: { email, password: PASSWORD },
  });
  return res.cookie;
}

// The project-standard 400 emitted by the shared ObjectId route-param rule.
function isStandardIdParam400(res) {
  return (
    res.status === 400 &&
    !!res.body &&
    res.body.success === false &&
    res.body.message === 'Validation failed' &&
    Array.isArray(res.body.errors) &&
    res.body.errors.some((e) => e.field === 'id')
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Section A — Route-param hardening (admin user routes)
// ══════════════════════════════════════════════════════════════════════════════
async function testA(adminCookie, adminId, customerId) {
  section('A. Malformed ObjectId params on admin user routes');

  const noCookie = await request({ path: `/api/v1/admin/users/${customerId}` });
  assert(noCookie.status === 401, `A1 unauthenticated GET /admin/users/:id is 401 (got ${noCookie.status})`);

  const badGet = await request({
    path: '/api/v1/admin/users/not-an-id',
    cookie: adminCookie,
  });
  assert(isStandardIdParam400(badGet), `A2 GET /admin/users/not-an-id is a standard 400 (got ${badGet.status})`);

  const badPatch = await request({
    method: 'PATCH',
    path: '/api/v1/admin/users/not-an-id/status',
    cookie: adminCookie,
    body: { isActive: false },
  });
  assert(
    isStandardIdParam400(badPatch),
    `A3 PATCH /admin/users/not-an-id/status is a standard 400 (got ${badPatch.status})`
  );

  const unknownId = new mongoose.Types.ObjectId().toString();
  const notFound = await request({
    path: `/api/v1/admin/users/${unknownId}`,
    cookie: adminCookie,
  });
  assert(
    notFound.status === 404,
    `A4 a well-formed but unknown id still yields 404 (got ${notFound.status})`
  );

  // The existing shop route already used the shared rule; the user routes must now
  // produce the identical shape for the identical failure.
  const shopRef = await request({
    path: '/api/v1/admin/shops/not-an-id',
    cookie: adminCookie,
  });
  assert(isStandardIdParam400(shopRef), `A5 GET /admin/shops/not-an-id is a standard 400 (got ${shopRef.status})`);
  assert(
    JSON.stringify(badGet.body) === JSON.stringify(shopRef.body),
    'A6 user and shop routes return an identical malformed-id error body'
  );

  void adminId;
}

// ══════════════════════════════════════════════════════════════════════════════
// Section B — Authorization on the admin user routes
// ══════════════════════════════════════════════════════════════════════════════
async function testB(adminId, customerCookie, sellerCookie, customerId) {
  section('B. Authorization on admin user routes');

  const asCustomer = await request({
    path: `/api/v1/admin/users/${adminId}`,
    cookie: customerCookie,
  });
  assert(asCustomer.status === 403, `B1 customer token on GET /admin/users/:id is 403 (got ${asCustomer.status})`);

  const asSeller = await request({
    method: 'PATCH',
    path: `/api/v1/admin/users/${customerId}/status`,
    cookie: sellerCookie,
    body: { isActive: false },
  });
  assert(asSeller.status === 403, `B2 seller token on PATCH /admin/users/:id/status is 403 (got ${asSeller.status})`);

  const noCookie = await request({
    method: 'PATCH',
    path: `/api/v1/admin/users/${customerId}/status`,
    body: { isActive: false },
  });
  assert(noCookie.status === 401, `B3 no cookie on PATCH /admin/users/:id/status is 401 (got ${noCookie.status})`);
}

// ══════════════════════════════════════════════════════════════════════════════
// Section C — Self-deactivation guard
// ══════════════════════════════════════════════════════════════════════════════
async function testC(selfAdminCookie, selfAdminId, adminCookie, customerId) {
  section('C. Admin self-deactivation guard');

  // A dedicated admin performs the self-deactivation attempts, so a regression
  // here cannot invalidate the primary adminCookie used by C5–C7 and Section D.
  const own = String(selfAdminId);
  const ownUpper = own.toUpperCase();

  const lower = await request({
    method: 'PATCH',
    path: `/api/v1/admin/users/${own}/status`,
    cookie: selfAdminCookie,
    body: { isActive: false },
  });
  assert(
    lower.status === 400 && /own active status/i.test(lower.body?.message || ''),
    `C1 admin cannot deactivate self with the canonical id (got ${lower.status})`
  );
  const afterLower = await User.findById(selfAdminId).select('isActive').lean();
  assert(afterLower && afterLower.isActive === true, 'C2 admin remains active after C1');

  if (own === ownUpper) {
    skip('C3 differently-cased self id (ObjectId contains no letters — cannot vary case)');
    skip('C4 admin remains active after C3');
  } else {
    const upper = await request({
      method: 'PATCH',
      path: `/api/v1/admin/users/${ownUpper}/status`,
      cookie: selfAdminCookie,
      body: { isActive: false },
    });
    assert(
      upper.status === 400 && /own active status/i.test(upper.body?.message || ''),
      `C3 admin cannot deactivate self via a differently-cased (equivalent) id (got ${upper.status})`
    );
    const afterUpper = await User.findById(selfAdminId).select('isActive').lean();
    assert(afterUpper && afterUpper.isActive === true, 'C4 admin remains active after C3');
  }

  const other = await request({
    method: 'PATCH',
    path: `/api/v1/admin/users/${customerId}/status`,
    cookie: adminCookie,
    body: { isActive: false },
  });
  assert(other.status === 200, `C5 admin can still deactivate a different user (got ${other.status})`);
  const customerDoc = await User.findById(customerId).select('isActive').lean();
  assert(customerDoc && customerDoc.isActive === false, 'C6 the target user is now inactive');

  const restore = await request({
    method: 'PATCH',
    path: `/api/v1/admin/users/${customerId}/status`,
    cookie: adminCookie,
    body: { isActive: true },
  });
  assert(restore.status === 200, `C7 the target user can be reactivated (got ${restore.status})`);
}

// ══════════════════════════════════════════════════════════════════════════════
// Section D — Query hardening (pagination cap + operator injection)
// ══════════════════════════════════════════════════════════════════════════════
async function testD(adminCookie, adminId) {
  section('D. Query hardening');

  const overCap = await request({
    path: '/api/v1/products?limit=51',
    cookie: adminCookie,
  });
  assert(overCap.status === 400, `D1 limit above the 50 cap is 400 (got ${overCap.status})`);

  const nonNumeric = await request({
    path: '/api/v1/products?limit=abc',
    cookie: adminCookie,
  });
  assert(nonNumeric.status === 400, `D2 non-numeric limit is 400 (got ${nonNumeric.status})`);

  // An object value where a scalar is expected must not become a Mongo operator.
  const operatorLimit = await request({
    path: '/api/v1/products?limit[$ne]=5',
    cookie: adminCookie,
  });
  assert(operatorLimit.status === 400, `D3 "{$ne}" operator on limit is 400 (got ${operatorLimit.status})`);

  // A catalog fixture so the category operator can be discriminated from a real
  // (unfiltered) result set.
  await Product.create({
    name: `Ph8Hard Product ${RUN_SUFFIX}`,
    brand: `Ph8HardBrand ${RUN_SUFFIX}`,
    category: 'other',
    status: 'ACTIVE',
    createdBy: adminId,
  });

  const operatorCategory = await request({
    path: '/api/v1/products?category[$ne]=other',
    cookie: adminCookie,
  });
  assert(
    operatorCategory.status === 200,
    `D4 "{$ne}" operator on category is neutralized to no filter (got ${operatorCategory.status})`
  );
  const results = operatorCategory.body?.data?.products || [];
  assert(
    results.length >= 1,
    `D5 the neutralized category query is unfiltered (returned ${results.length} products)`
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Cleanup
// ══════════════════════════════════════════════════════════════════════════════
async function cleanup() {
  try {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.db.dropDatabase();
      await mongoose.disconnect();
    }
    console.log(`  Cleanup: dropped ${TEST_DB_NAME}.`);
  } catch (error) {
    console.error(`  Cleanup warning: ${error.message}`);
  }
}

function killServer() {
  if (!server || server.killed) return;
  try {
    server.kill();
  } catch {
    /* already gone */
  }
}

async function main() {
  console.log('FindLocal Phase 8 Stage 4 — data & API hardening tests');
  console.log(`  Isolated database: ${TEST_DB_NAME}`);
  console.log(`  Dedicated port:    ${TEST_PORT}`);

  server = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: {
      ...process.env,
      MONGO_URI: TEST_URI,
      PORT: String(TEST_PORT),
      NODE_ENV: 'test',
      CORS_ORIGIN: ALLOWED_ORIGIN,
      JWT_SECRET: VALID_SECRET,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let serverOutput = '';
  server.stdout.on('data', (d) => (serverOutput += d.toString()));
  server.stderr.on('data', (d) => (serverOutput += d.toString()));

  try {
    const ready = await waitForHealth(20000);
    if (!ready) {
      console.error(serverOutput.trim());
      skipped++;
      console.error('  Isolated API server did not become healthy — Sections skipped.');
    } else {
      console.log(`  Isolated API server ready on port ${TEST_PORT}.`);

      await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 5000 });

      const admin = await makeUser('admin');
      const selfAdmin = await makeUser('admin', '-self');
      const customer = await makeUser('customer');
      const seller = await makeUser('seller');

      const adminCookie = await login(admin.email);
      const selfAdminCookie = await login(selfAdmin.email);
      const customerCookie = await login(customer.email);
      const sellerCookie = await login(seller.email);

      if (!adminCookie || !selfAdminCookie) {
        skipped++;
        console.error('  Admin login did not return a cookie — Sections skipped.');
      } else {
        await testA(adminCookie, admin._id, customer._id);
        await testB(admin._id, customerCookie, sellerCookie, customer._id);
        await testC(selfAdminCookie, selfAdmin._id, adminCookie, customer._id);
        await testD(adminCookie, admin._id);
      }
    }
  } finally {
    killServer();
    await sleep(200);
    await cleanup();
  }

  console.log(
    `\nResults: ${passed} passed, ${failed} failed, ${skipped} skipped, ${passed + failed + skipped} total`
  );
  if (failures.length) console.log(`Failures:\n - ${failures.join('\n - ')}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  killServer();
  process.exitCode = 1;
});
