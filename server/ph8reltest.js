/**
 * ph8reltest.js — FindLocal Phase 8 Stage 3: Reliability & Error Handling tests
 *
 *   A. Graceful shutdown (in-process, with fakes)
 *      - drains in-flight requests, stops the sweeper, closes the server and the
 *        Mongoose connection, exits 0; idempotent on repeated signals; bounded by
 *        a timeout when a step hangs; contains errors and exits non-zero.
 *   B. Health & readiness (in-process)
 *      - liveness never touches the database; readiness is 503 while MongoDB is
 *        disconnected and 200 once it is connected.
 *   C. Error normalization (in-process)
 *      - Mongoose CastError / ValidationError → 400, duplicate key → 409,
 *        auth status codes preserved, raw 5xx messages hidden in production.
 *   D. Startup reliability (spawned server)
 *      - an unreachable database aborts startup with a sanitized error and a
 *        non-zero exit code (and never starts listening); a reachable database
 *        yields a listening server whose readiness is 200.
 *   E. HTTP contracts (against the spawned server)
 *      - 404 for unknown routes, 401 for a protected route, 400 for an invalid
 *        :id, and no infrastructure leakage from the readiness endpoint.
 *
 * ISOLATION / SAFETY
 *   - Never touches the shared development database; a per-run database
 *     (<db>_ph8reltest_<runid>) is used and dropped at the end.
 *   - Graceful shutdown is verified in-process because Windows force-terminates
 *     a child on child.kill('SIGTERM') without running signal handlers.
 *   - No secret value is ever printed.
 *
 * Usage (from the server folder):
 *   node ph8reltest.js
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
  u.pathname = `/${baseName}_ph8reltest_${suffix}`;
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
  if (hostIsRemote(BASE_HOST) && process.env.PH8REL_ALLOW_REMOTE !== '1') {
    throw new Error(
      `Refusing to run: MONGO_URI host "${BASE_HOST}" is not local. ` +
        'Set PH8REL_ALLOW_REMOTE=1 to explicitly allow a remote database.'
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

const TEST_PORT = Number(process.env.PH8_REL_TEST_PORT || 5024);
const DEAD_PORT = TEST_PORT + 1; // used by the unreachable-database case
const CORS_TEST_ORIGIN = 'http://localhost:5200';

// A deterministic, non-placeholder, 49-character secret used only in tests.
const VALID_SECRET = 'ph8-rel-valid-secret-7b2e9c4a1f6d8b0e3a5c7d9f1b2e4a60';

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

function captureLogger() {
  const lines = [];
  return {
    lines,
    log: (m) => lines.push(String(m)),
    error: (m) => lines.push(String(m)),
  };
}

// ─── Mock Express response ────────────────────────────────────────────────────
function mockRes() {
  return {
    statusCode: 200,
    jsonBody: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.jsonBody = body;
      return this;
    },
  };
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

function waitForExit(child, timeoutMs = 20000) {
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

function request(port, reqPath, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: 'localhost', port, path: reqPath, method: 'GET', timeout: timeoutMs },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(data);
          } catch {
            /* non-JSON body */
          }
          resolve({ status: res.statusCode, body: data, json });
        });
      }
    );
    req.on('error', () => resolve({ status: 0, body: '', json: null }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, body: '', json: null });
    });
    req.end();
  });
}

async function waitForHealth(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await request(port, '/api/v1/health');
    if (res.status === 200) return true;
    await sleep(250);
  }
  return false;
}

// ══════════════════════════════════════════════════════════════════════════════
// Section A — Graceful shutdown
// ══════════════════════════════════════════════════════════════════════════════
async function testGracefulShutdown() {
  section('A. Graceful shutdown');

  const { createGracefulShutdown } = require('./src/utils/gracefulShutdown');

  // A1 — drains an in-flight request, then closes everything and exits 0.
  {
    const httpServer = http.createServer((req, res) => {
      setTimeout(() => res.end('late-ok'), 250); // in-flight when the signal arrives
    });
    await new Promise((r) => httpServer.listen(0, r));
    const port = httpServer.address().port;

    const events = [];
    const exits = [];
    const logger = captureLogger();
    const sweeper = { stop: () => events.push('sweeper') };
    const connection = {
      close: () => {
        events.push('connection');
        return Promise.resolve();
      },
    };

    const inFlight = request(port, '/anything', 3000);
    await sleep(50); // ensure the request is being handled

    const { shutdown } = createGracefulShutdown({
      server: httpServer,
      connection,
      sweeper,
      logger,
      timeoutMs: 5000,
      exit: (code) => exits.push(code),
    });

    const result = await shutdown('SIGTERM');
    const inflightRes = await inFlight;

    assert(result.ok === true, 'A1 shutdown resolves successfully');
    assert(inflightRes.status === 200 && inflightRes.body === 'late-ok', 'A1 in-flight request drained to completion');
    assert(events.includes('sweeper'), 'A1 the expiry sweeper is stopped');
    assert(events.includes('connection'), 'A1 the database connection is closed');
    assert(httpServer.listening === false, 'A1 the HTTP server is no longer listening');
    assert(exits.length === 1 && exits[0] === 0, 'A1 exits with code 0 exactly once');
  }

  // A2 — idempotent: a second signal must not re-run cleanup.
  {
    const httpServer = http.createServer((req, res) => res.end('ok'));
    await new Promise((r) => httpServer.listen(0, r));

    let sweeperStops = 0;
    let connectionCloses = 0;
    const exits = [];
    const logger = captureLogger();

    const { shutdown } = createGracefulShutdown({
      server: httpServer,
      connection: { close: () => (connectionCloses++, Promise.resolve()) },
      sweeper: { stop: () => (sweeperStops += 1) },
      logger,
      timeoutMs: 5000,
      exit: (code) => exits.push(code),
    });

    const first = await shutdown('SIGINT');
    const second = await shutdown('SIGINT');

    assert(first.ok === true, 'A2 first shutdown completes');
    assert(second.alreadyShuttingDown === true, 'A2 a repeated signal is ignored');
    assert(sweeperStops === 1, 'A2 the sweeper is stopped exactly once');
    assert(connectionCloses === 1, 'A2 the connection is closed exactly once');
    assert(exits.length === 1 && exits[0] === 0, 'A2 exit is invoked exactly once');
  }

  // A3 — a failing connection close is contained and exits non-zero.
  {
    const httpServer = http.createServer((req, res) => res.end('ok'));
    await new Promise((r) => httpServer.listen(0, r));
    const exits = [];
    const logger = captureLogger();

    const { shutdown } = createGracefulShutdown({
      server: httpServer,
      connection: { close: () => Promise.reject(new Error('boom')) },
      sweeper: { stop: () => {} },
      logger,
      timeoutMs: 5000,
      exit: (code) => exits.push(code),
    });

    const result = await shutdown('SIGTERM');
    assert(result.ok === false, 'A3 a shutdown error is reported');
    assert(exits.length === 1 && exits[0] === 1, 'A3 exits non-zero when cleanup fails');
  }

  // A4 — bounded: a hung server.close must not hang the process forever.
  {
    const exits = [];
    const logger = captureLogger();
    const hungServer = { listening: true, close: () => {} }; // never calls back

    const { shutdown } = createGracefulShutdown({
      server: hungServer,
      connection: { close: () => Promise.resolve() },
      sweeper: { stop: () => {} },
      logger,
      timeoutMs: 60,
      exit: (code) => exits.push(code),
    });

    shutdown('SIGTERM'); // intentionally not awaited — it never resolves
    await sleep(200);
    assert(exits.length === 1 && exits[0] === 1, 'A4 a hung shutdown is force-exited within the bound');
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Section B — Health & readiness
// ══════════════════════════════════════════════════════════════════════════════
async function testHealthAndReadiness() {
  section('B. Health & readiness');

  const { getHealthStatus, getReadinessStatus } = require('./src/controllers/health.controller');

  // B1 — liveness does not depend on the database.
  const liveRes = mockRes();
  getHealthStatus({}, liveRes);
  assert(liveRes.statusCode === 200 && liveRes.jsonBody.status === 'ok', 'B1 liveness returns 200 ok');

  // B2 — readiness is unavailable while MongoDB is disconnected.
  assert(mongoose.connection.readyState === 0, 'B2 precondition: MongoDB is disconnected');
  const notReady = mockRes();
  getReadinessStatus({}, notReady);
  assert(notReady.statusCode === 503, 'B2 readiness is 503 while disconnected');
  assert(notReady.jsonBody.status === 'unavailable', 'B2 readiness reports status "unavailable"');
  assert(
    !JSON.stringify(notReady.jsonBody).includes('mongodb://'),
    'B2 readiness body does not leak the connection string'
  );

  // B3 — readiness becomes available once MongoDB is connected.
  try {
    await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 5000 });
    const ready = mockRes();
    getReadinessStatus({}, ready);
    assert(ready.statusCode === 200, 'B3 readiness is 200 once connected');
    assert(ready.jsonBody.status === 'ready', 'B3 readiness reports status "ready"');
  } finally {
    await mongoose.disconnect();
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Section C — Error normalization
// ══════════════════════════════════════════════════════════════════════════════
function testErrorNormalization() {
  section('C. Error normalization');

  const { errorHandler } = require('./src/middlewares/errorHandler');
  const User = require('./src/models/User.model');

  const run = (err, statusOnRes = 200) => {
    const res = mockRes();
    res.statusCode = statusOnRes;
    errorHandler(err, { originalUrl: '/test' }, res, () => {});
    return res;
  };

  // C1 — Mongoose CastError → 400.
  const castErr = new mongoose.Error.CastError('ObjectId', 'not-an-id', '_id');
  const castRes = run(castErr);
  assert(castRes.statusCode === 400, 'C1 CastError is normalized to 400');
  assert(castRes.jsonBody.success === false, 'C1 CastError response has success:false');
  assert(!JSON.stringify(castRes.jsonBody).includes('Cast to ObjectId'), 'C1 CastError does not leak cast internals');

  // C2 — Mongoose ValidationError → 400 with a per-field list.
  const valErr = new User({}).validateSync();
  assert(valErr && valErr.name === 'ValidationError', 'C2 precondition: a real ValidationError is produced');
  const valRes = run(valErr);
  assert(valRes.statusCode === 400, 'C2 ValidationError is normalized to 400');
  assert(valRes.jsonBody.message === 'Validation failed', 'C2 ValidationError uses the shared message');
  assert(
    Array.isArray(valRes.jsonBody.errors) && valRes.jsonBody.errors.every((e) => e.field && e.message),
    'C2 ValidationError lists {field, message} entries'
  );

  // C3 — duplicate key → 409 (preserved).
  const dupErr = new Error('E11000 duplicate key error');
  dupErr.code = 11000;
  dupErr.keyValue = { email: 'someone@example.com' };
  const dupRes = run(dupErr);
  assert(dupRes.statusCode === 409, 'C3 duplicate key is 409 (preserved)');
  assert(/email/.test(dupRes.jsonBody.message), 'C3 duplicate key names the offending field');

  // C4 — auth errors keep their status codes.
  const authErr = new Error('Not authorized to access this route.');
  authErr.statusCode = 401;
  assert(run(authErr).statusCode === 401, 'C4 a 401 statusCode is preserved');

  const forbiddenErr = new Error('Forbidden.');
  forbiddenErr.statusCode = 403;
  assert(run(forbiddenErr).statusCode === 403, 'C4 a 403 statusCode is preserved');

  // C5 — a status already set on the response is honoured (notFound → 404).
  const notFoundErr = new Error('Not Found - /missing');
  const nfRes = run(notFoundErr, 404);
  assert(nfRes.statusCode === 404 && /Not Found/.test(nfRes.jsonBody.message), 'C5 a pre-set 404 is honoured');
  assert(nfRes.jsonBody.message === 'Not Found - /missing', 'C5 the notFound message contract is preserved');

  // C5b — stack traces are attached in development only (deterministic: NODE_ENV
  // is set explicitly because this harness may inherit one from .env).
  const envBeforeC5b = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'development';
    const devRes = run(new Error('dev explode'));
    assert(typeof devRes.jsonBody.stack === 'string', 'C5b development responses include a stack trace');

    process.env.NODE_ENV = 'test';
    const testRes = run(new Error('test explode'));
    assert(testRes.jsonBody.stack === undefined, 'C5b non-development responses omit the stack trace');
  } finally {
    process.env.NODE_ENV = envBeforeC5b;
  }

  // C6 — an unexpected error is a 500, never a 200.
  const generic = new Error('unexpected explode');
  assert(run(generic).statusCode === 500, 'C6 an unexpected error becomes 500');

  // C7 — production hides raw 5xx messages and stack traces.
  const originalEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const leaky = new Error('connect ECONNREFUSED 10.0.0.5:27017 user=admin pass=hunter2');
    const prodRes = run(leaky);
    assert(prodRes.statusCode === 500, 'C7 production 5xx is 500');
    assert(prodRes.jsonBody.message === 'Internal Server Error', 'C7 production hides the raw 5xx message');
    assert(prodRes.jsonBody.stack === undefined, 'C7 production never includes a stack trace');
    assert(
      !JSON.stringify(prodRes.jsonBody).includes('hunter2') &&
        !JSON.stringify(prodRes.jsonBody).includes('ECONNREFUSED'),
      'C7 production response exposes no internals'
    );

    // Client errors remain descriptive in production (contract preserved).
    const clientErr = new Error('Bad request payload.');
    clientErr.statusCode = 400;
    const prodClient = run(clientErr);
    assert(prodClient.statusCode === 400 && prodClient.jsonBody.message === 'Bad request payload.', 'C7 client messages are preserved in production');
  } finally {
    process.env.NODE_ENV = originalEnv;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Section D — Startup reliability (spawned)
// ══════════════════════════════════════════════════════════════════════════════
async function testStartupReliability() {
  section('D. Startup reliability');

  // D1 — an unreachable database aborts startup: sanitized error, non-zero exit.
  const unreachableUri = `mongodb://127.0.0.1:1/${TEST_DB_NAME}_unreachable`;
  const dead = spawnServer({
    ...process.env,
    MONGO_URI: unreachableUri,
    MONGO_SERVER_SELECTION_TIMEOUT_MS: '700',
    PORT: String(DEAD_PORT),
    NODE_ENV: 'test',
    CORS_ORIGIN: CORS_TEST_ORIGIN,
    JWT_SECRET: VALID_SECRET,
  });
  const deadCapture = startCapture(dead);
  const deadResult = await waitForExit(dead, 20000);
  const deadStop = await stopChild(dead);
  if (!deadStop.stopped) {
    // Never ignore a shutdown failure: it must surface as a non-zero exit.
    failed++;
    failures.push('shutdown: unreachable-database server did not terminate within the timeout');
  }

  assert(!deadResult.timedOut, 'D1 the server exits on its own when the database is unreachable');
  assert(deadResult.code !== 0, `D1 it exits with a non-zero code (got ${deadResult.code})`);
  assert(/startup failed/i.test(deadCapture.err), 'D1 stderr explains the startup failure');
  assert(
    !/running in test mode on port/i.test(deadCapture.out),
    'D1 the server never reports that it is listening'
  );
  assert(
    !deadCapture.err.includes('127.0.0.1:1') && !deadCapture.out.includes('127.0.0.1:1'),
    'D1 the failure output does not leak the database address'
  );
  const deadProbe = await request(DEAD_PORT);
  assert(deadProbe.status === 0, 'D1 nothing is listening after the failed startup');

  // D2 — a reachable database yields a listening server with a ready DB.
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
  assert(healthy, 'D2 the server listens only after MongoDB connects');
  assert(/running in test mode on port/i.test(capture.out), 'D2 startup log confirms the environment and port');

  const healthRes = await request(TEST_PORT, '/api/v1/health');
  assert(healthRes.status === 200 && healthRes.json.status === 'ok', 'D2 liveness endpoint returns 200 ok');

  const readyRes = await request(TEST_PORT, '/api/v1/health/ready');
  assert(readyRes.status === 200 && readyRes.json.status === 'ready', 'D2 readiness endpoint returns 200 ready');
}

// ══════════════════════════════════════════════════════════════════════════════
// Section E — HTTP contracts (against the spawned server)
// ══════════════════════════════════════════════════════════════════════════════
async function testHttpContracts() {
  section('E. HTTP error contracts');

  // E1 — unknown route → 404.
  const notFoundRes = await request(TEST_PORT, '/api/v1/does-not-exist');
  assert(notFoundRes.status === 404, 'E1 an unknown route returns 404');
  assert(
    notFoundRes.json && /Not Found/.test(notFoundRes.json.message),
    'E1 the 404 body preserves the notFound message'
  );

  // E2 — a protected route without a cookie → 401.
  const protectedRes = await request(TEST_PORT, '/api/v1/admin/users');
  assert(protectedRes.status === 401, 'E2 a protected route without credentials returns 401');

  // E3 — an invalid ObjectId route param → 400 (existing validator contract).
  const badIdRes = await request(TEST_PORT, '/api/v1/shops/not-a-valid-id');
  assert(badIdRes.status === 400, 'E3 an invalid :id returns 400');

  // E4 — readiness never exposes infrastructure details.
  const readyRes = await request(TEST_PORT, '/api/v1/health/ready');
  const raw = JSON.stringify(readyRes.json);
  assert(
    !/mongodb:\/\/|MONGO_URI|findlocal_ph8reltest/i.test(raw),
    'E4 readiness exposes no connection string, env name or database name'
  );
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
  console.log('FindLocal Phase 8 Stage 3 — Reliability & error handling tests');
  console.log(`  Isolated database: ${TEST_DB_NAME}`);

  // Refuse a remote database before any connection, spawn, or cleanup. Kept
  // outside the try so a refusal prevents the finally-block cleanup from
  // opening a database connection.
  assertRemoteAllowed();

  try {
    await testGracefulShutdown();
    await testHealthAndReadiness();
    testErrorNormalization();
    await testStartupReliability();
    await testHttpContracts();
  } finally {
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
