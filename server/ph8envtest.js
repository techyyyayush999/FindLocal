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
const { MongoClient } = mongoose.mongo;

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
  if (hostIsRemote(BASE_HOST) && process.env.PH8ENV_ALLOW_REMOTE !== '1') {
    throw new Error(
      `Refusing to run: MONGO_URI host "${BASE_HOST}" is not local. ` +
        'Set PH8ENV_ALLOW_REMOTE=1 to explicitly allow a remote database.'
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
    const stopResult = await stopChild(child);
    if (!stopResult.stopped) {
      // Never ignore a shutdown failure: it must surface as a non-zero exit.
      failed++;
      failures.push(`${testCase.name}: child server did not terminate within the timeout`);
    }

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

async function main() {
  console.log('FindLocal Phase 8 Stage 1 — Environment validation tests');
  console.log(`  Isolated database: ${TEST_DB_NAME}`);

  // Refuse a remote database before any connection, spawn, or cleanup. Kept
  // outside the try so a refusal prevents the finally-block cleanup from
  // opening a database connection.
  assertRemoteAllowed();

  try {
    testConfigValidation();
    await testStartupFailures();
    await testValidStartup();
  } finally {
    // Awaited, bounded shutdown on the failure path too (not just the success
    // path in Section C): SIGTERM → wait → SIGKILL → wait.
    const stopResult = await stopChild(server);
    if (!stopResult.stopped) {
      // Never ignore a shutdown failure: it must surface as a non-zero exit.
      failed++;
      failures.push('shutdown: child server did not terminate within the timeout');
    }
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
