/**
 * ph9authtest.js — FindLocal: Authentication Lifecycle test suite
 *
 * Verifies the cookie/JWT authentication contract end to end against two
 * isolated, self-contained API servers:
 *   • A NODE_ENV=test server — registration, login, logout, GET /auth/me,
 *     cookie flags, JWT integrity (expired / tampered / wrong-secret) and
 *     deactivated-account handling.
 *   • A NODE_ENV=production server — the production-only `Secure` cookie flag.
 *
 * ISOLATION / SAFETY
 *   - Never touches the shared development database. Each server runs against a
 *     per-run database (<db>_ph9authtest_<runid>[/_prod]) on its own port; both
 *     are dropped at the end, and only after a name-guard confirms they belong
 *     to this run.
 *   - The child servers are started with a deterministic, test-only JWT secret
 *     and CORS origin, so no real .env secret is required.
 *   - A remote MONGO_URI is refused unless PH9_ALLOW_REMOTE=1 is set; only the
 *     host (never credentials and never the full URI) is ever printed.
 *   - No JWT secret, token value, or cookie value is ever printed.
 *   - Only the child processes created here are killed; only databases whose
 *     names carry this run's guard are dropped.
 *
 * Usage (from the server folder):
 *   node ph9authtest.js
 */

const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
// Native MongoDB driver, obtained via Mongoose so no extra dependency is added
// and the exact driver version already in use is guaranteed. Used ONLY for
// cleanup: it registers no models and performs no auto-indexing.
const { MongoClient } = mongoose.mongo;

require('dotenv').config({ path: path.join(__dirname, '.env') });

// ─── Per-run identity ──────────────────────────────────────────────────────────
const RUN_SUFFIX = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// ─── Derive an isolated test database from MONGO_URI ──────────────────────────
function deriveTestUri(uri, suffix) {
  const u = new URL(uri);
  const baseName = u.pathname.replace(/^\//, '') || 'findlocal';
  u.pathname = `/${baseName}_ph9authtest_${suffix}`;
  return { uri: u.toString(), dbName: u.pathname.slice(1), baseName };
}

const BASE_DB_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/findlocal';
const TEST_RUN = deriveTestUri(BASE_DB_URI, RUN_SUFFIX); //        NODE_ENV=test database
const PROD_RUN = deriveTestUri(BASE_DB_URI, `${RUN_SUFFIX}_prod`); // NODE_ENV=production database

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
  if (hostIsRemote(BASE_HOST) && process.env.PH9_ALLOW_REMOTE !== '1') {
    throw new Error(
      `Refusing to run: MONGO_URI host "${BASE_HOST}" is not local. ` +
        'Set PH9_ALLOW_REMOTE=1 to explicitly allow a remote database.'
    );
  }
}

const TEST_PORT = Number(process.env.PH9_AUTH_TEST_PORT || 5021);
const PROD_PORT = Number(process.env.PH9_AUTH_PROD_PORT || 5022);

const CORS_TEST_ORIGIN = 'http://localhost:5221';

// Deterministic, non-placeholder, 48-character test-only secret. Never printed.
const VALID_SECRET = 'ph9-auth-valid-secret-9c1f7e3a5b2d8c4e6f0a1b3d5c7e9f20';

const COOKIE_NAME = 'findlocal_token';
const CUSTOMER_PASSWORD = 'Ph9Customer!2345';
const DEACTIVATED_PASSWORD = 'Ph9Deact!2345';

// ─── Database-name guard ──────────────────────────────────────────────────────
// Every database operation in this suite must reference a name that belongs to
// THIS run: it must carry the ph9authtest marker AND this run's unique suffix.
const GUARD_PREFIX = `${TEST_RUN.baseName}_ph9authtest_`;

function assertSafeDbName(name) {
  // Exact equality only: a name is safe iff it is literally one of this run's
  // two isolated databases. Substring / prefix matching is intentionally avoided.
  const ok = name === TEST_RUN.dbName || name === PROD_RUN.dbName;
  if (!ok) {
    throw new Error(
      `Refusing to operate on database "${name}" — not one of this run's isolated databases.`
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
  console.log(`\n${title}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Port validation & preflight ──────────────────────────────────────────────
function validatePorts() {
  for (const [label, port] of [['test', TEST_PORT], ['production', PROD_PORT]]) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(
        `Invalid ${label} port "${port}": set PH9_AUTH_TEST_PORT / PH9_AUTH_PROD_PORT ` +
          'to a TCP port between 1 and 65535.'
      );
    }
  }
  if (TEST_PORT === PROD_PORT) {
    throw new Error(`Test and production ports must differ, but both are ${TEST_PORT}.`);
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
              'PH9_AUTH_TEST_PORT / PH9_AUTH_PROD_PORT — this script never terminates the ' +
              'occupying process.'
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

// ─── Child-process helpers ────────────────────────────────────────────────────
let testChild = null;
let prodChild = null;

function spawnServer(env) {
  return spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: { ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// Capture child output so a startup failure is diagnosable without leaking
// secrets (the child only ever prints safe diagnostics).
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

// Polite terminate, then bounded wait with a force-kill fallback.
async function stopChild(child) {
  if (!child) return;
  killChild(child);
  await waitForChildExit(child, 5000);
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────
function request({ port, method = 'GET', path: reqPath, body = null, cookie = '', timeoutMs = 4000 }) {
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
          resolve({
            status: res.statusCode,
            headers: res.headers,
            setCookies,
            body: parsed,
            raw: data,
            cookie: authCookie,
          });
        });
      }
    );

    req.on('error', () => resolve({ status: 0, headers: {}, setCookies: [], body: null, raw: '', cookie: '' }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, headers: {}, setCookies: [], body: null, raw: '', cookie: '' });
    });

    if (payload) req.write(payload);
    req.end();
  });
}

// Resolve only once the freshly spawned child has answered the health probe
// with the expected payload. Rejects early if the child errors or exits, so a
// failed startup is detected immediately instead of after the full timeout.
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

// The full Set-Cookie string for the auth cookie (attributes included).
function authSetCookie(res) {
  return (res.setCookies || []).find((c) => c.startsWith(`${COOKIE_NAME}=`)) || '';
}

// Only the attribute portion of a Set-Cookie string (everything after the value),
// so a substring test can never accidentally match inside the opaque token value.
function cookieAttributes(setCookie) {
  const parts = setCookie.split(';');
  return parts.slice(1).join(';');
}

// Extract the raw JWT from a Cookie header line ("findlocal_token=<jwt>"). Used
// only in memory for integrity tests — never printed.
function cookieValue(cookieHeader) {
  if (!cookieHeader) return '';
  const prefix = `${COOKIE_NAME}=`;
  return cookieHeader.startsWith(prefix) ? cookieHeader.slice(prefix.length) : '';
}

// Flip a character in a JWT signature so the signature no longer verifies.
function tamperSignature(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return `${token}x`;
  const sig = parts[2];
  const flipped = (sig.endsWith('A') ? 'B' : 'A') + sig.slice(0, -1);
  parts[2] = flipped;
  return parts.join('.');
}

// ─── Shared state between sections ────────────────────────────────────────────
const state = {
  customerEmail: `ph9-customer-${RUN_SUFFIX}@test.com`,
  customerId: '',
  loginCookie: '',
};

// ══════════════════════════════════════════════════════════════════════════════
// Section A — Setup
// ══════════════════════════════════════════════════════════════════════════════
async function testSetup() {
  section('A. Setup');

  // Refuse a remote database unless explicitly allowed. Runs before any
  // connection or spawn so a shared/production cluster is never touched.
  assertRemoteAllowed();

  assert(TEST_RUN.dbName.startsWith(GUARD_PREFIX) && TEST_RUN.dbName.includes(RUN_SUFFIX),
    `A1 isolated test database name is unique and guarded (${TEST_RUN.dbName})`);
  assert(PROD_RUN.dbName.startsWith(GUARD_PREFIX) && PROD_RUN.dbName.includes(RUN_SUFFIX),
    `A2 production database name is separately isolated (${PROD_RUN.dbName})`);

  // Port configuration must be valid and distinct before anything is spawned.
  validatePorts();
  assert(TEST_PORT > 0 && PROD_PORT > 0 && TEST_PORT !== PROD_PORT,
    `A3 dedicated, distinct test ports (${TEST_PORT} / ${PROD_PORT})`);

  // Both ports must be free before spawning. A busy port aborts here; the
  // occupying process is never touched.
  await assertPortFree(TEST_PORT, 'test-mode');
  await assertPortFree(PROD_PORT, 'production-mode');
  assert(true, 'A4 both configured ports are available');

  // The guard must reject anything outside this run.
  let guardRejectedBase = false;
  try {
    assertSafeDbName('findlocal');
  } catch {
    guardRejectedBase = true;
  }
  let guardRejectedForeignRun = false;
  try {
    assertSafeDbName(`${TEST_RUN.baseName}_ph9authtest_notarealsuffix`);
  } catch {
    guardRejectedForeignRun = true;
  }
  assert(guardRejectedBase && guardRejectedForeignRun,
    'A5 database-name guard rejects anything outside this run');

  // Connect the parent (for the deactivation write and cleanup). The connection
  // name is checked FATALLY: a mismatch aborts before any write or drop.
  await mongoose.connect(TEST_RUN.uri, { serverSelectionTimeoutMS: 5000 });
  if (mongoose.connection.name !== TEST_RUN.dbName) {
    throw new Error(
      `Refusing to run: connected to "${mongoose.connection.name}", expected "${TEST_RUN.dbName}".`
    );
  }
  assert(true, `A6 parent is connected to the isolated database only (${mongoose.connection.name})`);

  // Guard the database name, then spawn the test-mode API server.
  assertSafeDbName(TEST_RUN.dbName);
  testChild = spawnServer({
    ...process.env,
    MONGO_URI: TEST_RUN.uri,
    PORT: String(TEST_PORT),
    NODE_ENV: 'test',
    CORS_ORIGIN: CORS_TEST_ORIGIN,
    JWT_SECRET: VALID_SECRET,
    JWT_EXPIRES_IN: '7d',
  });
  const capture = startCapture(testChild);

  // A failed startup throws (hard failure) — later sections never run.
  await waitForChildStartup(testChild, TEST_PORT, 'test-mode', capture);
  assert(true, `A7 test-mode child server is healthy on port ${TEST_PORT}`);
}

// ══════════════════════════════════════════════════════════════════════════════
// Section B — Registration and login
// ══════════════════════════════════════════════════════════════════════════════
async function testRegistrationAndLogin() {
  section('B. Registration and login');

  // B1 — customer registration.
  const reg = await request({
    port: TEST_PORT,
    method: 'POST',
    path: '/api/v1/auth/register',
    body: { name: 'Ph9 Customer', email: state.customerEmail, password: CUSTOMER_PASSWORD },
  });
  assert(reg.status === 201, `B1 customer registration returns 201 (got ${reg.status})`);
  assert(authSetCookie(reg) !== '', 'B1 registration sets the auth cookie');
  assert(reg.status === 201 &&
    !!(reg.body && reg.body.data && reg.body.data.user && reg.body.data.user._id),
    'B1 registration returns the created user');
  state.customerId = (reg.body && reg.body.data && reg.body.data.user && reg.body.data.user._id) || '';

  // B2 — password is never returned (only meaningful on a real 201 response).
  assert(reg.status === 201 && !/password/i.test(reg.raw),
    'B2 registration response (201) never contains a password field');

  // B3 — correct login.
  const login = await request({
    port: TEST_PORT,
    method: 'POST',
    path: '/api/v1/auth/login',
    body: { email: state.customerEmail, password: CUSTOMER_PASSWORD },
  });
  assert(login.status === 200, `B3 correct login returns 200 (got ${login.status})`);
  assert(login.status === 200 && authSetCookie(login) !== '', 'B3 login sets the auth cookie');
  assert(login.status === 200 && !/password/i.test(login.raw),
    'B3 login response (200) never contains a password field');
  state.loginCookie = login.cookie;

  // B4 — wrong password.
  const wrongPass = await request({
    port: TEST_PORT,
    method: 'POST',
    path: '/api/v1/auth/login',
    body: { email: state.customerEmail, password: 'WrongPassword!999' },
  });
  assert(wrongPass.status === 401, `B4 wrong password returns 401 (got ${wrongPass.status})`);
  const wrongPassMsg = (wrongPass.body && wrongPass.body.message) || '';

  // B5 — unknown email.
  const unknownEmail = await request({
    port: TEST_PORT,
    method: 'POST',
    path: '/api/v1/auth/login',
    body: { email: `ph9-nobody-${RUN_SUFFIX}@test.com`, password: 'Whatever!12345' },
  });
  assert(unknownEmail.status === 401, `B5 unknown email returns 401 (got ${unknownEmail.status})`);
  const unknownEmailMsg = (unknownEmail.body && unknownEmail.body.message) || '';

  // B6 — identical, generic message (anti-enumeration).
  assert(
    wrongPassMsg === unknownEmailMsg && /invalid email or password/i.test(wrongPassMsg),
    'B6 wrong password and unknown email return the same generic 401 message'
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Section C — Cookie flags (test mode)
// ══════════════════════════════════════════════════════════════════════════════
async function testCookieFlags() {
  section('C. Cookie flags (test mode)');

  const login = await request({
    port: TEST_PORT,
    method: 'POST',
    path: '/api/v1/auth/login',
    body: { email: state.customerEmail, password: CUSTOMER_PASSWORD },
  });
  const setCookie = authSetCookie(login);
  const attrs = cookieAttributes(setCookie);

  // Every flag assertion is only meaningful on a real 200 login that actually
  // set the cookie. An empty attribute string (failed/empty response) must never
  // satisfy an assertion — in particular C5's "Secure is absent".
  const loggedIn = login.status === 200 && setCookie.startsWith(`${COOKIE_NAME}=`);
  assert(loggedIn, `C1 login returned 200 and set the ${COOKIE_NAME} cookie (got ${login.status})`);
  assert(loggedIn && /\bHttpOnly\b/.test(attrs), 'C2 HttpOnly flag is set');
  assert(loggedIn && /SameSite=Strict/i.test(attrs), 'C3 SameSite=Strict is set');
  assert(loggedIn && /Max-Age=604800\b/.test(attrs), 'C4 Max-Age=604800 (7 days) is set');
  assert(loggedIn && !/\bSecure\b/.test(attrs), 'C5 Secure flag is absent in test (non-production) mode');
}

// ══════════════════════════════════════════════════════════════════════════════
// Section D — Authentication persistence (GET /auth/me)
// ══════════════════════════════════════════════════════════════════════════════
async function testPersistence() {
  section('D. Authentication persistence');

  // D1 — valid cookie.
  const me = await request({
    port: TEST_PORT,
    path: '/api/v1/auth/me',
    cookie: state.loginCookie,
  });
  assert(me.status === 200, `D1 GET /auth/me with a valid cookie returns 200 (got ${me.status})`);
  assert(
    me.status === 200 &&
      !!(me.body && me.body.data && me.body.data.user && me.body.data.user.email === state.customerEmail),
    'D1 /auth/me returns the authenticated user'
  );
  assert(me.status === 200 && !/password/i.test(me.raw),
    'D1 /auth/me response (200) never contains a password field');

  // D2 — missing cookie.
  const noCookie = await request({ port: TEST_PORT, path: '/api/v1/auth/me' });
  assert(noCookie.status === 401, `D2 GET /auth/me without a cookie returns 401 (got ${noCookie.status})`);

  // D3 — malformed cookie.
  const malformed = await request({
    port: TEST_PORT,
    path: '/api/v1/auth/me',
    cookie: `${COOKIE_NAME}=not.a.valid-jwt`,
  });
  assert(malformed.status === 401, `D3 GET /auth/me with a malformed cookie returns 401 (got ${malformed.status})`);
}

// ══════════════════════════════════════════════════════════════════════════════
// Section E — Logout
// ══════════════════════════════════════════════════════════════════════════════
async function testLogout() {
  section('E. Logout');

  // E1 — authenticated logout.
  const logout = await request({
    port: TEST_PORT,
    method: 'POST',
    path: '/api/v1/auth/logout',
    cookie: state.loginCookie,
  });
  assert(logout.status === 200, `E1 authenticated logout returns 200 (got ${logout.status})`);

  // E2 — cookie is cleared (empty value, Max-Age=0). Only meaningful on a real
  // 200 logout response; an empty Set-Cookie must not satisfy the assertion.
  const clearCookie = authSetCookie(logout);
  const clearAttrs = cookieAttributes(clearCookie);
  assert(
    logout.status === 200 &&
      (clearCookie === `${COOKIE_NAME}=` || clearCookie.startsWith(`${COOKIE_NAME}=;`)),
    'E2 logout clears the cookie value'
  );
  assert(logout.status === 200 && /Max-Age=0\b/.test(clearAttrs), 'E2 logout sets Max-Age=0');

  // E3 — logout without authentication.
  const anonLogout = await request({ port: TEST_PORT, method: 'POST', path: '/api/v1/auth/logout' });
  assert(anonLogout.status === 401, `E3 logout without a cookie returns 401 (got ${anonLogout.status})`);

  // E4 — reuse the old token after logout. Cookie clearing is a client-side
  // mechanism only: the JWT is stateless and is NOT revoked server-side, so the
  // old token keeps working until it expires. This test documents that reality.
  const reuse = await request({
    port: TEST_PORT,
    path: '/api/v1/auth/me',
    cookie: state.loginCookie,
  });
  assert(
    reuse.status === 200,
    'E4 the old JWT still authenticates after logout — no server-side revocation (stateless JWT)'
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Section F — JWT integrity
// ══════════════════════════════════════════════════════════════════════════════
async function testJwtIntegrity() {
  section('F. JWT integrity');

  // A fresh valid token to tamper with (never printed).
  const login = await request({
    port: TEST_PORT,
    method: 'POST',
    path: '/api/v1/auth/login',
    body: { email: state.customerEmail, password: CUSTOMER_PASSWORD },
  });
  const validToken = cookieValue(login.cookie);

  // F1 — expired token.
  const expiredToken = jwt.sign(
    { id: state.customerId, role: 'customer' },
    VALID_SECRET,
    { expiresIn: '-10s' }
  );
  const expired = await request({
    port: TEST_PORT,
    path: '/api/v1/auth/me',
    cookie: `${COOKIE_NAME}=${expiredToken}`,
  });
  assert(expired.status === 401, `F1 an expired token returns 401 (got ${expired.status})`);

  // F2 — tampered token (valid structure, broken signature).
  const tamperedToken = tamperSignature(validToken);
  const tampered = await request({
    port: TEST_PORT,
    path: '/api/v1/auth/me',
    cookie: `${COOKIE_NAME}=${tamperedToken}`,
  });
  assert(tampered.status === 401, `F2 a tampered token returns 401 (got ${tampered.status})`);

  // F3 — token signed with a different (wrong) secret.
  const wrongSecretToken = jwt.sign(
    { id: state.customerId, role: 'admin' },
    'ph9-wrong-secret-1a2b3c4d5e6f7g8h9i0j1k2l3m4n5o6p',
    { expiresIn: '7d' }
  );
  const wrongSecret = await request({
    port: TEST_PORT,
    path: '/api/v1/auth/me',
    cookie: `${COOKIE_NAME}=${wrongSecretToken}`,
  });
  assert(wrongSecret.status === 401, `F3 a wrong-secret token returns 401 (got ${wrongSecret.status})`);
}

// ══════════════════════════════════════════════════════════════════════════════
// Section G — Deactivated account
// ══════════════════════════════════════════════════════════════════════════════
async function testDeactivatedAccount() {
  section('G. Deactivated account');

  const email = `ph9-deactivated-${RUN_SUFFIX}@test.com`;
  const reg = await request({
    port: TEST_PORT,
    method: 'POST',
    path: '/api/v1/auth/register',
    body: { name: 'Ph9 Deactivated', email, password: DEACTIVATED_PASSWORD },
  });
  assert(reg.status === 201, `G0 the deactivation fixture user is created (got ${reg.status})`);
  const userId = (reg.body && reg.body.data && reg.body.data.user && reg.body.data.user._id) || '';
  const userCookie = reg.cookie;

  // Deactivate directly in the isolated database (parent owns this connection).
  const User = require('./src/models/User.model');
  const updated = await User.updateOne({ _id: userId }, { $set: { isActive: false } });
  assert(updated.matchedCount === 1, 'G1 the fixture user is deactivated in the isolated database');

  // G2 — deactivated user cannot access /auth/me.
  const me = await request({ port: TEST_PORT, path: '/api/v1/auth/me', cookie: userCookie });
  assert(me.status === 403, `G2 a deactivated user cannot access /auth/me (got ${me.status})`);

  // G3 — deactivated user cannot log in.
  const login = await request({
    port: TEST_PORT,
    method: 'POST',
    path: '/api/v1/auth/login',
    body: { email, password: DEACTIVATED_PASSWORD },
  });
  assert(login.status === 403, `G3 a deactivated user cannot log in (got ${login.status})`);
}

// ══════════════════════════════════════════════════════════════════════════════
// Section H — Production cookie check
// ══════════════════════════════════════════════════════════════════════════════
async function testProductionCookies() {
  section('H. Production cookie check (NODE_ENV=production)');

  // Guard the production database name immediately before spawning its server.
  assertSafeDbName(PROD_RUN.dbName);
  prodChild = spawnServer({
    ...process.env,
    MONGO_URI: PROD_RUN.uri,
    PORT: String(PROD_PORT),
    NODE_ENV: 'production',
    CORS_ORIGIN: CORS_TEST_ORIGIN,
    JWT_SECRET: VALID_SECRET,
    JWT_EXPIRES_IN: '7d',
  });
  const capture = startCapture(prodChild);

  // A failed production startup is a HARD failure (throws) — never a silently
  // completed section. waitForChildStartup rejects on child exit / spawn error /
  // timeout, and only resolves on the exact health payload.
  await waitForChildStartup(prodChild, PROD_PORT, 'production-mode', capture);
  assert(true, `H1 production-mode child server is healthy on port ${PROD_PORT}`);

  const reg = await request({
    port: PROD_PORT,
    method: 'POST',
    path: '/api/v1/auth/register',
    body: {
      name: 'Ph9 Prod',
      email: `ph9-prod-${RUN_SUFFIX}@test.com`,
      password: 'Ph9Prod!234567',
    },
  });
  assert(reg.status === 201, `H2 production registration succeeds (got ${reg.status})`);

  const setCookie = authSetCookie(reg);
  const attrs = cookieAttributes(setCookie);
  // Gate every attribute assertion on the real 201 that set the cookie.
  const issued = reg.status === 201 && setCookie.startsWith(`${COOKIE_NAME}=`);
  assert(issued, `H3 production cookie name is ${COOKIE_NAME}`);
  assert(issued && /\bSecure\b/.test(attrs), 'H4 production cookie sets the Secure flag');
  assert(issued && /\bHttpOnly\b/.test(attrs), 'H5 production cookie keeps HttpOnly');
  assert(issued && /SameSite=Strict/i.test(attrs), 'H6 production cookie keeps SameSite=Strict');
}

// ══════════════════════════════════════════════════════════════════════════════
// Section I — Teardown
// ══════════════════════════════════════════════════════════════════════════════
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
  // auto-index building for registered models (e.g. User → the `users`
  // collection), which can recreate the database immediately after the drop.
  // The native client registers no models, so nothing is recreated.
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

async function cleanup() {
  section('I. Teardown');

  // Collect the child handles this suite actually created (a subset after a
  // partial startup failure) and keep the handles so real exit can be verified.
  const children = [
    ['test-mode', testChild],
    ['production-mode', prodChild],
  ].filter(([, child]) => !!child);

  // Bound the polite terminate and fall back to a force-kill of ONLY the child
  // handles this suite created, then await ACTUAL termination before dropping
  // the databases they were using. Works even after partial startup failures.
  await Promise.all(children.map(([, child]) => stopChild(child)));

  // Verify real termination rather than asserting unconditionally.
  const stillRunning = children.filter(
    ([, child]) => child.exitCode === null && child.signalCode === null
  );
  assert(stillRunning.length === 0,
    'I1 only this suite\'s child servers were terminated and have actually exited');

  testChild = null;
  prodChild = null;

  // Each drop both removes AND verifies absence; any residual database (or any
  // error) makes I2 fail. A partially-started run still cleans whatever exists.
  let droppedOk = true;
  for (const run of [TEST_RUN, PROD_RUN]) {
    try {
      await dropIsolatedDb(run);
    } catch (err) {
      droppedOk = false;
      console.error(`  Cleanup warning (${run.dbName}): ${err.message}`);
    }
  }
  assert(droppedOk, 'I2 both isolated databases were verified absent after drop (guarded by this run\'s name)');

  if (mongoose.connection.readyState !== 0) {
    try {
      await mongoose.disconnect();
    } catch {
      /* already disconnected */
    }
  }
  assert(mongoose.connection.readyState === 0, 'I3 MongoDB connection is closed');
}

// ══════════════════════════════════════════════════════════════════════════════
// Runner
// ══════════════════════════════════════════════════════════════════════════════
async function main() {
  console.log('FindLocal — Authentication Lifecycle test suite');
  console.log(`  Test-mode database:       ${TEST_RUN.dbName}`);
  console.log(`  Production database:      ${PROD_RUN.dbName}`);
  console.log(`  Ports:                    ${TEST_PORT} (test) / ${PROD_PORT} (production)`);

  try {
    await testSetup();
    await testRegistrationAndLogin();
    await testCookieFlags();
    await testPersistence();
    await testLogout();
    await testJwtIntegrity();
    await testDeactivatedAccount();
    await testProductionCookies();
  } catch (error) {
    // Never leak secrets: log only the error message.
    console.error(`\nUnexpected error during tests: ${error && error.message ? error.message : error}`);
    failed++;
    failures.push('unexpected error');
  } finally {
    // Cleanup must run on success AND failure.
    try {
      await cleanup();
    } catch (error) {
      console.error(`  Teardown error: ${error && error.message ? error.message : error}`);
    }
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  if (failures.length) console.log(`Failures:\n - ${failures.join('\n - ')}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`Fatal: ${error && error.message ? error.message : error}`);
  process.exitCode = 1;
});
