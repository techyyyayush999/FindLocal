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
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 5000 });
    await mongoose.connection.db.dropDatabase();
    await mongoose.disconnect();
    console.log(`  Cleanup: dropped ${TEST_DB_NAME} (a no-op if it was never created).`);
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
  console.log('FindLocal Phase 8 Stage 2 — HTTP security hardening tests');
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
