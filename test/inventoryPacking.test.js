const assert = require('node:assert/strict');
const { after, before, beforeEach, describe, it } = require('node:test');
const crypto = require('node:crypto');
const express = require('express');
const Module = require('node:module');
const path = require('node:path');
const jwt = require('jsonwebtoken');

const routesPath = path.resolve(__dirname, '../routes/inventorySoftwareRoutes.js');
const originalLoad = Module._load;
const scannerKey = 'SCANNER-TEST-KEY';
const sessionCode = 'PACKING-TEST';
const scannerHash = crypto.createHash('sha256').update(scannerKey).digest('hex');
const order = { id: 2, order_number: '134202019', status: 'pending', total_amount: 299 };
const orderItem = {
  id: 10,
  order_item_id: 10,
  order_id: 2,
  product_id: 5,
  name: 'Test formulation',
  sku: 'BV-TEST-01',
  barcode: '890000000001',
  quantity: 1,
  price: 299,
  verified_count: 0,
};

let verifiedQuantity = 0;
let currentOrderStatus = 'pending';
let savedOrderItems = [];
let deviceExpiresAt = new Date(Date.now() + 3600000);
let server;
let baseUrl;

const fakePool = {
  async query(sql, params = []) {
    if (/FROM inventory_scanner_devices WHERE api_key_hash/.test(sql)) {
      return [[{ session_code: sessionCode, device_name: 'Packing test device', expires_at: deviceExpiresAt }]];
    }
    if (/FROM inventory_scanner_devices[\s\S]*WHERE session_code/.test(sql)) return [[]];
    if (/INSERT INTO inventory_scanner_devices/.test(sql)) return [{ affectedRows: 1 }];
    if (/FROM inventory_staff_accounts WHERE username/.test(sql)) {
      return [[{ id: 1, username: 'test-admin', role: 'admin', status: 'active' }]];
    }
    if (/INSERT INTO inventory_audit_logs/.test(sql)) return [{ affectedRows: 1 }];
    if (/SELECT o\.\*/.test(sql)) {
      return [[{ ...order, status: currentOrderStatus, resolved_customer_name: 'Test customer' }]];
    }
    if (/FROM order_items oi/.test(sql)) {
      return [[{ ...orderItem, verified_count: verifiedQuantity }]];
    }
    throw new Error(`Unexpected pool query: ${sql}`);
  },
  async getConnection() {
    return {
      async beginTransaction() {},
      async commit() {},
      async rollback() {},
      release() {},
      async query(sql, params = []) {
        if (/FROM orders WHERE id = \? OR order_number = \?/.test(sql)) {
          return [[{ ...order, status: currentOrderStatus }]];
        }
        if (/SELECT oi\.id AS order_item_id/.test(sql)) {
          return [[{ order_item_id: 10, quantity: 1, verified_count: verifiedQuantity }]];
        }
        if (/FROM order_items oi/.test(sql)) {
          return [[{ ...orderItem }]];
        }
        if (/SELECT id FROM products WHERE id =/.test(sql)) return [[]];
        if (/SELECT p\.id/.test(sql)) return [[{ id: 5 }]];
        if (/DELETE FROM order_items/.test(sql)) {
          savedOrderItems = [];
          return [{ affectedRows: 1 }];
        }
        if (/DELETE FROM inventory_order_pack_progress/.test(sql)) {
          verifiedQuantity = 0;
          return [{ affectedRows: 1 }];
        }
        if (/INSERT INTO order_items/.test(sql)) {
          savedOrderItems.push({ orderId: params[0], productId: params[1], name: params[2], price: params[3], quantity: params[4] });
          return [{ affectedRows: 1 }];
        }
        if (/UPDATE orders SET total_amount/.test(sql)) return [{ affectedRows: 1 }];
        if (/INSERT IGNORE INTO inventory_order_pack_progress/.test(sql)) return [{ affectedRows: 1 }];
        if (/SELECT verified_quantity FROM inventory_order_pack_progress/.test(sql)) {
          return [[{ verified_quantity: verifiedQuantity }]];
        }
        if (/UPDATE inventory_order_pack_progress SET verified_quantity/.test(sql)) {
          verifiedQuantity = Number(params[0]);
          return [{ affectedRows: 1 }];
        }
        if (/UPDATE orders SET status/.test(sql)) {
          currentOrderStatus = params[0];
          return [{ affectedRows: 1 }];
        }
        throw new Error(`Unexpected connection query: ${sql}`);
      },
    };
  },
};

Module._load = function (request, parent, isMain) {
  if (parent?.filename === routesPath && request === '../config/db') return fakePool;
  if (parent?.filename === routesPath && request === '../models/inventorySoftwareModel') {
    const real = originalLoad.call(this, request, parent, isMain);
    return {
      ...real,
      ensureInventorySoftwareTables: async () => {},
      resolveProductByQrOrCode: async (_db, code) => (
        ['BV-TEST-01', '890000000001'].includes(String(code))
          ? { productId: 5, sku: 'BV-TEST-01', barcode: '890000000001', name: 'Test formulation' }
          : null
      ),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const postScan = body => fetch(`${baseUrl}/fulfillment/verify-pack`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-scanner-api-key': scannerKey },
  body: JSON.stringify(body),
});

const getManifest = () => fetch(`${baseUrl}/orders/2/manifest`, {
  headers: { 'x-scanner-api-key': scannerKey },
});

const putOrderItems = items => fetch(`${baseUrl}/orders/2/items`, {
  method: 'PUT',
  headers: {
    'content-type': 'application/json',
    authorization: `Bearer ${jwt.sign({ scope: 'inventory-software', username: 'test-admin' }, 'fallback_secret')}`,
  },
  body: JSON.stringify({ items }),
});

const pairScanner = () => fetch(`${baseUrl}/scanner/pair`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: `Bearer ${jwt.sign({ scope: 'inventory-software', username: 'test-admin' }, 'fallback_secret')}`,
  },
  body: JSON.stringify({ sessionCode, deviceName: 'Packing test device' }),
});

before(async () => {
  const router = require(routesPath);
  Module._load = originalLoad;
  const app = express();
  app.use(express.json());
  app.use('/api/inventory-software', router);
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}/api/inventory-software`;
});

beforeEach(() => {
  verifiedQuantity = 0;
  currentOrderStatus = 'pending';
  savedOrderItems = [];
  deviceExpiresAt = new Date(Date.now() + 3600000);
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  setTimeout(() => process.exit(process.exitCode || 0), 200).unref?.();
});

describe('scanner order packing', () => {
  it('persists a verified scan and marks a fully packed order ready for dispatch', async () => {
    const response = await postScan({ orderId: '2', barcode: 'BV-TEST-01', sessionCode });
    const body = await response.json();

    assert.equal(response.status, 200, body.message);
    assert.equal(body.verified, true);
    assert.equal(body.orderComplete, true, JSON.stringify(body));
    assert.equal(body.orderStatus, 'packed');
    assert.equal(body.progress.totalVerified, 1);
    assert.equal(verifiedQuantity, 1);
    assert.equal(currentOrderStatus, 'packed');
  });

  it('does not count the same required unit twice', async () => {
    verifiedQuantity = 1;
    const response = await postScan({ orderId: '2', barcode: 'BV-TEST-01', sessionCode });
    const body = await response.json();

    assert.equal(response.status, 409);
    assert.equal(body.code, 'ITEM_ALREADY_VERIFIED');
    assert.equal(verifiedQuantity, 1);
  });

  it('returns checklist items in the top-level response consumed by the scanner app', async () => {
    verifiedQuantity = 1;
    const response = await getManifest();
    const body = await response.json();

    assert.equal(response.status, 200, body.message);
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].verifiedCount, 1);
    assert.equal(body.order.items[0].verifiedCount, 1);
  });

  it('requires a paired terminal session for packing scans', async () => {
    const response = await postScan({ orderId: '2', barcode: 'BV-TEST-01' });
    assert.equal(response.status, 400);
    assert.match((await response.json()).message, /terminal session/i);
  });

  it('expires scanner keys after 12 hours', async () => {
    deviceExpiresAt = new Date(Date.now() - 1000);
    const response = await postScan({ orderId: '2', barcode: 'BV-TEST-01', sessionCode });

    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, 'SCANNER_KEY_EXPIRED');
  });

  it('creates scanner pairings with a 12-hour expiry', async () => {
    const beforePair = Date.now();
    const response = await pairScanner();
    const body = await response.json();
    const afterPair = Date.now();

    assert.equal(response.status, 200, body.message);
    const lifetime = new Date(body.expiresAt).getTime() - beforePair;
    assert.ok(lifetime >= 12 * 60 * 60 * 1000);
    assert.ok(lifetime <= afterPair - beforePair + 12 * 60 * 60 * 1000);
    assert.equal(body.hoursRemaining, 12);
  });

  it('resolves an editor temporary ID by the real SKU instead of returning a database error', async () => {
    const response = await putOrderItems([{
      productId: 1762228800000,
      sku: 'BV-TEST-01',
      name: 'Test formulation',
      quantity: 1,
      price: 299,
    }]);
    const body = await response.json();

    assert.equal(response.status, 200, body.message);
    assert.equal(body.success, true);
    assert.equal(savedOrderItems[0].productId, 5);
  });
});
