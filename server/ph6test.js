/**
 * ph6test.js — FindLocal Phase 6 Search Filter Smoke Test
 *
 * Verifies the extended GET /api/v1/products/search endpoint:
 *   brand, category, minPrice, maxPrice, inStock, openNow
 * plus backward-compatibility of the Phase 5 defaults.
 *
 * Prerequisites:
 *   - MongoDB running; server/.env provides MONGO_URI (used to derive the DB name)
 *   - By default the script spawns its OWN server on port 5016 backed by an
 *     isolated per-run database and seeds the admin / shop / product itself, so no
 *     pre-existing dev data is required.
 *   - Set PH6_TEST_BASE_URL to target an already-running server instead (disables
 *     the spawn / seed / drop harness).
 *
 * SAFETY / CLEANUP:
 *   - Existing user data is NEVER modified or deleted.
 *   - The behavioural section creates an ISOLATED fixture (one seller + one
 *     closed shop + one out-of-stock inventory row, all with per-run unique
 *     identifiers) and deletes exactly those documents in a finally block,
 *     scoped to the captured IDs only.
 *   - In harness mode ONLY the derived per-run database is dropped and the spawned
 *     test server is terminated. An external server's database is never dropped.
 *   - If no baseline fixture exists, behavioural checks are SKIPPED (never
 *     failed) and only the validation checks run.
 *
 * Usage (from server folder):
 *   node ph6test.js
 */

const http = require('http');
const path = require('path');
const mongoose = require('mongoose');
const { spawn } = require('child_process');

require('dotenv').config({ path: path.join(__dirname, '.env') });

// Base URL of the API under test. Keeps the historical default; the isolation
// harness below overrides it to a dedicated test port unless PH6_TEST_BASE_URL is
// supplied to target an already-running server.
let BASE = process.env.PH6_TEST_BASE_URL || 'http://localhost:5000/api/v1';
const ADMIN_CREDS = { email: 'admin@findlocal.dev', password: 'Admin@12345' };
const RUN_SUFFIX = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

let adminCookie = '';

const created = {
  userId: null,
  shopId: null,
  inventoryId: null,
};

// ══════════════════════════════════════════════════════════════════════════════
// Isolation harness
// By default this script runs against its OWN server on a dedicated port backed by
// a per-run database derived from MONGO_URI, seeds the required admin / verified
// shop / active product / in-stock inventory there, and drops ONLY that database at
// the end — it never touches the shared development database. Set PH6_TEST_BASE_URL
// to target an already-running server instead (this disables spawn / seed / drop).
// ══════════════════════════════════════════════════════════════════════════════

function deriveTestUri(uri, suffix) {
  const u = new URL(uri);
  const baseName = u.pathname.replace(/^\//, '') || 'findlocal';
  u.pathname = `/${baseName}_ph6test_${suffix}`;
  return { uri: u.toString(), dbName: u.pathname.slice(1), baseName };
}

const BASE_DB_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/findlocal';
const EXTERNAL_BASE = process.env.PH6_TEST_BASE_URL || null;
const TEST_PORT = Number(process.env.PH6_TEST_PORT || 5016);
const { uri: TEST_URI, dbName: TEST_DB_NAME, baseName: BASE_DB_NAME } =
  deriveTestUri(BASE_DB_URI, RUN_SUFFIX);

if (!EXTERNAL_BASE) {
  BASE = `http://localhost:${TEST_PORT}/api/v1`;
  // Ensure this script's own DB helpers (fixture discovery / cleanup) target the
  // isolated database.
  process.env.MONGO_URI = TEST_URI;
}

let testServer = null;
let dbConnected = false;

async function waitForHealth(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await request('GET', '/health');
      if (res.status === 200) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

// Seed the admin plus one verified/open shop backed by in-stock active inventory so
// the behavioural section has a baseline fixture to discover.
async function seedFixtures() {
  const User = require('./src/models/User.model');
  const Shop = require('./src/models/Shop.model');
  const Product = require('./src/models/Product.model');
  const Inventory = require('./src/models/Inventory.model');
  await Promise.all([User.init(), Shop.init(), Product.init(), Inventory.init()]);

  let admin = await User.findOne({ email: ADMIN_CREDS.email });
  if (!admin) {
    admin = await User.create({
      name: 'FindLocal Admin',
      email: ADMIN_CREDS.email,
      password: ADMIN_CREDS.password,
      role: 'admin',
      isVerified: true,
      isActive: true,
    });
  }

  const seller = await User.create({
    name: `Phase6 Seed Seller ${RUN_SUFFIX}`,
    email: `phase6_seed_seller_${RUN_SUFFIX}@test.local`,
    password: 'Phase6Seed@12345',
    role: 'seller',
    isVerified: true,
    isActive: true,
  });

  const shop = await Shop.create({
    owner: seller._id,
    name: `Phase6 Baseline Shop ${RUN_SUFFIX}`,
    address: `Phase6 Baseline Address ${RUN_SUFFIX}`,
    location: { type: 'Point', coordinates: [77.209, 28.6139] },
    isVerified: true,
    isOpen: true,
  });

  const product = await Product.create({
    name: `Phase6 Baseline Widget ${RUN_SUFFIX}`,
    brand: 'Phase6Brand',
    category: 'electronics',
    status: 'ACTIVE',
    createdBy: seller._id,
  });

  await Inventory.create({
    shop: shop._id,
    product: product._id,
    pricePaise: 5000,
    quantity: 10,
    isActive: true,
  });
}

async function startIsolatedServer() {
  if (EXTERNAL_BASE) {
    console.log(`  Using external server at ${EXTERNAL_BASE} (no spawn / no DB drop).`);
    return;
  }

  console.log(`  Base database (from .env): ${BASE_DB_NAME}`);
  console.log(`  Isolated test database:    ${TEST_DB_NAME}`);
  console.log(`  Dedicated test port:       ${TEST_PORT}`);

  await mongoose.connect(TEST_URI);
  dbConnected = true;
  if (mongoose.connection.name !== TEST_DB_NAME) {
    throw new Error(
      `Refusing to run: connected to ${mongoose.connection.name}, expected ${TEST_DB_NAME}`
    );
  }
  await seedFixtures();
  console.log(`  Admin / verified shop / active product / inventory seeded into ${TEST_DB_NAME}.`);

  testServer = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: {
      ...process.env,
      MONGO_URI: TEST_URI,
      PORT: String(TEST_PORT),
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let serverOutput = '';
  testServer.stdout.on('data', (d) => (serverOutput += d.toString()));
  testServer.stderr.on('data', (d) => (serverOutput += d.toString()));

  const ready = await waitForHealth();
  if (!ready) {
    console.error(serverOutput.trim());
    throw new Error(`Isolated API server did not become healthy on port ${TEST_PORT}`);
  }
  console.log(`  Isolated API server ready on port ${TEST_PORT}.`);
}

async function stopIsolatedServer() {
  if (testServer && !testServer.killed) {
    try {
      testServer.kill();
    } catch {
      /* ignore */
    }
  }
  if (dbConnected) {
    try {
      // The script's own cleanup may have disconnected mongoose; reconnect to drop.
      if (mongoose.connection.readyState === 0) await mongoose.connect(process.env.MONGO_URI);
      // Never drop a database when targeting an external / shared server.
      if (!EXTERNAL_BASE) {
        await mongoose.connection.db.dropDatabase();
        console.log(`  Dropped isolated test database: ${TEST_DB_NAME}`);
      }
    } catch (err) {
      console.error(`  Cleanup failed: ${err.message}`);
    }
    try {
      await mongoose.disconnect();
    } catch {
      /* ignore */
    }
    dbConnected = false;
  }
}

let passed = 0;
let failed = 0;
let skipped = 0;
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

function skip(label) {
  console.log(`  SKIP: ${label}`);
  skipped++;
}

function request(method, requestPath, { body = null, cookie = '' } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + requestPath);

    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: { 'Content-Type': 'application/json' },
    };

    if (cookie) options.headers.Cookie = cookie;

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        const setCookies = res.headers['set-cookie'] || [];
        let responseCookie = '';
        for (const c of setCookies) {
          if (c.startsWith('findlocal_token=')) responseCookie = c.split(';')[0];
        }

        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          parsed = data;
        }

        resolve({ status: res.statusCode, body: parsed, cookie: responseCookie });
      });
    });

    req.on('error', reject);
    if (body !== null) req.write(JSON.stringify(body));
    req.end();
  });
}

function searchPath(params) {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) usp.set(key, String(value));
  }
  return `/products/search?${usp.toString()}`;
}

function requestSearch(params, cookie) {
  return request('GET', searchPath(params), { cookie });
}

function idsOf(results) {
  return results.map((r) => String(r.product?._id)).sort();
}

function shopIdsOf(results) {
  return results.map((r) => String(r.shop?._id));
}

function sameIdSet(a, b) {
  if (a.length !== b.length) return false;
  const [x, y] = [a, b].map((arr) => [...arr].sort());
  return x.every((id, i) => id === y[i]);
}

async function loginAsAdmin() {
  console.log('\n-- Login as Admin --');
  const res = await request('POST', '/auth/login', { body: ADMIN_CREDS });
  assert(res.status === 200, `Login status 200 (got ${res.status})`);
  assert(res.body?.success === true, 'Login success');
  if (res.status !== 200 || !res.cookie) {
    throw new Error('Admin login failed; stopping test.');
  }
  adminCookie = res.cookie;
}

// ─── Read-only fixture discovery ─────────────────────────────────────────────
async function findBaselineFixture() {
  const Inventory = require('./src/models/Inventory.model');
  const Product = require('./src/models/Product.model');
  const Shop = require('./src/models/Shop.model');

  const inventories = await Inventory.find({ isActive: true }).limit(200).lean();

  for (const inv of inventories) {
    const product = await Product.findById(inv.product).lean();
    if (!product || product.status !== 'ACTIVE') continue;

    const shop = await Shop.findById(inv.shop).lean();
    if (!shop || !shop.isVerified) continue;

    const coords = shop.location && shop.location.coordinates;
    if (!Array.isArray(coords) || coords.length !== 2) continue;

    const name = String(product.name || '');
    const q = name.slice(0, Math.min(name.length, 10)).trim();
    if (q.length < 2) continue;

    return { q, lng: coords[0], lat: coords[1], product, inventory: inv, shop };
  }

  return null;
}

// ─── Isolated fixture: closed shop + out-of-stock inventory ──────────────────
async function setupIsolatedFixture(fixture) {
  console.log('\n-- Setup Isolated Fixture (closed shop + out-of-stock) --');

  const email = `phase6_seller_${RUN_SUFFIX}@test.local`;
  const password = 'Phase6Test@12345';

  const reg = await request('POST', '/auth/register', {
    body: { name: `Phase6 Seller ${RUN_SUFFIX}`, email, password, role: 'seller' },
  });

  if (reg.status !== 201 || !reg.body?.data?.user?._id) {
    throw new Error(`Isolated seller registration failed (status ${reg.status}).`);
  }

  created.userId = String(reg.body.data.user._id);
  const sellerCookie = reg.cookie;

  const shopRes = await request('POST', '/seller/shops', {
    cookie: sellerCookie,
    body: {
      name: `Phase6 Closed Shop ${RUN_SUFFIX}`,
      address: `Phase6 Test Address ${RUN_SUFFIX}`,
      longitude: fixture.lng,
      latitude: fixture.lat,
      isOpen: false,
    },
  });

  if (shopRes.status !== 201 || !shopRes.body?.data?.shop?._id) {
    throw new Error(`Isolated shop creation failed (status ${shopRes.status}).`);
  }

  created.shopId = String(shopRes.body.data.shop._id);

  const verifyRes = await request(
    'PATCH',
    `/admin/shops/${created.shopId}/verify`,
    { cookie: adminCookie }
  );

  if (verifyRes.status !== 200) {
    throw new Error(`Admin shop verification failed (status ${verifyRes.status}).`);
  }

  const invRes = await request('POST', '/inventory', {
    cookie: sellerCookie,
    body: {
      product: String(fixture.product._id),
      pricePaise: 1,
      quantity: 0,
      isActive: true,
    },
  });

  if (invRes.status !== 201 || !invRes.body?.data?.inventory?._id) {
    throw new Error(`Isolated inventory creation failed (status ${invRes.status}).`);
  }

  created.inventoryId = String(invRes.body.data.inventory._id);

  assert(true, `Isolated fixture ready (shop=${created.shopId})`);
}

async function cleanupIsolatedFixture() {
  console.log('\n-- Cleanup: Removing Isolated Fixture --');

  const steps = [];

  if (created.inventoryId) {
    steps.push(async () => {
      const Inventory = require('./src/models/Inventory.model');
      const r = await Inventory.deleteOne({
        _id: created.inventoryId,
        shop: created.shopId,
      });
      console.log(`  Deleted inventory ${created.inventoryId} (deletedCount=${r.deletedCount})`);
    });
  }

  if (created.shopId) {
    steps.push(async () => {
      const Shop = require('./src/models/Shop.model');
      const r = await Shop.deleteOne({ _id: created.shopId });
      console.log(`  Deleted shop ${created.shopId} (deletedCount=${r.deletedCount})`);
    });
  }

  if (created.userId) {
    steps.push(async () => {
      const User = require('./src/models/User.model');
      const r = await User.deleteOne({ _id: created.userId });
      console.log(`  Deleted seller user ${created.userId} (deletedCount=${r.deletedCount})`);
    });
  }

  if (steps.length === 0) {
    console.log('  Nothing to clean up.');
    return;
  }

  for (const step of steps) {
    try {
      await step();
    } catch (err) {
      console.error(`  Cleanup step failed: ${err.message}`);
      failed++;
      failures.push('cleanup step failed');
    }
  }
}

async function testValidation(fixture) {
  console.log('\n-- Validation (expect 400) --');

  const q = fixture ? fixture.q : 'ab';
  const lat = fixture ? fixture.lat : 0;
  const lng = fixture ? fixture.lng : 0;
  const base = { q, lat, lng, radius: 50000 };

  const cases = [
    { field: 'minPrice', params: { ...base, minPrice: 'abc' }, label: 'minPrice=abc' },
    { field: 'minPrice', params: { ...base, minPrice: 0 }, label: 'minPrice=0 (below PRICE_MIN)' },
    { field: 'maxPrice', params: { ...base, maxPrice: 100000001 }, label: 'maxPrice above PRICE_MAX' },
    { field: 'minPrice', params: { ...base, minPrice: 5000, maxPrice: 100 }, label: 'minPrice > maxPrice rejected' },
    { field: 'category', params: { ...base, category: 'not-a-category' }, label: 'invalid category' },
    { field: 'inStock', params: { ...base, inStock: 'yes' }, label: 'inStock=yes' },
    { field: 'inStock', params: { ...base, inStock: 'TRUE' }, label: 'inStock=TRUE (case-sensitive)' },
    { field: 'openNow', params: { ...base, openNow: '1' }, label: 'openNow=1' },
    { field: 'brand', params: { ...base, brand: 'a'.repeat(81) }, label: 'brand longer than 80 chars' },
  ];

  for (const testCase of cases) {
    const res = await requestSearch(testCase.params, adminCookie);
    const hasFieldError =
      Array.isArray(res.body?.errors) &&
      res.body.errors.some((e) => e.field === testCase.field);
    assert(
      res.status === 400 && hasFieldError,
      `${testCase.label} -> 400 with '${testCase.field}' error (got ${res.status})`
    );
  }
}

async function testBehaviour(fixture) {
  console.log('\n-- Behavioural Filters --');

  if (!fixture) {
    skip('No verified shop with active inventory/active product found; behavioural checks skipped.');
    return;
  }

  const { q, lat, lng } = fixture;
  const base = { q, lat, lng, radius: 50000, limit: 50 };
  const fixtureShopId = created.shopId;

  // ─── Baseline (Phase 5 behaviour, no filters) ───────────────────────────────
  const baselineRes = await requestSearch(base, adminCookie);
  assert(baselineRes.status === 200, `Baseline search 200 (got ${baselineRes.status})`);
  assert(baselineRes.body?.success === true, 'Baseline success');

  const baseline = baselineRes.body?.data?.results || [];
  assert(Array.isArray(baseline) && baseline.length >= 1, 'Baseline returns results');
  assert(baselineRes.body?.total >= 1, `Baseline total >= 1 (got ${baselineRes.body?.total})`);

  if (baseline.length === 0) {
    skip('Baseline returned no rows; cannot exercise behavioural filters.');
    return;
  }

  const baselineIds = idsOf(baseline);
  const baselineShopIds = shopIdsOf(baseline);

  // Backward-compatibility proof: the closed, out-of-stock isolated row is
  // present by default (Phase 5 behaviour preserved).
  const isolatedRow = baseline.find((r) => String(r.shop._id) === fixtureShopId);
  assert(Boolean(isolatedRow), 'Baseline includes the closed + out-of-stock isolated row (defaults preserved)');
  if (isolatedRow) {
    assert(isolatedRow.availableQuantity === 0, 'Isolated row has availableQuantity = 0');
    assert(isolatedRow.shop.isOpen === false, 'Isolated row shop has isOpen = false');
  }

  const firstResult = baseline.find((r) => String(r.shop._id) !== fixtureShopId) || baseline[0];
  assert(
    typeof firstResult.pricePaise === 'number' &&
      typeof firstResult.availableQuantity === 'number' &&
      firstResult.shop &&
      firstResult.product,
    'Result shape matches Phase 5 (pricePaise, availableQuantity, shop, product)'
  );

  // ─── brand ─────────────────────────────────────────────────────────────────
  const brand = String(firstResult.product.brand || '');
  if (brand.length >= 2) {
    const sub = brand.slice(0, Math.min(brand.length, 4));
    const res = await requestSearch({ ...base, brand: sub }, adminCookie);
    assert(res.status === 200, `brand filter 200 (got ${res.status})`);
    const rows = res.body?.data?.results || [];
    assert(
      rows.every((r) => String(r.product.brand || '').toLowerCase().includes(sub.toLowerCase())),
      `brand='${sub}' all results match (case-insensitive substring)`
    );

    // Negative: a brand that cannot match must exclude the isolated row.
    const missRes = await requestSearch({ ...base, brand: `zz${RUN_SUFFIX}zz` }, adminCookie);
    assert(
      (missRes.body?.data?.results || []).length === 0,
      'brand filter with non-matching value returns zero rows'
    );
  } else {
    skip('Fixture brand too short for substring test.');
  }

  // ─── category ──────────────────────────────────────────────────────────────
  const category = firstResult.product.category;
  if (category) {
    const res = await requestSearch({ ...base, category }, adminCookie);
    assert(res.status === 200, `category filter 200 (got ${res.status})`);
    const rows = res.body?.data?.results || [];
    assert(rows.every((r) => r.product.category === category), `category='${category}' all results exact-match`);
  }

  // ─── price range (isolated row has pricePaise = 1) ───────────────────────────
  const price = firstResult.pricePaise;
  const exactRes = await requestSearch({ ...base, minPrice: price, maxPrice: price }, adminCookie);
  assert(exactRes.status === 200, `minPrice=maxPrice 200 (got ${exactRes.status})`);
  assert(
    (exactRes.body?.data?.results || []).every((r) => r.pricePaise === price),
    'inclusive price range returns only matching pricePaise'
  );

  const minRes = await requestSearch({ ...base, minPrice: price + 1 }, adminCookie);
  assert(
    (minRes.body?.data?.results || []).every((r) => r.pricePaise >= price + 1),
    'minPrice excludes cheaper rows'
  );
  assert(
    !shopIdsOf(minRes.body?.data?.results || []).includes(fixtureShopId),
    'minPrice excludes the cheaper isolated row (pricePaise = 1)'
  );

  // ─── inStock ───────────────────────────────────────────────────────────────
  const inStockRes = await requestSearch({ ...base, inStock: 'true' }, adminCookie);
  assert(inStockRes.status === 200, `inStock=true 200 (got ${inStockRes.status})`);
  const inStockRows = inStockRes.body?.data?.results || [];
  assert(inStockRows.every((r) => r.availableQuantity > 0), 'inStock=true excludes availableQuantity <= 0');
  assert(
    !shopIdsOf(inStockRows).includes(fixtureShopId),
    'inStock=true excludes the out-of-stock isolated row'
  );

  const inStockFalseRes = await requestSearch({ ...base, inStock: 'false' }, adminCookie);
  assert(inStockFalseRes.status === 200, `inStock=false 200 (got ${inStockFalseRes.status})`);
  assert(
    sameIdSet(shopIdsOf(inStockFalseRes.body?.data?.results || []), baselineShopIds),
    'inStock=false matches baseline (out-of-stock preserved)'
  );

  const omittedStockRes = await requestSearch(base, adminCookie);
  assert(
    sameIdSet(idsOf(omittedStockRes.body?.data?.results || []), baselineIds),
    'omitted inStock matches baseline (default preserved)'
  );

  // ─── openNow ───────────────────────────────────────────────────────────────
  const openNowRes = await requestSearch({ ...base, openNow: 'true' }, adminCookie);
  assert(openNowRes.status === 200, `openNow=true 200 (got ${openNowRes.status})`);
  const openRows = openNowRes.body?.data?.results || [];
  assert(openRows.every((r) => r.shop?.isOpen === true), 'openNow=true returns only shops with isOpen: true');
  assert(
    !shopIdsOf(openRows).includes(fixtureShopId),
    'openNow=true excludes the closed isolated shop'
  );

  const openNowFalseRes = await requestSearch({ ...base, openNow: 'false' }, adminCookie);
  assert(openNowFalseRes.status === 200, `openNow=false 200 (got ${openNowFalseRes.status})`);
  assert(
    sameIdSet(shopIdsOf(openNowFalseRes.body?.data?.results || []), baselineShopIds),
    'openNow=false matches baseline (closed shops preserved)'
  );

  const omittedOpenRes = await requestSearch(base, adminCookie);
  assert(
    sameIdSet(idsOf(omittedOpenRes.body?.data?.results || []), baselineIds),
    'omitted openNow matches baseline (default preserved)'
  );

  // ─── combined filters ──────────────────────────────────────────────────────
  const combinedRes = await requestSearch(
    { ...base, brand, category, inStock: 'true' },
    adminCookie
  );
  assert(combinedRes.status === 200, `combined filters 200 (got ${combinedRes.status})`);
  const combinedRows = combinedRes.body?.data?.results || [];
  assert(
    combinedRows.every(
      (r) =>
        r.availableQuantity > 0 &&
        r.product.category === category &&
        String(r.product.brand || '').toLowerCase().includes(brand.toLowerCase())
    ),
    'combined brand + category + inStock filters all applied'
  );
}

async function main() {
  console.log('\n=== FindLocal Phase 6 Search Filter Tests ===');

  try {
    await startIsolatedServer();

    if (mongoose.connection.readyState === 0) {
      if (!process.env.MONGO_URI) {
        throw new Error('MONGO_URI missing; cannot discover fixtures or clean up.');
      }
      await mongoose.connect(process.env.MONGO_URI);
      dbConnected = true;
    }

    await loginAsAdmin();

    const fixture = await findBaselineFixture();

    if (fixture) {
      console.log(
        `\n-- Baseline Fixture --\n  shop=${fixture.shop._id} product=${fixture.product._id} q='${fixture.q}'`
      );
      await setupIsolatedFixture(fixture);
    } else {
      console.log('\n-- Baseline Fixture --\n  (none found)');
    }

    await testValidation(fixture);
    await testBehaviour(fixture);
  } catch (err) {
    console.error('\nUnexpected test error:', err.message);
    failed++;
    failures.push(`unexpected: ${err.message}`);
  } finally {
    if (dbConnected && (created.userId || created.shopId || created.inventoryId)) {
      await cleanupIsolatedFixture();
    }
    // Terminate the dedicated test server and drop ONLY the isolated database.
    await stopIsolatedServer();
  }

  console.log('\n========================================');
  console.log(
    `Results: ${passed} passed, ${failed} failed, ${skipped} skipped, ${passed + failed + skipped} total`
  );
  if (failures.length) {
    console.log('Failures:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  console.log('========================================');

  process.exitCode = failed > 0 ? 1 : 0;
}

main();
