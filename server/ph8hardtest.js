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
const { MongoClient } = mongoose.mongo;

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

// Running against a remote cluster (e.g. Atlas) is opt-in: it must never happen
// by accident, because it writes test fixtures to a shared/production cluster.
function assertRemoteAllowed() {
  if (hostIsRemote(BASE_HOST) && process.env.PH8HARD_ALLOW_REMOTE !== '1') {
    throw new Error(
      `Refusing to run: MONGO_URI host "${BASE_HOST}" is not local. ` +
        'Set PH8HARD_ALLOW_REMOTE=1 to explicitly allow a remote database.'
    );
  }
}

// ─── Guarded cleanup: drop ONLY this run's isolated database (native driver) ───
// Extract the database name embedded in a connection URI so the guarded name can
// be cross-checked against the URI actually targeted. No credentials and no full
// URI are ever surfaced.
function uriDbName(uri) {
  try {
    return decodeURIComponent(new URL(uri).pathname.replace(/^\//, ''));
  } catch {
    return '';
  }
}

// Exact-equality guard: a name is safe iff it is literally this run's isolated
// database. Substring / prefix matching is intentionally avoided.
function assertSafeDbName(name) {
  if (name !== TEST_DB_NAME) {
    throw new Error(
      `Refusing to operate on database "${name}" — not this run's isolated database.`
    );
  }
}

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

// Drop ONLY the isolated database with the NATIVE driver, then verify absence.
// Returns { dropped: true, verified: true } on verified absence, or
// { dropped: true, verified: false, inconclusive: true } when the drop was issued
// but a listDatabases privilege limitation prevented verification. Throws on a
// guard failure or an actual drop failure.
async function dropIsolatedTestDb() {
  // Guard first — never touch a database outside this run.
  assertSafeDbName(TEST_DB_NAME);
  // The URI must point at exactly the guarded database, not merely a name that
  // happens to be accepted by the guard.
  const uriName = uriDbName(TEST_URI);
  if (uriName !== TEST_DB_NAME) {
    throw new Error(
      `Refusing to drop: URI target "${uriName}" does not match guarded "${TEST_DB_NAME}".`
    );
  }

  // Drop with the NATIVE driver, NOT Mongoose: a Mongoose connection triggers
  // auto-index building for registered models, which can recreate the database
  // immediately after the drop. The native client registers no models.
  const client = new MongoClient(TEST_URI, { serverSelectionTimeoutMS: 5000 });
  try {
    await client.connect();
    await client.db(TEST_DB_NAME).dropDatabase();

    // A resolved dropDatabase() is NOT proof of deletion. Re-list and confirm the
    // exact name is gone; a listing-privilege failure yields INCONCLUSIVE.
    try {
      const { databases } = await client.db().admin().listDatabases();
      if (databases.some((d) => d.name === TEST_DB_NAME)) {
        throw new Error(`database "${TEST_DB_NAME}" still exists after dropDatabase()`);
      }
      console.log(`  Cleanup: dropped and verified absent ${TEST_DB_NAME}`);
      return { dropped: true, verified: true };
    } catch (verifyErr) {
      if (isListPrivilegeError(verifyErr)) {
        console.error(
          `  Cleanup: dropped ${TEST_DB_NAME}, but absence could not be verified (account lacks listDatabases privilege).`
        );
        return { dropped: true, verified: false, inconclusive: true, reason: 'LIST_PRIVILEGE' };
      }
      throw verifyErr;
    }
  } finally {
    // Always close the cleanup connection, in every path.
    try {
      await client.close();
    } catch {
      /* already closed */
    }
  }
}

const TEST_PORT = Number(process.env.PH8_HARD_TEST_PORT || 5023);

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
    // Always attempt cleanup: the spawned test server may have written fixtures
    // (and created the isolated database) even when the PARENT never connected,
    // so a "parent not connected" early-return could orphan this run's database.
    // Release the parent connection first if it was opened; the drop then uses its
    // own native client, which registers no models and cannot recreate the database.
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
    // Drop ONLY this run's isolated database with the native driver, then
    // independently verify its absence (see dropIsolatedTestDb). dropIsolatedTestDb
    // re-asserts the exact TEST_DB_NAME and the URI target name, so no other
    // database can ever be dropped.
    const result = await dropIsolatedTestDb();
    if (!result || !result.verified) {
      // Drop issued but absence could not be verified — never report cleanup
      // success without verification.
      failed++;
      failures.push('cleanup: isolated database absence could not be verified');
    }
  } catch (error) {
    console.error(`  Cleanup warning: ${error.message}`);
    failed++;
    failures.push('cleanup: isolated database could not be dropped or verified');
  }
}

// ─── Bounded child-process shutdown ───────────────────────────────────────────
// Resolve once the child is confirmed exited, or after timeoutMs. Also resolves
// immediately when the child has already exited, closing the listener race.
// Listeners and the timer are always cleaned up so nothing lingers on the loop.
function awaitChildExit(child, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
      resolve(result);
    };
    const onExit = (code, signal) => finish({ exited: true, code, signal });
    // An 'error' event does not by itself mean the child has exited: only treat
    // it as an exit once the child is confirmed to be no longer running.
    const onError = () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        finish({ exited: true, code: child.exitCode, signal: child.signalCode });
      }
    };
    const timer = setTimeout(() => finish({ exited: false }), timeoutMs);
    child.once('exit', onExit);
    child.once('error', onError);
    // Close the listener race: if the child already exited before the listeners
    // were attached, no 'exit' event will ever fire — resolve immediately.
    if (child.exitCode !== null || child.signalCode !== null) {
      finish({ exited: true, code: child.exitCode, signal: child.signalCode });
    }
  });
}

// Send SIGTERM, await a bounded exit, escalate to SIGKILL, then await again.
// Idempotent and safe to call repeatedly; only ever signals the child it is given
// (never an unrelated process). Never throws and never leaves a rejected promise.
async function stopChild(child, timeoutMs = 5000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return { stopped: true, alreadyExited: true };
  }
  try {
    child.kill('SIGTERM');
  } catch {
    /* already gone */
  }
  let result = await awaitChildExit(child, timeoutMs);
  if (result.exited) return { stopped: true, signal: 'SIGTERM' };

  // Still alive after the grace period → escalate to SIGKILL and await again.
  try {
    child.kill('SIGKILL');
  } catch {
    /* already gone */
  }
  result = await awaitChildExit(child, timeoutMs);
  return result.exited
    ? { stopped: true, signal: 'SIGKILL' }
    : { stopped: false, timedOut: true };
}

async function main() {
  console.log('FindLocal Phase 8 Stage 4 — data & API hardening tests');
  console.log(`  Isolated database: ${TEST_DB_NAME}`);
  console.log(`  Dedicated port:    ${TEST_PORT}`);

  // Refuse a remote database before any spawn or cleanup. A rejection here is
  // handled by the main().catch below (non-zero exit).
  assertRemoteAllowed();

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
    // Awaited, bounded shutdown: SIGTERM → wait → SIGKILL → wait.
    const stopResult = await stopChild(server);
    if (!stopResult.stopped) {
      // Never ignore a shutdown failure: it must surface as a non-zero exit.
      failed++;
      failures.push('shutdown: child server did not terminate within the timeout');
    }
    await cleanup();
  }

  console.log(
    `\nResults: ${passed} passed, ${failed} failed, ${skipped} skipped, ${passed + failed + skipped} total`
  );
  if (failures.length) console.log(`Failures:\n - ${failures.join('\n - ')}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch(async (error) => {
  console.error(error);
  const stopResult = await stopChild(server);
  if (!stopResult.stopped) {
    // Never ignore a shutdown failure: it must surface as a non-zero exit.
    failed++;
    failures.push('shutdown: child server did not terminate within the timeout');
  }
  process.exitCode = 1;
});
