/**
 * ph8sectest.js — FindLocal Phase 8 Stage 2: HTTP security hardening tests
 *
 * Verifies the HTTP-layer controls added in Stage 2 by spawning an isolated API
 * server with deliberately tiny rate limits:
 *   A. Security headers — Helmet headers present, X-Powered-By removed.
 *   B. CORS — the validated allowlist is enforced (no wildcard fallback).
 *   C. Rate limiting — HTTP 429 on the auth and reservation-creation endpoints.
 *   D. Request body limit — oversized payloads are rejected with 413.
 *
 * ISOLATION / SAFETY
 *   - Never touches the shared development database.
 *   - The server is spawned with an isolated database name (<db>_ph8sectest_<runid>)
 *     on a dedicated port, and is killed at the end; nothing is written, so the
 *     isolated database is dropped only as a safety no-op.
 *   - No secret value is ever printed.
 *
 * Usage (from the server folder):
 *   node ph8sectest.js
 */

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const mongoose = require('mongoose');
const { MongoClient } = mongoose.mongo;

require('dotenv').config({ path: path.join(__dirname, '.env') });

const RUN_SUFFIX = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// ─── Derive an isolated test database from MONGO_URI ──────────────────────────
function deriveTestUri(uri, suffix) {
  const u = new URL(uri);
  const baseName = u.pathname.replace(/^\//, '') || 'findlocal';
  u.pathname = `/${baseName}_ph8sectest_${suffix}`;
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
  if (hostIsRemote(BASE_HOST) && process.env.PH8SEC_ALLOW_REMOTE !== '1') {
    throw new Error(
      `Refusing to run: MONGO_URI host "${BASE_HOST}" is not local. ` +
        'Set PH8SEC_ALLOW_REMOTE=1 to explicitly allow a remote database.'
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

const TEST_PORT = Number(process.env.PH8_SEC_TEST_PORT || 5019);

const ALLOWED_ORIGIN = 'http://localhost:5199';
const DISALLOWED_ORIGIN = 'http://attacker.example.com';

// Non-placeholder, >= 32 characters. Test-only value.
const VALID_SECRET = 'ph8-sec-valid-secret-4b1d9f7a2c6e8d0f3a5b7c9d1e2f4a60';

// Deliberately small limits so a 429 is easy to trigger deterministically.
const AUTH_MAX = 3;
const RESERVATION_MAX = 2;

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

function section(title) {
  console.log(`\n${title}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── HTTP helper ──────────────────────────────────────────────────────────────
function request({ method = 'GET', path: reqPath, headers = {}, body = null }) {
  return new Promise((resolve) => {
    const payload = body === null ? null : Buffer.from(JSON.stringify(body));
    const reqHeaders = { ...headers };
    if (payload) {
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = payload.length;
    }

    const req = http.request(
      {
        hostname: 'localhost',
        port: TEST_PORT,
        path: reqPath,
        method,
        headers: reqHeaders,
        timeout: 3000,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = JSON.parse(data);
          } catch {
            /* not JSON */
          }
          resolve({ status: res.statusCode, headers: res.headers, raw: data, body: parsed });
        });
      }
    );

    req.on('error', () => resolve({ status: 0, headers: {}, raw: '', body: null }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, headers: {}, raw: '', body: null });
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

// ══════════════════════════════════════════════════════════════════════════════
// Section A — Security headers
// ══════════════════════════════════════════════════════════════════════════════
async function testSecurityHeaders() {
  section('A. Security headers (Helmet)');

  const res = await request({ path: '/api/v1/health' });

  assert(res.status === 200, 'A1 /api/v1/health is reachable');
  assert(res.headers['x-powered-by'] === undefined, 'A2 X-Powered-By header is not sent');
  assert(res.headers['x-content-type-options'] === 'nosniff', 'A3 X-Content-Type-Options is nosniff');
  assert(!!res.headers['x-frame-options'], 'A4 X-Frame-Options is set');
  assert(!!res.headers['strict-transport-security'], 'A5 Strict-Transport-Security is set');
  assert(!!res.headers['referrer-policy'], 'A6 Referrer-Policy is set');
  assert(!!res.headers['content-security-policy'], 'A7 Content-Security-Policy is set');
  assert(!!res.headers['x-dns-prefetch-control'], 'A8 X-DNS-Prefetch-Control is set');
  assert(
    !!res.headers['x-permitted-cross-domain-policies'],
    'A9 X-Permitted-Cross-Domain-Policies is set'
  );
  assert(!!res.headers['cross-origin-opener-policy'], 'A10 Cross-Origin-Opener-Policy is set');
}

// ══════════════════════════════════════════════════════════════════════════════
// Section B — CORS allowlist
// ══════════════════════════════════════════════════════════════════════════════
async function testCors() {
  section('B. CORS allowlist');

  const allowed = await request({
    path: '/api/v1/health',
    headers: { Origin: ALLOWED_ORIGIN },
  });
  assert(
    allowed.headers['access-control-allow-origin'] === ALLOWED_ORIGIN,
    'B1 allowed origin is echoed back'
  );
  assert(
    allowed.headers['access-control-allow-credentials'] === 'true',
    'B2 credentials are allowed for the allowed origin'
  );

  const preflight = await request({
    method: 'OPTIONS',
    path: '/api/v1/health',
    headers: { Origin: ALLOWED_ORIGIN, 'Access-Control-Request-Method': 'GET' },
  });
  assert(
    preflight.status === 204 || preflight.status === 200,
    'B3 preflight for the allowed origin succeeds'
  );
  assert(
    preflight.headers['access-control-allow-origin'] === ALLOWED_ORIGIN,
    'B4 preflight echoes the allowed origin'
  );

  const denied = await request({
    path: '/api/v1/health',
    headers: { Origin: DISALLOWED_ORIGIN },
  });
  assert(
    denied.headers['access-control-allow-origin'] !== DISALLOWED_ORIGIN,
    'B5 disallowed origin is not echoed'
  );
  assert(
    denied.headers['access-control-allow-origin'] !== '*',
    'B6 disallowed origin never receives a wildcard'
  );

  const deniedPreflight = await request({
    method: 'OPTIONS',
    path: '/api/v1/health',
    headers: { Origin: DISALLOWED_ORIGIN, 'Access-Control-Request-Method': 'GET' },
  });
  assert(
    deniedPreflight.headers['access-control-allow-origin'] !== DISALLOWED_ORIGIN,
    'B7 disallowed preflight origin is not echoed'
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Section C — Request body size limit
// ══════════════════════════════════════════════════════════════════════════════
async function testBodyLimit() {
  section('C. Request body size limit');

  // ~120kb, comfortably over the 100kb limit. Uses a route that is only covered
  // by the broad (very generous) API limiter so rate limiting cannot interfere.
  const oversized = { padding: 'x'.repeat(120 * 1024) };
  const res = await request({ method: 'POST', path: '/api/v1/products', body: oversized });
  assert(res.status === 413, `C1 oversized body is rejected with 413 (got ${res.status})`);

  const small = await request({ method: 'POST', path: '/api/v1/products', body: { padding: 'ok' } });
  assert(small.status !== 413, `C2 small body is not rejected for size (got ${small.status})`);
}

// ══════════════════════════════════════════════════════════════════════════════
// Section D — Rate limiting (HTTP 429)
// ══════════════════════════════════════════════════════════════════════════════
async function testRateLimiting() {
  section('D. Rate limiting (429)');

  // ── Auth limiter (login) ────────────────────────────────────────────────────
  let sawAuth429 = false;
  let authLast = 0;
  let auth429Body = null;
  let firstAuthHeaders = null;
  for (let i = 0; i < AUTH_MAX + 2; i++) {
    const res = await request({
      method: 'POST',
      path: '/api/v1/auth/login',
      body: { email: 'nobody@example.com', password: 'wrong-password' },
    });
    if (i === 0) firstAuthHeaders = res.headers;
    authLast = res.status;
    if (res.status === 429) {
      sawAuth429 = true;
      auth429Body = res.body;
    }
  }
  assert(!!firstAuthHeaders['ratelimit-limit'], 'D1 limiter advertises RateLimit headers');
  assert(sawAuth429, `D2 login returns 429 after ${AUTH_MAX} attempts`);
  assert(authLast === 429, 'D3 subsequent login attempts stay 429');
  assert(
    auth429Body && auth429Body.success === false,
    'D4 the 429 response body signals failure'
  );

  // ── Reservation-creation limiter ────────────────────────────────────────────
  let sawReservation429 = false;
  let reservationLast = 0;
  for (let i = 0; i < RESERVATION_MAX + 2; i++) {
    const res = await request({
      method: 'POST',
      path: '/api/v1/reservations',
      body: { inventoryId: '000000000000000000000000', quantity: 1 },
    });
    reservationLast = res.status;
    if (res.status === 429) sawReservation429 = true;
  }
  assert(
    sawReservation429,
    `D5 reservation creation returns 429 after ${RESERVATION_MAX} attempts`
  );
  assert(reservationLast === 429, 'D6 subsequent reservation creations stay 429');
}

// ══════════════════════════════════════════════════════════════════════════════
// Cleanup
// ══════════════════════════════════════════════════════════════════════════════
async function cleanup() {
  try {
    // Release the parent Mongoose connection first; the drop uses its own native
    // client, which registers no models and cannot recreate the database.
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    // Drop ONLY this run's isolated database with the native driver, then
    // independently verify its absence (see dropIsolatedTestDb).
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
  console.log('FindLocal Phase 8 Stage 2 — HTTP security hardening tests');
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
      RATE_LIMIT_WINDOW_MS: '60000',
      RATE_LIMIT_API_MAX: '1000000', // keep the broad limiter out of the way
      RATE_LIMIT_AUTH_MAX: String(AUTH_MAX),
      RATE_LIMIT_RESERVATION_MAX: String(RESERVATION_MAX),
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
      await testSecurityHeaders();
      await testCors();
      await testBodyLimit();
      await testRateLimiting();
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
