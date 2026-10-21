
/**
 * ph4test.js — FindLocal Phase 4 Inventory Smoke Test
 *
 * Prerequisites:
 *   - Backend running at localhost:5000
 *   - MongoDB configured in server/.env
 *   - seller_ph2@x.com / TestPass123! with a verified shop
 *   - Target product exists and has ACTIVE status
 *
 * Usage (from server folder):
 *   node ph4test.js
 *
 * WARNING:
 *   This test creates and modifies one inventory entry.
 *   It refuses to proceed if that shop already lists the target product.
 *   Cleanup deletes only the captured test inventory ID + shop ID.
 */

const http = require('http');
const mongoose = require('mongoose');
const path = require('path');

const BASE_URL = 'http://localhost:5000';
const SELLER_EMAIL = 'seller_ph2@x.com';
const SELLER_PASSWORD = 'TestPass123!';
const TARGET_PRODUCT_ID = '6accd904013f7da15e7f50c2';

let COOKIE = '';
let PRODUCT_ID = '';
let INVENTORY_ID = '';
let SELLER_SHOP_ID = '';
let createReturned201 = false;

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.error(`  FAIL: ${label}`);
    failed++;
  }
}

function request(method, requestPath, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(requestPath, BASE_URL);

    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
      },
    };

    if (COOKIE) {
      options.headers.Cookie = COOKIE;
    }

    const req = http.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        const setCookie = res.headers['set-cookie'];

        if (setCookie) {
          COOKIE = setCookie[0].split(';')[0];
        }

        let parsed;

        try {
          parsed = JSON.parse(data);
        } catch {
          parsed = data;
        }

        resolve({
          status: res.statusCode,
          body: parsed,
          headers: res.headers,
        });
      });
    });

    req.on('error', reject);

    if (body !== null) {
      req.write(JSON.stringify(body));
    }

    req.end();
  });
}

async function loginAsSeller() {
  console.log('\n-- Login as Seller --');

  const res = await request('POST', '/api/v1/auth/login', {
    email: SELLER_EMAIL,
    password: SELLER_PASSWORD,
  });

  assert(res.status === 200, `Login status 200 (got ${res.status})`);
  assert(res.body?.success === true, 'Login success');

  if (res.status !== 200 || res.body?.success !== true || !COOKIE) {
    throw new Error('Seller login failed; stopping test.');
  }
}

async function fetchSellerShopId() {
  console.log('\n-- Fetch Seller Shop ID --');

  const res = await request('GET', '/api/v1/seller/shops/me');

  assert(res.status === 200, `Shop fetch status 200 (got ${res.status})`);

  const shop = res.body?.data?.shop;

  if (res.status !== 200 || !shop?._id) {
    throw new Error('Could not retrieve seller shop ID; stopping safely.');
  }

  SELLER_SHOP_ID = String(shop._id);

  assert(true, `Seller shop ID captured: ${SELLER_SHOP_ID}`);
}

async function findActiveProduct() {
  console.log('\n-- Find Active Product --');

  let page = 1;
  let target = null;
  let totalPages = 1;

  while (page <= totalPages) {
    const res = await request(
      'GET',
      `/api/v1/products?limit=50&page=${page}`
    );

    assert(
      res.status === 200,
      `Product list page ${page} status 200 (got ${res.status})`
    );

    if (
      res.status !== 200 ||
      res.body?.success !== true ||
      !Array.isArray(res.body?.data?.products)
    ) {
      throw new Error(`Could not safely inspect products page ${page}.`);
    }

    totalPages = Number.isInteger(res.body.pages)
      ? res.body.pages
      : 1;

    target = res.body.data.products.find(
      (product) => String(product._id) === TARGET_PRODUCT_ID
    );

    if (target) {
      break;
    }

    page++;
  }

  if (!target) {
    throw new Error(
      `Target product ${TARGET_PRODUCT_ID} not found in product list.`
    );
  }

  if (target.status && target.status !== 'ACTIVE') {
    throw new Error('Target product is not ACTIVE; stopping safely.');
  }

  PRODUCT_ID = String(target._id);

  assert(true, `Target product found: ${PRODUCT_ID}`);
}

async function checkExistingInventory() {
  console.log('\n-- Pre-flight: Check Existing Inventory --');

  const allEntries = [];
  const firstRes = await request(
    'GET',
    '/api/v1/inventory?limit=50&page=1'
  );

  if (
    firstRes.status !== 200 ||
    firstRes.body?.success !== true ||
    !Array.isArray(firstRes.body?.data?.inventory) ||
    !Number.isInteger(firstRes.body?.pages) ||
    firstRes.body.pages < 0
  ) {
    throw new Error(
      `Inventory pre-flight failed on page 1 (status ${firstRes.status}); aborting.`
    );
  }

  allEntries.push(...firstRes.body.data.inventory);

  const totalPages = firstRes.body.pages;

  for (let page = 2; page <= totalPages; page++) {
    const res = await request(
      'GET',
      `/api/v1/inventory?limit=50&page=${page}`
    );

    if (
      res.status !== 200 ||
      res.body?.success !== true ||
      !Array.isArray(res.body?.data?.inventory)
    ) {
      throw new Error(
        `Inventory pre-flight failed on page ${page} (status ${res.status}); aborting.`
      );
    }

    allEntries.push(...res.body.data.inventory);
  }

  const existing = allEntries.find((entry) => {
    const productId = entry.product?._id || entry.product;
    return String(productId) === PRODUCT_ID;
  });

  if (existing) {
    console.error(`Existing inventory ID: ${existing._id}`);

    throw new Error(
      'Target product already exists in this shop inventory; no test mutations performed.'
    );
  }

  assert(true, 'No existing inventory found for target product.');
}

async function testValidationErrors() {
  console.log('\n-- Validation Errors --');

  const cases = [
    {
      label: 'Missing product returns 400',
      body: { pricePaise: 100 },
    },
    {
      label: 'Decimal pricePaise returns 400',
      body: {
        product: '000000000000000000000000',
        pricePaise: 99.5,
      },
    },
    {
      label: 'Forbidden shop field returns 400',
      body: {
        product: '000000000000000000000000',
        pricePaise: 100,
        shop: '000000000000000000000000',
      },
    },
    {
      label: 'Unknown field returns 400',
      body: {
        product: '000000000000000000000000',
        pricePaise: 100,
        foo: 'bar',
      },
    },
  ];

  for (const testCase of cases) {
    const res = await request(
      'POST',
      '/api/v1/inventory',
      testCase.body
    );

    assert(
      res.status === 400,
      `${testCase.label} (got ${res.status})`
    );
  }
}

async function testCreateInventory() {
  console.log('\n-- Create Inventory --');

  const res = await request('POST', '/api/v1/inventory', {
    product: PRODUCT_ID,
    pricePaise: 9999,
    quantity: 50,
  });

  if (res.status === 201) {
    createReturned201 = true;

    const entry = res.body?.data?.inventory;

    if (entry?._id) {
      INVENTORY_ID = String(entry._id);
    }
  }

  assert(res.status === 201, `Create status 201 (got ${res.status})`);
  assert(res.body?.success === true, 'Create success');

  if (createReturned201 && !INVENTORY_ID) {
    throw new Error(
      'Create returned 201 but no inventory ID was captured. Manual cleanup may be required.'
    );
  }

  if (res.status !== 201 || !INVENTORY_ID) {
    throw new Error('Inventory creation failed; stopping remaining tests.');
  }

  const entry = res.body.data.inventory;

  assert(entry.pricePaise === 9999, 'pricePaise = 9999');
  assert(entry.quantity === 50, 'quantity = 50');
  assert(entry.reservedQuantity === 0, 'reservedQuantity = 0');
  assert(entry.availableQuantity === 50, 'availableQuantity = 50');
  assert(entry.isActive === true, 'isActive = true');
  assert(Boolean(entry.product?.name), 'Product populated with name');
  assert(Boolean(entry.product?.slug), 'Product populated with slug');

  console.log('\n-- Duplicate Inventory --');

  const duplicate = await request('POST', '/api/v1/inventory', {
    product: PRODUCT_ID,
    pricePaise: 5000,
    quantity: 10,
  });

  assert(
    duplicate.status === 409,
    `Duplicate returns 409 (got ${duplicate.status})`
  );
}

async function testListInventory() {
  console.log('\n-- List Inventory --');

  const res = await request('GET', '/api/v1/inventory');

  assert(res.status === 200, `List status 200 (got ${res.status})`);
  assert(res.body?.success === true, 'List success');
  assert(typeof res.body?.total === 'number', 'Has total');
  assert(typeof res.body?.page === 'number', 'Has page');
  assert(typeof res.body?.pages === 'number', 'Has pages');
  assert(Array.isArray(res.body?.data?.inventory), 'Inventory is an array');

  const pageRes = await request(
    'GET',
    '/api/v1/inventory?page=1&limit=1'
  );

  assert(
    pageRes.status === 200,
    `Pagination status 200 (got ${pageRes.status})`
  );

  if (pageRes.status === 200) {
    assert(
      Array.isArray(pageRes.body?.data?.inventory) &&
        pageRes.body.data.inventory.length <= 1,
      'Limit=1 respected'
    );
  }
}

async function testGetById() {
  console.log('\n-- Get Inventory By ID --');

  const res = await request(
    'GET',
    `/api/v1/inventory/${INVENTORY_ID}`
  );

  assert(res.status === 200, `Get by ID status 200 (got ${res.status})`);
  assert(
    String(res.body?.data?.inventory?._id) === INVENTORY_ID,
    'Correct entry returned'
  );
  assert(
    res.body?.data?.inventory?.availableQuantity !== undefined,
    'Has availableQuantity'
  );

  const missing = await request(
    'GET',
    `/api/v1/inventory/${'a'.repeat(24)}`
  );

  assert(missing.status === 404, `Non-existent ID returns 404 (got ${missing.status})`);

  const invalid = await request('GET', '/api/v1/inventory/bad-id');

  assert(invalid.status === 400, `Invalid ID returns 400 (got ${invalid.status})`);
}

async function testUpdateInventory() {
  console.log('\n-- Update Inventory --');

  const priceRes = await request(
    'PATCH',
    `/api/v1/inventory/${INVENTORY_ID}`,
    { pricePaise: 12500 }
  );

  assert(priceRes.status === 200, `Price update status 200 (got ${priceRes.status})`);

  if (priceRes.status === 200) {
    assert(
      priceRes.body?.data?.inventory?.pricePaise === 12500,
      'Price updated to 12500'
    );
  }

  const deactivate = await request(
    'PATCH',
    `/api/v1/inventory/${INVENTORY_ID}`,
    { isActive: false }
  );

  assert(
    deactivate.status === 200,
    `Deactivate status 200 (got ${deactivate.status})`
  );

  if (deactivate.status === 200) {
    assert(
      deactivate.body?.data?.inventory?.isActive === false,
      'isActive set to false'
    );
  }

  const reactivate = await request(
    'PATCH',
    `/api/v1/inventory/${INVENTORY_ID}`,
    { isActive: true }
  );

  assert(
    reactivate.status === 200,
    `Reactivate status 200 (got ${reactivate.status})`
  );

  const empty = await request(
    'PATCH',
    `/api/v1/inventory/${INVENTORY_ID}`,
    {}
  );

  assert(empty.status === 400, `Empty update returns 400 (got ${empty.status})`);

  const forbidden = await request(
    'PATCH',
    `/api/v1/inventory/${INVENTORY_ID}`,
    { quantity: 999 }
  );

  assert(
    forbidden.status === 400,
    `Quantity on update route returns 400 (got ${forbidden.status})`
  );
}

async function testStockUpdate() {
  console.log('\n-- Stock Updates --');

  const setRes = await request(
    'PATCH',
    `/api/v1/inventory/${INVENTORY_ID}/stock`,
    { quantity: 100 }
  );

  assert(setRes.status === 200, `Set quantity status 200 (got ${setRes.status})`);

  if (setRes.status === 200) {
    assert(
      setRes.body?.data?.inventory?.quantity === 100,
      'Quantity set to 100'
    );
  }

  const minusRes = await request(
    'PATCH',
    `/api/v1/inventory/${INVENTORY_ID}/stock`,
    { adjust: -20 }
  );

  assert(minusRes.status === 200, `Adjust -20 status 200 (got ${minusRes.status})`);

  if (minusRes.status === 200) {
    assert(
      minusRes.body?.data?.inventory?.quantity === 80,
      'Quantity is now 80'
    );
  }

  const plusRes = await request(
    'PATCH',
    `/api/v1/inventory/${INVENTORY_ID}/stock`,
    { adjust: 10 }
  );

  assert(plusRes.status === 200, `Adjust +10 status 200 (got ${plusRes.status})`);

  if (plusRes.status === 200) {
    assert(
      plusRes.body?.data?.inventory?.quantity === 90,
      'Quantity is now 90'
    );
  }

  const both = await request(
    'PATCH',
    `/api/v1/inventory/${INVENTORY_ID}/stock`,
    { quantity: 50, adjust: 10 }
  );

  assert(both.status === 400, `Both fields return 400 (got ${both.status})`);

  const neither = await request(
    'PATCH',
    `/api/v1/inventory/${INVENTORY_ID}/stock`,
    {}
  );

  assert(neither.status === 400, `Neither field returns 400 (got ${neither.status})`);

  const negative = await request(
    'PATCH',
    `/api/v1/inventory/${INVENTORY_ID}/stock`,
    { adjust: -999 }
  );

  assert(negative.status === 409, `Negative result returns 409 (got ${negative.status})`);

  const tooLarge = await request(
    'PATCH',
    `/api/v1/inventory/${INVENTORY_ID}/stock`,
    { quantity: 1000001 }
  );

  assert(tooLarge.status === 400, `Exceed max returns 400 (got ${tooLarge.status})`);
}

async function testUnauthenticated() {
  console.log('\n-- Unauthenticated Access --');

  const savedCookie = COOKIE;
  COOKIE = '';

  try {
    const res = await request('GET', '/api/v1/inventory');

    assert(res.status === 401, `No cookie returns 401 (got ${res.status})`);
  } finally {
    COOKIE = savedCookie;
  }
}

async function cleanupTestInventory() {
  console.log('\n-- Cleanup: Removing Test Inventory --');

  if (!INVENTORY_ID) {
    if (createReturned201) {
      console.error(
        'Cannot clean up: creation returned 201 but no inventory ID was captured.'
      );
      return false;
    }

    console.log('No test inventory was created; nothing to delete.');
    return true;
  }

  if (!SELLER_SHOP_ID) {
    console.error('Shop ID unknown; refusing unscoped deletion.');
    return false;
  }

  let connected = false;

  try {
    require('dotenv').config({
      path: path.join(__dirname, '.env'),
    });

    const mongoUri = process.env.MONGO_URI;

    if (!mongoUri) {
      console.error('MONGO_URI is missing; cannot clean up.');
      return false;
    }

    await mongoose.connect(mongoUri);
    connected = true;

    const Inventory = require('./src/models/Inventory.model');

    const result = await Inventory.deleteOne({
      _id: INVENTORY_ID,
      shop: SELLER_SHOP_ID,
    });

    if (result.deletedCount === 1) {
      console.log(`Deleted test inventory ${INVENTORY_ID}`);
      return true;
    }

    console.error(
      `Cleanup could not confirm deletion. deletedCount=${result.deletedCount}`
    );

    return false;
  } catch (err) {
    console.error('Cleanup error:', err.message);
    return false;
  } finally {
    if (connected) {
      try {
        await mongoose.disconnect();
      } catch (err) {
        console.error('MongoDB disconnect error:', err.message);
      }
    }
  }
}

async function main() {
  console.log('\n=== FindLocal Phase 4 Inventory Tests ===');

  try {
    await loginAsSeller();
    await fetchSellerShopId();
    await findActiveProduct();
    await checkExistingInventory();

    // No inventory creation happens before the pre-flight checks pass.
    await testValidationErrors();
    await testCreateInventory();
    await testListInventory();
    await testGetById();
    await testUpdateInventory();
    await testStockUpdate();
    await testUnauthenticated();
  } catch (err) {
    console.error('\nUnexpected test error:', err.message);
    failed++;
  } finally {
    const cleanupOk = await cleanupTestInventory();

    if (!cleanupOk) {
      console.error('Cleanup failed; test data may remain.');
      failed++;
    }
  }

  console.log('\n========================================');
  console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log('========================================');

  process.exitCode = failed > 0 ? 1 : 0;
}

main();
