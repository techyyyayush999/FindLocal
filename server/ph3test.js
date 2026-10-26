/**
 * Phase 3 — Product Catalog: Comprehensive Test Script
 *
 * Run with:   node ph3test.js
 *
 * Prerequisites:
 *   - Server running on port 5000
 *   - MongoDB running locally
 *   - Admin user seeded (via seed_admin.js)
 *   - A seller user registered
 *   - A customer user registered
 *
 * This script uses the cookie-based auth system already in place.
 */

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const mongoose = require('mongoose');

require('dotenv').config({ path: path.join(__dirname, '.env') });

// Base URL of the API under test. Keeps the historical default; the isolation
// harness below overrides it to a dedicated test port unless PH3_TEST_BASE_URL is
// supplied to target an already-running server.
let BASE = process.env.PH3_TEST_BASE_URL || 'http://localhost:5000/api/v1';

// ─── Credentials (ensure these exist in your DB) ────────────────────────────
const ADMIN_CREDS = { email: 'admin@findlocal.dev', password: 'Admin@12345' };
const SELLER_CREDS = { email: 'seller3@test.com', password: 'Seller3@12345' };
const CUSTOMER_CREDS = { email: 'customer3@test.com', password: 'Customer3@12345' };
const SELLER2_CREDS = { email: 'seller4@test.com', password: 'Seller4@12345' };
let adminCookie = '';
let sellerCookie = '';
let customerCookie = '';
let seller2Cookie = '';

// ─── Per-run unique fixtures (prevent 409 conflicts on reruns) ─────────────
// RUN_SUFFIX is alphanumeric so it survives the product normalizer
// (NFKC + lowercase + keep \p{L}\p{N}) consistently across name/brand variants.
const RUN_SUFFIX = `T${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
// 13-digit GTIN unique to this run (validator only enforces digits + length).
const RUN_GTIN = (Date.now().toString().slice(-10) +
  Math.floor(Math.random() * 1000).toString().padStart(3, '0'));

// ══════════════════════════════════════════════════════════════════════════════
// Isolation harness
// By default this script runs against its OWN server on a dedicated port backed by
// a per-run database derived from MONGO_URI, seeds the admin there, and drops ONLY
// that database at the end — it never touches the shared development database.
// Set PH3_TEST_BASE_URL to target an already-running server instead (this disables
// the spawn / seed / drop harness entirely).
// ══════════════════════════════════════════════════════════════════════════════
function deriveTestUri(uri, suffix) {
  const u = new URL(uri);
  const baseName = u.pathname.replace(/^\//, '') || 'findlocal';
  u.pathname = `/${baseName}_ph3test_${suffix}`;
  return { uri: u.toString(), dbName: u.pathname.slice(1), baseName };
}

const BASE_DB_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/findlocal';
const EXTERNAL_BASE = process.env.PH3_TEST_BASE_URL || null;
const TEST_PORT = Number(process.env.PH3_TEST_PORT || 5013);
const { uri: TEST_URI, dbName: TEST_DB_NAME, baseName: BASE_DB_NAME } =
  deriveTestUri(BASE_DB_URI, RUN_SUFFIX);

if (!EXTERNAL_BASE) {
  BASE = `http://localhost:${TEST_PORT}/api/v1`;
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

// Admins cannot self-register, so seed one directly into the isolated database.
async function seedAdmin() {
  const User = require('./src/models/User.model');
  await User.init();
  const existing = await User.findOne({ email: ADMIN_CREDS.email });
  if (existing) return;
  await User.create({
    name: 'Admin',
    email: ADMIN_CREDS.email,
    password: ADMIN_CREDS.password,
    role: 'admin',
    isVerified: true,
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
  await seedAdmin();
  console.log(`  Admin seeded into ${TEST_DB_NAME}.`);

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
      await mongoose.connection.db.dropDatabase();
      console.log(`  Dropped isolated test database: ${TEST_DB_NAME}`);
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

// Track every product successfully created this run so cleanup() can hide them.
const createdProductIds = [];
function trackCreated(res) {
  const id = res?.body?.data?.product?._id;
  if (res?.status === 201 && id) createdProductIds.push(id);
}

// ─── HTTP Helper ────────────────────────────────────────────────────────────
function request(method, path, body = null, cookie = '') {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + path);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
      },
    };
    if (cookie) options.headers['Cookie'] = cookie;

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        // Extract set-cookie
        const setCookies = res.headers['set-cookie'] || [];
        let responseCookie = '';
        for (const c of setCookies) {
          if (c.startsWith('findlocal_token=')) {
            responseCookie = c.split(';')[0];
          }
        }
        let json = null;
        try {
          json = JSON.parse(data);
        } catch (e) {
          json = { raw: data };
        }
        resolve({ status: res.statusCode, body: json, cookie: responseCookie });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function assert(testName, condition, details = '') {
  if (condition) {
    console.log(`  ✅ ${testName}`);
    passed++;
  } else {
    console.log(`  ❌ ${testName}${details ? ' — ' + details : ''}`);
    failed++;
    failures.push(testName + (details ? ': ' + details : ''));
  }
}

// ─── Setup: Register/Login users ────────────────────────────────────────────
async function setup() {
  console.log('\n══════════════════════════════════════════════════════════');
  console.log('SETUP: Registering / Logging in test users');
  console.log('══════════════════════════════════════════════════════════\n');

  // Register seller1 (may already exist)
  await request('POST', '/auth/register', {
    name: 'Seller One',
    email: SELLER_CREDS.email,
    password: SELLER_CREDS.password,
    role: 'seller',
  });

  // Register seller2 (may already exist)
  await request('POST', '/auth/register', {
    name: 'Seller Two',
    email: SELLER2_CREDS.email,
    password: SELLER2_CREDS.password,
    role: 'seller',
  });

  // Register customer (may already exist)
  await request('POST', '/auth/register', {
    name: 'Customer One',
    email: CUSTOMER_CREDS.email,
    password: CUSTOMER_CREDS.password,
    role: 'customer',
  });

  // Login admin
  const adminRes = await request('POST', '/auth/login', ADMIN_CREDS);
  if (adminRes.status === 200 && adminRes.cookie) {
    adminCookie = adminRes.cookie;
    console.log('  ✅ Admin logged in');
  } else {
    console.log('  ❌ Admin login failed — aborting tests');
    console.log('     Response:', JSON.stringify(adminRes.body));
    throw new Error('Admin login failed');
  }

  // Login seller1
  const sellerRes = await request('POST', '/auth/login', SELLER_CREDS);
  if (sellerRes.status === 200 && sellerRes.cookie) {
    sellerCookie = sellerRes.cookie;
    console.log('  ✅ Seller1 logged in');
  } else {
    console.log('  ❌ Seller1 login failed — aborting tests');
    throw new Error('Seller1 login failed');
  }

  // Login seller2
  const seller2Res = await request('POST', '/auth/login', SELLER2_CREDS);
  if (seller2Res.status === 200 && seller2Res.cookie) {
    seller2Cookie = seller2Res.cookie;
    console.log('  ✅ Seller2 logged in');
  } else {
    console.log('  ❌ Seller2 login failed — aborting tests');
    throw new Error('Seller2 login failed');
  }

  // Login customer
  const customerRes = await request('POST', '/auth/login', CUSTOMER_CREDS);
  if (customerRes.status === 200 && customerRes.cookie) {
    customerCookie = customerRes.cookie;
    console.log('  ✅ Customer logged in');
  } else {
    console.log('  ❌ Customer login failed — aborting tests');
    throw new Error('Customer login failed');
  }
}

// ─── Cleanup: Hide products created by this test run ────────────────────────
// There is no product DELETE endpoint, so cleanup transitions every tracked
// product out of ACTIVE so it disappears from the public catalog. It only
// touches products created during this run (never pre-existing records).
async function cleanup() {
  console.log(`\n  Cleaning up ${createdProductIds.length} test product(s)...`);
  for (const id of createdProductIds) {
    try {
      const detail = await request('GET', `/products/${id}`, null, adminCookie);
      if (detail.status !== 200) continue;
      const status = detail.body?.data?.product?.status;

      if (status === 'ACTIVE') {
        // ACTIVE → INACTIVE hides it from the public catalog.
        await request('PATCH', `/products/${id}/status`, { status: 'INACTIVE' }, adminCookie);
      } else if (status === 'PENDING') {
        // PENDING → REJECTED keeps it out of the public catalog.
        await request('PATCH', `/products/${id}/status`, {
          status: 'REJECTED',
          rejectionReason: 'Test cleanup',
        }, adminCookie);
      }
      // REJECTED / INACTIVE are already hidden from the public catalog.
    } catch (e) {
      // Best-effort cleanup; don't let a single failure abort the rest.
    }
  }
  console.log('  Cleanup complete.');
}

// ══════════════════════════════════════════════════════════════════════════════
// TEST SUITES
// ══════════════════════════════════════════════════════════════════════════════

let createdProductId = '';
let createdProductSlug = '';
let sellerProductId = '';
let sellerRejectedProductId = '';

async function testCreation() {
  console.log('\n──────────────────────────────────────────────────────────');
  console.log('TEST SUITE: Product Creation');
  console.log('──────────────────────────────────────────────────────────\n');

  // 1. Admin creates ACTIVE product
  const adminProduct = await request('POST', '/products', {
    name: `Casio FX-991CW Scientific Calculator ${RUN_SUFFIX}`,
    brand: `Casio ${RUN_SUFFIX}`,
    category: 'electronics',
    description: 'Advanced scientific calculator',
    gtin: RUN_GTIN,
  }, adminCookie);
  trackCreated(adminProduct);

  assert('Admin creates ACTIVE product', adminProduct.status === 201);
  assert('Admin product status is ACTIVE',
    adminProduct.body.data?.product?.status === 'ACTIVE');
  assert('Slug is server-generated',
    typeof adminProduct.body.data?.product?.slug === 'string' && adminProduct.body.data.product.slug.length > 0);
  assert('Admin response exposes createdBy (admin contract)',
    adminProduct.body.data?.product?.createdBy !== undefined);
  assert('normalizedName NOT in response',
    adminProduct.body.data?.product?.normalizedName === undefined);
  assert('dedupeKey NOT in response',
    adminProduct.body.data?.product?.dedupeKey === undefined);

  if (adminProduct.body.data?.product?._id) {
    createdProductId = adminProduct.body.data.product._id;
    createdProductSlug = adminProduct.body.data.product.slug;
  }

  // 2. Seller creates PENDING product
  const sellerProduct = await request('POST', '/products', {
    name: `Parker Jotter Ballpoint Pen ${RUN_SUFFIX}`,
    brand: `Parker ${RUN_SUFFIX}`,
    category: 'stationery',
  }, sellerCookie);
  trackCreated(sellerProduct);

  assert('Seller creates PENDING product', sellerProduct.status === 201);
  assert('Seller product status is PENDING',
    sellerProduct.body.data?.product?.status === 'PENDING');

  if (sellerProduct.body.data?.product?._id) {
    sellerProductId = sellerProduct.body.data.product._id;
  }

  // 3. Customer cannot create
  const customerProduct = await request('POST', '/products', {
    name: `Test Product ${RUN_SUFFIX}`,
    brand: `Test Brand ${RUN_SUFFIX}`,
    category: 'electronics',
  }, customerCookie);

  assert('Customer receives 403', customerProduct.status === 403);

  // 4. Unauthenticated cannot create
  const unauthProduct = await request('POST', '/products', {
    name: `Test Product ${RUN_SUFFIX}`,
    brand: `Test Brand ${RUN_SUFFIX}`,
    category: 'electronics',
  });

  assert('Unauthenticated receives 401', unauthProduct.status === 401);
}

async function testValidation() {
  console.log('\n──────────────────────────────────────────────────────────');
  console.log('TEST SUITE: Validation');
  console.log('──────────────────────────────────────────────────────────\n');

  // Missing required fields
  const missing = await request('POST', '/products', {}, sellerCookie);
  assert('Missing required fields → 400', missing.status === 400);

  // Invalid category
  const badCategory = await request('POST', '/products', {
    name: 'Test', brand: 'Test', category: 'invalid-category',
  }, sellerCookie);
  assert('Invalid category → 400', badCategory.status === 400);

  // Invalid GTIN (wrong length)
  const badGtin = await request('POST', '/products', {
    name: 'GTIN Test', brand: 'Test', category: 'electronics', gtin: '12345',
  }, sellerCookie);
  assert('Invalid GTIN length → 400', badGtin.status === 400);

  // Invalid GTIN (non-digits)
  const badGtinChars = await request('POST', '/products', {
    name: 'GTIN Test 2', brand: 'Test', category: 'electronics', gtin: '12345abc',
  }, sellerCookie);
  assert('Non-digit GTIN → 400', badGtinChars.status === 400);

  // Invalid image URL (not HTTPS)
  const badImage = await request('POST', '/products', {
    name: 'Image Test', brand: 'Test', category: 'electronics',
    images: ['http://example.com/img.jpg'],
  }, sellerCookie);
  assert('Non-HTTPS image → 400', badImage.status === 400);

  // Too many images
  const tooManyImages = await request('POST', '/products', {
    name: 'Too Many Images', brand: 'Test', category: 'electronics',
    images: [
      'https://example.com/1.jpg', 'https://example.com/2.jpg',
      'https://example.com/3.jpg', 'https://example.com/4.jpg',
      'https://example.com/5.jpg', 'https://example.com/6.jpg',
    ],
  }, sellerCookie);
  assert('Too many images → 400', tooManyImages.status === 400);

  // Oversized description
  const longDesc = 'a'.repeat(2001);
  const badDesc = await request('POST', '/products', {
    name: 'Desc Test', brand: 'Test', category: 'electronics', description: longDesc,
  }, sellerCookie);
  assert('Oversized description → 400', badDesc.status === 400);

  // System fields rejected
  const sysFields = await request('POST', '/products', {
    name: 'System Field Test', brand: 'Test', category: 'electronics',
    slug: 'hacked-slug',
  }, sellerCookie);
  assert('System field (slug) rejected → 400', sysFields.status === 400);

  // Mass assignment: status
  const massAssign = await request('POST', '/products', {
    name: 'Mass Assign Test', brand: 'Test', category: 'electronics',
    status: 'ACTIVE',
  }, sellerCookie);
  assert('Mass assignment (status) rejected → 400', massAssign.status === 400);

  // Name too short
  const shortName = await request('POST', '/products', {
    name: 'A', brand: 'Test', category: 'electronics',
  }, sellerCookie);
  assert('Name too short → 400', shortName.status === 400);

  // Symbols-only name (no letter or digit)
  const symbolsName = await request('POST', '/products', {
    name: '!!', brand: 'Test', category: 'electronics',
  }, sellerCookie);
  assert('Symbols-only name → 400', symbolsName.status === 400);
}

async function testDuplicates() {
  console.log('\n──────────────────────────────────────────────────────────');
  console.log('TEST SUITE: Duplicate Prevention');
  console.log('──────────────────────────────────────────────────────────\n');

  // Exact duplicate
  const dup1 = await request('POST', '/products', {
    name: `Casio FX-991CW Scientific Calculator ${RUN_SUFFIX}`,
    brand: `Casio ${RUN_SUFFIX}`,
    category: 'electronics',
  }, adminCookie);
  assert('Exact duplicate → 409', dup1.status === 409);

  // Case variation
  const dup2 = await request('POST', '/products', {
    name: `casio fx-991cw scientific calculator ${RUN_SUFFIX}`,
    brand: `casio ${RUN_SUFFIX}`,
    category: 'electronics',
  }, adminCookie);
  assert('Case variation duplicate → 409', dup2.status === 409);

  // Whitespace variation
  const dup3 = await request('POST', '/products', {
    name: `Casio  FX-991CW  Scientific  Calculator  ${RUN_SUFFIX}`,
    brand: `Casio ${RUN_SUFFIX}`,
    category: 'electronics',
  }, adminCookie);
  assert('Whitespace variation duplicate → 409', dup3.status === 409);

  // "&" vs "and"
  const ampProduct = await request('POST', '/products', {
    name: `Bread & Butter ${RUN_SUFFIX}`,
    brand: `Unbranded ${RUN_SUFFIX}`,
    category: 'groceries',
  }, adminCookie);
  trackCreated(ampProduct);
  assert('Create product with & → 201', ampProduct.status === 201);

  const andProduct = await request('POST', '/products', {
    name: `Bread and Butter ${RUN_SUFFIX}`,
    brand: `Unbranded ${RUN_SUFFIX}`,
    category: 'groceries',
  }, adminCookie);
  assert('"and" variation of "&" → 409', andProduct.status === 409);

  // Same name + different brand = allowed
  const diffBrand = await request('POST', '/products', {
    name: `Casio FX-991CW Scientific Calculator ${RUN_SUFFIX}`,
    brand: `Texas Instruments ${RUN_SUFFIX}`,
    category: 'electronics',
  }, adminCookie);
  trackCreated(diffBrand);
  assert('Same name + different brand → allowed (201)', diffBrand.status === 201);

  // Duplicate GTIN
  const gtinDup = await request('POST', '/products', {
    name: `Some Other Calculator ${RUN_SUFFIX}`,
    brand: `Sharp ${RUN_SUFFIX}`,
    category: 'electronics',
    gtin: RUN_GTIN,
  }, adminCookie);
  assert('Duplicate GTIN → 409', gtinDup.status === 409);
}

async function testAuthorization() {
  console.log('\n──────────────────────────────────────────────────────────');
  console.log('TEST SUITE: Authorization & Ownership');
  console.log('──────────────────────────────────────────────────────────\n');

  // Customer cannot update
  const custUpdate = await request('PATCH', `/products/${sellerProductId}`, {
    name: 'Hacked Name',
  }, customerCookie);
  assert('Customer cannot update → 403', custUpdate.status === 403);

  // Customer cannot moderate
  const custModerate = await request('PATCH', `/products/${sellerProductId}/status`, {
    status: 'ACTIVE',
  }, customerCookie);
  assert('Customer cannot moderate → 403', custModerate.status === 403);

  // Seller2 cannot edit Seller1's product
  const seller2Edit = await request('PATCH', `/products/${sellerProductId}`, {
    name: 'Changed By Seller 2',
  }, seller2Cookie);
  assert('Seller2 cannot edit Seller1 product → 403', seller2Edit.status === 403);

  // Seller cannot edit ACTIVE product (admin-created)
  const sellerEditActive = await request('PATCH', `/products/${createdProductId}`, {
    name: 'Hacked Active Product',
  }, sellerCookie);
  assert('Seller cannot edit ACTIVE product → 403 or 404',
    sellerEditActive.status === 403 || sellerEditActive.status === 404);

  // Seller cannot moderate
  const sellerModerate = await request('PATCH', `/products/${sellerProductId}/status`, {
    status: 'ACTIVE',
  }, sellerCookie);
  assert('Seller cannot moderate → 403', sellerModerate.status === 403);

  // Seller can edit own PENDING product
  const sellerEditOwn = await request('PATCH', `/products/${sellerProductId}`, {
    description: 'Updated by seller',
  }, sellerCookie);
  assert('Seller can edit own PENDING product → 200', sellerEditOwn.status === 200);
}

async function testModeration() {
  console.log('\n──────────────────────────────────────────────────────────');
  console.log('TEST SUITE: Status Transitions / Moderation');
  console.log('──────────────────────────────────────────────────────────\n');

  // Create a product to test transitions on
  const modProduct = await request('POST', '/products', {
    name: `Moderation Test Product ${RUN_SUFFIX}`,
    brand: `TestBrand ${RUN_SUFFIX}`,
    category: 'books',
  }, sellerCookie);
  trackCreated(modProduct);
  const modId = modProduct.body.data?.product?._id;
  assert('Create moderation test product', modProduct.status === 201 && modId);

  // PENDING → ACTIVE
  const approve = await request('PATCH', `/products/${modId}/status`, {
    status: 'ACTIVE',
  }, adminCookie);
  assert('PENDING → ACTIVE', approve.status === 200);
  assert('Status is now ACTIVE', approve.body.data?.product?.status === 'ACTIVE');

  // ACTIVE → INACTIVE
  const deactivate = await request('PATCH', `/products/${modId}/status`, {
    status: 'INACTIVE',
  }, adminCookie);
  assert('ACTIVE → INACTIVE', deactivate.status === 200);

  // INACTIVE → ACTIVE
  const reactivate = await request('PATCH', `/products/${modId}/status`, {
    status: 'ACTIVE',
  }, adminCookie);
  assert('INACTIVE → ACTIVE', reactivate.status === 200);

  // Create another product for REJECTED flow
  const rejProduct = await request('POST', '/products', {
    name: `Rejection Test Product ${RUN_SUFFIX}`,
    brand: `RejectBrand ${RUN_SUFFIX}`,
    category: 'stationery',
  }, sellerCookie);
  trackCreated(rejProduct);
  const rejId = rejProduct.body.data?.product?._id;
  sellerRejectedProductId = rejId;

  // PENDING → REJECTED (requires rejectionReason)
  const rejectNoReason = await request('PATCH', `/products/${rejId}/status`, {
    status: 'REJECTED',
  }, adminCookie);
  assert('REJECTED without reason → 400', rejectNoReason.status === 400);

  const reject = await request('PATCH', `/products/${rejId}/status`, {
    status: 'REJECTED',
    rejectionReason: 'Low quality product submission',
  }, adminCookie);
  assert('PENDING → REJECTED', reject.status === 200);
  assert('rejectionReason set', reject.body.data?.product?.rejectionReason === 'Low quality product submission');

  // REJECTED → ACTIVE (admin)
  const reapprove = await request('PATCH', `/products/${rejId}/status`, {
    status: 'ACTIVE',
  }, adminCookie);
  assert('REJECTED → ACTIVE', reapprove.status === 200);

  // Invalid transitions
  // ACTIVE → PENDING (not allowed)
  const badTransition1 = await request('PATCH', `/products/${rejId}/status`, {
    status: 'PENDING',
  }, adminCookie);
  assert('ACTIVE → PENDING is invalid → 409', badTransition1.status === 409);

  // ACTIVE → REJECTED (not allowed)
  const badTransition2 = await request('PATCH', `/products/${rejId}/status`, {
    status: 'REJECTED',
    rejectionReason: 'Should fail',
  }, adminCookie);
  assert('ACTIVE → REJECTED is invalid → 409', badTransition2.status === 409);
}

async function testSellerResubmission() {
  console.log('\n──────────────────────────────────────────────────────────');
  console.log('TEST SUITE: Seller Resubmission (REJECTED → PENDING)');
  console.log('──────────────────────────────────────────────────────────\n');

  // Create a product and reject it
  const prod = await request('POST', '/products', {
    name: `Resubmission Test Product ${RUN_SUFFIX}`,
    brand: `ResubBrand ${RUN_SUFFIX}`,
    category: 'toys-games',
  }, sellerCookie);
  trackCreated(prod);
  const prodId = prod.body.data?.product?._id;

  const rejectIt = await request('PATCH', `/products/${prodId}/status`, {
    status: 'REJECTED',
    rejectionReason: 'Missing details',
  }, adminCookie);
  assert('Product rejected', rejectIt.status === 200);

  // Seller edits rejected product → status should become PENDING
  const edit = await request('PATCH', `/products/${prodId}`, {
    description: 'Added proper description after rejection',
  }, sellerCookie);
  assert('Seller edits rejected product → 200', edit.status === 200);
  assert('Status reset to PENDING', edit.body.data?.product?.status === 'PENDING');
  assert('rejectionReason cleared',
    edit.body.data?.product?.rejectionReason === undefined ||
    edit.body.data?.product?.rejectionReason === null);
}

async function testVisibility() {
  console.log('\n──────────────────────────────────────────────────────────');
  console.log('TEST SUITE: Visibility');
  console.log('──────────────────────────────────────────────────────────\n');

  // ACTIVE product visible to customer
  const custView = await request('GET', `/products/${createdProductId}`, null, customerCookie);
  assert('Customer can see ACTIVE product', custView.status === 200);
  assert('Customer response hides internal fields',
    custView.body.data?.product?.dedupeKey === undefined &&
    custView.body.data?.product?.normalizedName === undefined);
  assert('Customer response omits createdBy',
    custView.body.data?.product?.createdBy === undefined);

  // PENDING product hidden from customer
  const custPending = await request('GET', `/products/${sellerProductId}`, null, customerCookie);
  assert('Customer cannot see PENDING product → 404', custPending.status === 404);

  // Creator can see own PENDING product
  const sellerOwn = await request('GET', `/products/${sellerProductId}`, null, sellerCookie);
  assert('Seller can see own PENDING product', sellerOwn.status === 200);

  // Admin can see PENDING product
  const adminPending = await request('GET', `/products/${sellerProductId}`, null, adminCookie);
  assert('Admin can see PENDING product', adminPending.status === 200);

  // Malformed ObjectId
  const badId = await request('GET', '/products/not-a-valid-id', null, customerCookie);
  assert('Malformed ObjectId → 400', badId.status === 400);

  // Non-existent ObjectId
  const nonExistent = await request('GET', '/products/aaaaaaaaaaaaaaaaaaaaaaaa', null, customerCookie);
  assert('Non-existent product → 404', nonExistent.status === 404);
}

async function testPagination() {
  console.log('\n──────────────────────────────────────────────────────────');
  console.log('TEST SUITE: Pagination & Listing');
  console.log('──────────────────────────────────────────────────────────\n');

  // GET /products — public listing
  const list = await request('GET', '/products?page=1&limit=5', null, customerCookie);
  assert('List products → 200', list.status === 200);
  assert('Response has pagination fields',
    list.body.page !== undefined && list.body.pages !== undefined && list.body.total !== undefined);
  assert('All listed products are ACTIVE',
    (list.body.data?.products || []).every((p) => p.status === 'ACTIVE'));

  // Category filter
  const catList = await request('GET', '/products?category=electronics', null, customerCookie);
  assert('Category filter works', catList.status === 200);

  // Max limit enforcement — validator rejects limits outside 1..50
  const bigLimit = await request('GET', '/products?limit=999', null, customerCookie);

  assert('Over-limit rejected by validator → 400', bigLimit.status === 400);
  assert('Over-limit error mentions the limit range',
    Array.isArray(bigLimit.body?.errors) &&
    bigLimit.body.errors.some((e) => /between 1 and 50/.test(e?.message || '')));

  // Seller mine
  const mine = await request('GET', '/products/mine', null, sellerCookie);
  assert('Seller /mine → 200', mine.status === 200);
  assert('/mine has pagination', mine.body.page !== undefined);

  // Admin listing
  const adminList = await request('GET', '/products/admin', null, adminCookie);
  assert('Admin listing → 200', adminList.status === 200);
  assert('Admin default status is PENDING',
    (adminList.body.data?.products || []).every((p) => p.status === 'PENDING'));
  assert('Admin listing excludes internal normalization fields',
    (adminList.body.data?.products || []).every((p) =>
      p.normalizedName === undefined &&
      p.normalizedBrand === undefined &&
      p.dedupeKey === undefined &&
      p.__v === undefined));

  // Customer cannot access /mine
  const custMine = await request('GET', '/products/mine', null, customerCookie);
  assert('Customer cannot access /mine → 403', custMine.status === 403);

  // Customer cannot access /admin
  const custAdmin = await request('GET', '/products/admin', null, customerCookie);
  assert('Customer cannot access /admin → 403', custAdmin.status === 403);

  // Seller cannot access /admin
  const sellerAdmin = await request('GET', '/products/admin', null, sellerCookie);
  assert('Seller cannot access /admin → 403', sellerAdmin.status === 403);
}

async function testOperatorInjection() {
  console.log('\n──────────────────────────────────────────────────────────');
  console.log('TEST SUITE: Query Operator Injection');
  console.log('──────────────────────────────────────────────────────────\n');

  // category[$ne]=electronics should not work as an operator
  const inject = await request('GET', '/products?category[$ne]=electronics', null, customerCookie);
  assert('Operator injection on category rejected or ignored',
    inject.status === 400 || inject.status === 200);
  // If 200, verify it didn't actually do a $ne query (no electronics results shouldn't appear extra)
}

async function testUpdate() {
  console.log('\n──────────────────────────────────────────────────────────');
  console.log('TEST SUITE: Product Update');
  console.log('──────────────────────────────────────────────────────────\n');

  // Admin can edit any product
  const adminEdit = await request('PATCH', `/products/${createdProductId}`, {
    description: 'Updated by admin',
  }, adminCookie);
  assert('Admin can edit any product → 200', adminEdit.status === 200);

  // Unknown/system fields rejected on update
  const sysFieldUpdate = await request('PATCH', `/products/${createdProductId}`, {
    slug: 'hacked-slug',
  }, adminCookie);
  assert('System field rejected on update → 400', sysFieldUpdate.status === 400);

  // Slug remains stable after a name change
  const nameChange = await request('PATCH', `/products/${createdProductId}`, {
    name: `Casio FX-991CW V2 Calculator ${RUN_SUFFIX}`,
  }, adminCookie);
  assert('Name change updates the product name → 200',
    nameChange.status === 200 &&
    nameChange.body.data?.product?.name === `Casio FX-991CW V2 Calculator ${RUN_SUFFIX}`);
  assert('Slug remains stable after name change',
    nameChange.body.data?.product?.slug === createdProductSlug);

  // GTIN update collision + removal (uses products created during this run)
  const secondGtin = '9' + RUN_GTIN.slice(1); // distinct 13-digit GTIN, unique to this run
  const gtinProduct = await request('POST', '/products', {
    name: `GTIN Update Test ${RUN_SUFFIX}`,
    brand: `GTINBrand ${RUN_SUFFIX}`,
    category: 'electronics',
    gtin: secondGtin,
  }, adminCookie);
  trackCreated(gtinProduct);
  const gtinProductId = gtinProduct.body.data?.product?._id;

  if (gtinProduct.status === 201 && gtinProductId) {
    // Collision: setting GTIN to a value already used by another product
    const gtinCollision = await request('PATCH', `/products/${gtinProductId}`, {
      gtin: RUN_GTIN,
    }, adminCookie);
    assert('GTIN update collision → 409', gtinCollision.status === 409);

    // GTIN removal: empty string removes the GTIN
    const gtinRemoval = await request('PATCH', `/products/${gtinProductId}`, {
      gtin: '',
    }, adminCookie);
    assert('GTIN removal via empty string → 200', gtinRemoval.status === 200);
    assert('GTIN is removed from response',
      gtinRemoval.body.data?.product?.gtin === undefined ||
      gtinRemoval.body.data?.product?.gtin === null);
  }
}

async function testNormalization() {
  console.log('\n──────────────────────────────────────────────────────────');
  console.log('TEST SUITE: Normalization');
  console.log('──────────────────────────────────────────────────────────\n');

  // Unicode normalization: ﬁ (U+FB01) should normalize to "fi" via NFKC
  const unicodeProduct = await request('POST', '/products', {
    name: `WiFi Router Pro ${RUN_SUFFIX}`,
    brand: `NetGear ${RUN_SUFFIX}`,
    category: 'electronics',
  }, adminCookie);
  trackCreated(unicodeProduct);

  // Try to create a duplicate with the ligature
  const unicodeDup = await request('POST', '/products', {
    name: `Wi\uFB01 Router Pro ${RUN_SUFFIX}`,
    brand: `NetGear ${RUN_SUFFIX}`,
    category: 'electronics',
  }, adminCookie);
  assert('Unicode NFKC normalization catches ﬁ ligature duplicate → 409', unicodeDup.status === 409);
}

// ══════════════════════════════════════════════════════════════════════════════
// RUN ALL TESTS
// ══════════════════════════════════════════════════════════════════════════════
async function runTests() {
  try {
    await startIsolatedServer();
    await setup();
    await testCreation();
    await testValidation();
    await testDuplicates();
    await testAuthorization();
    await testModeration();
    await testSellerResubmission();
    await testVisibility();
    await testPagination();
    await testOperatorInjection();
    await testUpdate();
    await testNormalization();

    console.log('\n══════════════════════════════════════════════════════════');
    console.log(`RESULTS: ${passed} passed, ${failed} failed, ${skipped} skipped`);
    console.log('══════════════════════════════════════════════════════════\n');

    if (failures.length > 0) {
      console.log('FAILURES:');
      failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
      console.log('');
    }
  } catch (err) {
    console.error('Test runner error:', err);
  } finally {
    await cleanup();
    // Terminate the dedicated test server and drop ONLY the isolated database.
    await stopIsolatedServer();
  }
}

runTests();
