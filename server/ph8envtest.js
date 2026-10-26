/**
 * ph8envtest.js — FindLocal Phase 8 Stage 1: Environment validation tests
 *
 * Verifies the centralized configuration guard (src/config/env.js):
 *   A. Unit validation — missing / placeholder / weak / valid JWT secrets,
 *      MONGO_URI, and CORS_ORIGIN rules (no server, no database).
 *   B. Startup refusal — server.js must exit non-zero BEFORE listening (and
 *      before connecting to MongoDB) when required configuration is invalid.
 *   C. Valid startup — a valid test configuration starts the server and serves
 *      /api/v1/health.
 *
 * ISOLATION / SAFETY
 *   - This script NEVER touches the shared development database.
 *   - The valid-startup server is spawned with an isolated database name
 *     (<db>_ph8envtest_<runid>) and killed at the end; nothing is written, so the
 *     isolated database is dropped only as a safety no-op.
 *   - No secret value is ever printed by this script.
 *
 * Usage (from the server folder):
 *   node ph8envtest.js
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
  u.pathname = `/${baseName}_ph8envtest_${suffix}`;
  return { uri: u.toString(), dbName: u.pathname.slice(1) };
}

const BASE_DB_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/findlocal';
const { uri: TEST_URI, dbName: TEST_DB_NAME } = deriveTestUri(BASE_DB_URI, RUN_SUFFIX);
const TEST_PORT = Number(process.env.PH8_TEST_PORT || 5018);
const CORS_TEST_ORIGIN = 'http://localhost:5198';

// A deterministic, non-placeholder, 49-character secret used only in tests.
const VALID_SECRET = 'ph8-valid-secret-9f3c2a7b1d4e6f8091a2b3c4d5e6f7081';
// A distinctive weak (too short) secret used to prove errors never echo values.
const WEAK_SECRET_FOR_REDACTION = 'Zq7xV2mK9pL4';

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

// ─── Child-process helpers ────────────────────────────────────────────────────
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

function waitForExit(child, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve({ timedOut: true, code: null });
      }
    }, timeoutMs);
    child.on('exit', (code, signal) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ timedOut: false, code, signal });
      }
    });
    child.on('error', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ timedOut: false, code: -1 });
      }
    });
  });
}

function killServer(child) {
  if (!child || child.killed) return;
  try {
    child.kill();
  } catch {
    /* already gone */
  }
}

function healthRequest(port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: 'localhost', port, path: '/api/v1/health', method: 'GET', timeout: timeoutMs },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on('error', () => resolve({ status: 0 }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0 });
    });
    req.end();
  });
}

async function waitForHealth(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await healthRequest(port);
    if (res.status === 200) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ══════════════════════════════════════════════════════════════════════════════
// Section A — Unit validation
// ══════════════════════════════════════════════════════════════════════════════
function testConfigValidation() {
  section('A. Environment validation (unit)');

  const { validateEnv, assertValidEnv, ConfigError } = require('./src/config/env');

  const base = {
    MONGO_URI: 'mongodb://localhost:27017/findlocal',
    JWT_SECRET: VALID_SECRET,
    CORS_ORIGIN: 'http://localhost:5173',
  };

  // A1 — everything missing
  const empty = validateEnv({});
  assert(empty.ok === false, 'A1 completely empty env is rejected');
  assert(empty.errors.some((e) => e.includes('MONGO_URI')), 'A1 reports the missing MONGO_URI');
  assert(empty.errors.some((e) => e.includes('JWT_SECRET')), 'A1 reports the missing JWT_SECRET');
  assert(empty.errors.some((e) => e.includes('CORS_ORIGIN')), 'A1 reports the missing CORS_ORIGIN');

  // A2 — missing JWT_SECRET
  const noSecret = validateEnv({ ...base, JWT_SECRET: '' });
  assert(noSecret.ok === false, 'A2 missing JWT_SECRET is rejected');
  assert(
    noSecret.errors.some((e) => e.includes('JWT_SECRET') && /required/i.test(e)),
    'A2 reports JWT_SECRET as required'
  );

  // A3 — known placeholder
  const placeholder = validateEnv({ ...base, JWT_SECRET: 'your_jwt_secret_here' });
  assert(placeholder.ok === false, 'A3 placeholder "your_jwt_secret_here" is rejected');
  assert(placeholder.errors.some((e) => /placeholder/i.test(e)), 'A3 reports a placeholder reason');

  // A3b — a long but still placeholder-looking value
  const placeholder2 = validateEnv({
    ...base,
    JWT_SECRET: 'change_me_to_something_long_and_random_value',
  });
  assert(placeholder2.ok === false, 'A3b long placeholder-looking JWT_SECRET is rejected');

  // A4 — weak: too short
  const weakShort = validateEnv({ ...base, JWT_SECRET: 'short_secret' });
  assert(weakShort.ok === false, 'A4 short JWT_SECRET is rejected');
  assert(weakShort.errors.some((e) => /at least 32/i.test(e)), 'A4 reports the 32-character minimum');

  // A5 — weak: single repeated character
  const weakRepeat = validateEnv({ ...base, JWT_SECRET: 'a'.repeat(48) });
  assert(weakRepeat.ok === false, 'A5 repeated-character JWT_SECRET is rejected');

  // A6 — missing MONGO_URI
  const noMongo = validateEnv({ ...base, MONGO_URI: '' });
  assert(
    noMongo.ok === false && noMongo.errors.some((e) => e.includes('MONGO_URI')),
    'A6 missing MONGO_URI is rejected'
  );

  // A7 — wrong MONGO_URI scheme
  const badMongo = validateEnv({ ...base, MONGO_URI: 'http://localhost:27017/findlocal' });
  assert(
    badMongo.ok === false && badMongo.errors.some((e) => /mongodb:\/\//i.test(e)),
    'A7 non-mongodb MONGO_URI is rejected'
  );

  // A8 — missing CORS_ORIGIN
  const noCors = validateEnv({ ...base, CORS_ORIGIN: '' });
  assert(
    noCors.ok === false && noCors.errors.some((e) => e.includes('CORS_ORIGIN')),
    'A8 missing CORS_ORIGIN is rejected'
  );

  // A9 — wildcard CORS origin
  const wildcard = validateEnv({ ...base, CORS_ORIGIN: '*' });
  assert(
    wildcard.ok === false && wildcard.errors.some((e) => e.includes('*')),
    'A9 wildcard CORS_ORIGIN is rejected'
  );

  // A10 — valid configuration
  const ok = validateEnv(base);
  assert(ok.ok === true, 'A10 valid configuration is accepted');
  assert(ok.config.jwtSecret === VALID_SECRET, 'A10 valid secret is preserved in the config');
  assert(
    Array.isArray(ok.config.corsOrigins) && ok.config.corsOrigins.length === 1,
    'A10 CORS origin is parsed into an array'
  );
  assert(ok.config.port === 5000, 'A10 port defaults to 5000');

  // A11 — multiple origins + explicit port
  const multi = validateEnv({ ...base, CORS_ORIGIN: 'http://a.test, https://b.test', PORT: '5123' });
  assert(multi.ok === true && multi.config.corsOrigins.length === 2, 'A11 comma-separated origins are parsed');
  assert(multi.config.port === 5123, 'A11 explicit port is parsed as a number');

  // A12 — assertValidEnv contract
  let threw = null;
  try {
    assertValidEnv(base);
  } catch (e) {
    threw = e;
  }
  assert(threw === null, 'A12 assertValidEnv returns without throwing for a valid config');

  let configError = null;
  try {
    assertValidEnv({ ...base, JWT_SECRET: 'your_jwt_secret_here' });
  } catch (e) {
    configError = e;
  }
  assert(configError instanceof ConfigError, 'A12 assertValidEnv throws a ConfigError for invalid config');
  assert(configError && configError.code === 'INVALID_ENV', 'A12 ConfigError carries code INVALID_ENV');

  // A13 — error messages never echo the actual secret value
  let redactionError = null;
  try {
    assertValidEnv({ ...base, JWT_SECRET: WEAK_SECRET_FOR_REDACTION });
  } catch (e) {
    redactionError = e;
  }
  assert(
    redactionError && !redactionError.message.includes(WEAK_SECRET_FOR_REDACTION),
    'A13 error message does not leak the secret value'
  );
  assert(
    redactionError && redactionError.message.includes('JWT_SECRET'),
    'A13 error message still names the offending variable'
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Section B — Server refuses to start with invalid configuration
// ══════════════════════════════════════════════════════════════════════════════
async function testStartupFailures() {
  section('B. Server refuses to start with invalid configuration');

  const validEnv = {
    ...process.env,
    MONGO_URI: TEST_URI,
    PORT: String(TEST_PORT),
    NODE_ENV: 'test',
    CORS_ORIGIN: CORS_TEST_ORIGIN,
    JWT_SECRET: VALID_SECRET,
  };

  const cases = [
    { name: 'B1 whitespace-only JWT_SECRET', env: { JWT_SECRET: '   ' }, noEcho: null },
    { name: 'B2 placeholder JWT_SECRET', env: { JWT_SECRET: 'your_jwt_secret_here' }, noEcho: null },
    { name: 'B3 weak JWT_SECRET', env: { JWT_SECRET: WEAK_SECRET_FOR_REDACTION }, noEcho: WEAK_SECRET_FOR_REDACTION },
    { name: 'B4 invalid MONGO_URI', env: { MONGO_URI: 'not-a-mongo-uri' }, noEcho: 'not-a-mongo-uri' },
    { name: 'B5 wildcard CORS_ORIGIN', env: { CORS_ORIGIN: '*' }, noEcho: null },
  ];

  for (const testCase of cases) {
    const child = spawnServer({ ...validEnv, ...testCase.env });
    const capture = startCapture(child);
    const result = await waitForExit(child);
    await sleep(100); // let any trailing stdio flush
    killServer(child);

    assert(!result.timedOut, `${testCase.name}: process exits on its own`);
    assert(result.code !== 0, `${testCase.name}: exits with a non-zero code (got ${result.code})`);
    assert(
      /Invalid environment configuration/i.test(capture.err),
      `${testCase.name}: stderr explains the configuration error`
    );
    assert(
      !/running in test mode on port/i.test(capture.out),
      `${testCase.name}: server never reported that it was listening`
    );
    if (testCase.noEcho) {
      assert(
        !capture.err.includes(testCase.noEcho) && !capture.out.includes(testCase.noEcho),
        `${testCase.name}: output does not leak the invalid value`
      );
    }
  }

  // Nothing should be listening after all of the failed starts.
  const res = await healthRequest(TEST_PORT);
  assert(res.status === 0, 'B6 no server is listening after the failed startups');
}

// ══════════════════════════════════════════════════════════════════════════════
// Section C — Valid configuration starts the server
// ══════════════════════════════════════════════════════════════════════════════
async function testValidStartup() {
  section('C. Server starts with a valid configuration');

  server = spawnServer({
    ...process.env,
    MONGO_URI: TEST_URI,
    PORT: String(TEST_PORT),
    NODE_ENV: 'test',
    CORS_ORIGIN: CORS_TEST_ORIGIN,
    JWT_SECRET: VALID_SECRET,
  });
  const capture = startCapture(server);

  const healthy = await waitForHealth(TEST_PORT, 20000);
  assert(healthy, 'C1 server listens and /api/v1/health returns 200');

  const res = await healthRequest(TEST_PORT);
  assert(res.status === 200, 'C2 health endpoint is reachable over HTTP');
  assert(/running in test mode on port/i.test(capture.out), 'C3 startup log confirms the test environment and port');

  killServer(server);
  const exit = await waitForExit(server, 5000);
  assert(!exit.timedOut, 'C4 the test server terminates cleanly');
  server = null;
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

async function main() {
  console.log('FindLocal Phase 8 Stage 1 — Environment validation tests');
  console.log(`  Isolated database: ${TEST_DB_NAME}`);

  try {
    testConfigValidation();
    await testStartupFailures();
    await testValidStartup();
  } finally {
    killServer(server);
    await cleanup();
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed, ${skipped} skipped, ${passed + failed + skipped} total`);
  if (failures.length) console.log(`Failures:\n - ${failures.join('\n - ')}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
