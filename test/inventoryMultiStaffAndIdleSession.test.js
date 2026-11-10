const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Module = require('node:module');
const path = require('node:path');

const routesPath = path.resolve(__dirname, '../routes/inventorySoftwareRoutes.js');
const originalLoad = Module._load;

function createMockRouter() {
  const routes = [];
  const register = (method, routePath, ...handlers) => {
    routes.push({ method, routePath, handlers });
  };
  return {
    routes,
    get: (p, ...h) => register('GET', p, ...h),
    post: (p, ...h) => register('POST', p, ...h),
    put: (p, ...h) => register('PUT', p, ...h),
    patch: (p, ...h) => register('PATCH', p, ...h),
    delete: (p, ...h) => register('DELETE', p, ...h),
    all: (p, ...h) => register('ALL', p, ...h),
    use: (p, ...h) => register('USE', p, ...h),
  };
}

let sqlQueryCount = 0;
let failPwaWrite = false;
const transactionEvents = [];
const scannerKeyAkash = 'BV-SCAN-AKASH-KEY';
const scannerKeyPriya = 'BV-SCAN-PRIYA-KEY';
const hashAkash = crypto.createHash('sha256').update(scannerKeyAkash).digest('hex');
const hashPriya = crypto.createHash('sha256').update(scannerKeyPriya).digest('hex');

const fakePool = {
  async query(sql, params = []) {
    sqlQueryCount++;
    if (/FROM inventory_scanner_devices WHERE api_key_hash/.test(sql)) {
      const h = params[0];
      if (h === hashAkash) {
        return [[{ session_code: 'STAFF-AKASH', device_name: 'Akash Scanner', expires_at: new Date(Date.now() + 86400000) }]];
      }
      if (h === hashPriya) {
        return [[{ session_code: 'STAFF-PRIYA', device_name: 'Priya Scanner', expires_at: new Date(Date.now() + 86400000) }]];
      }
      return [[]];
    }
    if (/FROM inventory_staff_accounts WHERE username/.test(sql)) {
      const u = String(params[0]).toLowerCase();
      if (u === 'akash' || u === 'admin') {
        return [[{ id: 1, account_code: 'BV-IAM-001', username: 'akash', full_name: 'Akash Prasad', role: 'admin', status: 'active', password_hash: 'hashed:Admin@123' }]];
      }
      if (u === 'priya') {
        return [[{ id: 5, account_code: 'BV-IAM-005', username: 'priya', full_name: 'Priya C', role: 'cashier', status: 'active', password_hash: 'hashed:Priya@123' }]];
      }
      return [[]];
    }
    if (/FROM inventory_staff_accounts WHERE id/.test(sql)) {
      return [[{ id: 5, account_code: 'BV-IAM-005', username: 'priya', full_name: 'Priya C', role: 'cashier', status: 'active', password_hash: 'hashed:Priya@123' }]];
    }
    if (/FROM inventory_scanner_queue/.test(sql)) {
      return [[{ id: 1, session_code: params[0], sku: 'BV-LUX-CFW-01', product_name: 'Charcoal Face Wash', quantity: 2, unit_price: 299, status: 'queued' }]];
    }
    if (/FROM inventory_pos_drafts/.test(sql)) {
      return [[]];
    }
    if (/FROM inventory_pos_saved_drafts/.test(sql)) {
      return [[]];
    }
    if (/FROM order_items oi/.test(sql)) {
      return [[{ order_item_id: 1, product_id: 10, quantity: 2, sku: 'SKU-1', barcode: 'BAR-1' }]];
    }
    if (failPwaWrite && /INSERT INTO inventory_order_pack_progress/.test(sql)) {
      throw new Error('forced PWA transaction failure');
    }
    if (/INSERT INTO inventory_pos_saved_drafts/.test(sql)) {
      return [{ affectedRows: 1 }];
    }
    if (/FROM orders/.test(sql)) {
      const id = Number(params[0]) || 1234;
      return [[{ id, order_number: String(id), status: 'pending', total: 598, address_snapshot: JSON.stringify({ full_name: 'Patron', phone: '9832000000' }) }]];
    }
    if (/UPDATE orders SET status = "packed"/.test(sql)) {
      return [{ affectedRows: 1 }];
    }
    if (/INSERT INTO inventory_order_pack_progress/.test(sql)) {
      return [{ affectedRows: 1 }];
    }
    if (/INSERT INTO inventory_audit_logs/.test(sql)) {
      return [{ affectedRows: 1 }];
    }
    return [[]];
  },
  async getConnection() {
    return {
      async beginTransaction() { transactionEvents.push('begin'); },
      async commit() { transactionEvents.push('commit'); },
      async rollback() { transactionEvents.push('rollback'); },
      release() {},
      query: (sql, params) => fakePool.query(sql, params),
    };
  },
};

Module._load = function (request, parent, isMain) {
  if (request === 'express') {
    return { Router: createMockRouter };
  }
  if (request === 'jsonwebtoken') {
    return {
      sign: (payload) => JSON.stringify(payload),
      verify: (token) => JSON.parse(token),
    };
  }
  if (request === 'express-rate-limit') {
    return {
      rateLimit: () => (_req, _res, next) => next(),
      ipKeyGenerator: (ip) => ip || '127.0.0.1',
    };
  }
  if (request === 'bcryptjs') {
    return {
      hash: async (s) => `hashed:${s}`,
      compare: async (s, h) => h === `hashed:${s}`,
    };
  }
  if (request === '../config/db' || request === './db' || request === 'nodemailer' || request === 'razorpay') return fakePool;
  if (parent?.filename === routesPath && request === '../models/inventorySoftwareModel') {
    const real = originalLoad.call(this, request, parent, isMain);
    return { ...real, ensureInventorySoftwareTables: async () => {} };
  }
  try {
    return originalLoad.call(this, request, parent, isMain);
  } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND') return {};
    throw e;
  }
};

const router = require(routesPath);
Module._load = originalLoad;

async function invokeRoute(method, routePattern, { path: reqPath, headers = {}, query = {}, body = {}, params = {} } = {}) {
  const entry = router.routes.find(r => r.method === method && r.routePath === routePattern);
  assert.ok(entry, `Route ${method} ${routePattern} not found`);

  const req = {
    method,
    path: reqPath || routePattern,
    headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
    query,
    body,
    params,
    ip: '127.0.0.1',
    get(name) {
      return this.headers[name.toLowerCase()];
    },
  };

  let statusCode = 200;
  let responseBody = null;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      responseBody = payload;
      return this;
    },
  };

  let idx = 0;
  const runNext = async () => {
    if (idx >= entry.handlers.length) return;
    const handler = entry.handlers[idx++];
    await handler(req, res, runNext);
  };
  await runNext();
  return { status: statusCode, body: responseBody };
}

test('Staff Mobile Login with Username & Password without pairing QR', async () => {
  const loginRes = await invokeRoute('POST', '/scanner/auth/login', {
    body: {
      username: 'priya',
      password: 'Priya@123',
      deviceName: "Priya's Mobile Scanner",
    },
  });
  assert.equal(loginRes.status, 200);
  assert.equal(loginRes.body.success, true);
  assert.equal(loginRes.body.staff.username, 'priya');
  assert.equal(loginRes.body.staff.fullName, 'Priya C');
  assert.ok(loginRes.body.token);
  assert.equal(loginRes.body.staff.permissions.can_pack, true);
});

test('24x7 Workroom Presence ("Go On Work" radar) operates with 0 MySQL queries', async () => {
  const akashLogin = await invokeRoute('POST', '/scanner/auth/login', {
    body: { username: 'akash', password: 'Admin@123', deviceName: 'Akash PWA' },
  });
  const priyaLogin = await invokeRoute('POST', '/scanner/auth/login', {
    body: { username: 'priya', password: 'Priya@123', deviceName: 'Priya PWA' },
  });
  assert.equal(akashLogin.status, 200);
  assert.equal(priyaLogin.status, 200);
  const akashHeaders = { authorization: `Bearer ${akashLogin.body.token}` };
  const priyaHeaders = { authorization: `Bearer ${priyaLogin.body.token}` };

  const beforeSql = sqlQueryCount;

  // 1. Akash toggles "Go On Work" 
  const akashWork = await invokeRoute('POST', '/workroom/toggle-work', {
    headers: akashHeaders,
    body: {
      sessionCode: akashLogin.body.sessionCode,
      onWork: true,
      mode: 'PACKING',
      activeOrder: '1234',
      savedBulkOrders: [{ orderId: '1234', orderNumber: '1234' }],
      operatorUsername: 'akash',
      operatorName: 'Akash',
    },
  });
  assert.equal(akashWork.status, 200);
  assert.equal(akashWork.body.worker.onWork, true);
  assert.equal(akashWork.body.worker.mode, 'PACKING');

  // 2. Priya toggles "Go On Work"
  const priyaWork = await invokeRoute('POST', '/workroom/toggle-work', {
    headers: priyaHeaders,
    body: {
      sessionCode: priyaLogin.body.sessionCode,
      onWork: true,
      mode: 'BILLING',
      operatorUsername: 'priya',
      operatorName: 'Priya C',
    },
  });
  assert.equal(priyaWork.status, 200);

  // 3. Query workroom presence -> reads directly from Node.js 24x7 memory!
  const presenceRes = await invokeRoute('GET', '/workroom/presence', {
    headers: akashHeaders,
  });
  assert.equal(presenceRes.status, 200);
  assert.equal(presenceRes.body.count, 2);
  const workers = presenceRes.body.activeWorkers;
  assert.ok(workers.some(w => w.username === 'akash' && w.mode === 'PACKING'));
  assert.deepEqual(workers.find(w => w.username === 'akash').savedBulkOrders, [{ orderId: '1234', orderNumber: '1234' }]);
  assert.ok(workers.some(w => w.username === 'priya' && w.mode === 'BILLING'));

  const heartbeatRes = await invokeRoute('POST', '/workroom/heartbeat', {
    headers: akashHeaders,
    body: {
      sessionCode: akashLogin.body.sessionCode,
      operatorUsername: 'akash',
      mode: 'PACKING',
      scannedUnits: 1,
      expectedUnits: 2,
      savedBulkOrders: [{ orderId: '1234', orderNumber: '1234' }, { orderId: '5678', orderNumber: '5678' }],
    },
  });
  assert.equal(heartbeatRes.status, 200);
  assert.equal(heartbeatRes.body.worker.scannedUnits, 1);
  assert.equal(heartbeatRes.body.worker.expectedUnits, 2);

  const allStaffRes = await invokeRoute('GET', '/workroom/presence', {
    headers: akashHeaders,
  });
  assert.ok(allStaffRes.body.workers.some(w => w.username === 'akash' && w.savedBulkOrders.length === 2));
  // ZERO MySQL queries executed for workroom presence!
  assert.equal(sqlQueryCount - beforeSql, 0);
});

test('PWA fulfillment rollback preserves the packing lock, then successful commit completes it', async () => {
  const loginRes = await invokeRoute('POST', '/scanner/auth/login', {
    body: { username: 'priya', password: 'Priya@123', deviceName: 'PWA Test Device' },
  });
  assert.equal(loginRes.status, 200);
  const token = loginRes.body.token;
  const headers = { authorization: `Bearer ${token}` };
  const commonBody = {
    sessionCode: loginRes.body.sessionCode,
    operatorUsername: 'priya',
    operatorName: 'Priya C',
  };

  const manifestRes = await invokeRoute('GET', '/orders/:id/manifest', {
    path: '/orders/9876/manifest',
    params: { id: '9876' },
    headers,
    query: commonBody,
  });
  assert.equal(manifestRes.status, 200);

  const packedOrder = {
    orderId: 9876,
    verifiedItems: [{
      orderItemId: 1,
      quantity: 2,
      verifiedCount: 2,
      scannedCodes: ['SKU-1', 'BAR-1'],
    }],
  };
  transactionEvents.length = 0;
  failPwaWrite = true;
  const failedUpload = await invokeRoute('POST', '/fulfillment/pwa-batch', {
    path: '/fulfillment/pwa-batch',
    headers,
    body: { ...commonBody, packedOrders: [packedOrder] },
  });
  failPwaWrite = false;
  assert.equal(failedUpload.status, 500);
  assert.ok(transactionEvents.includes('rollback'));
  const lockAfterRollback = await invokeRoute('GET', '/orders/locks', { headers });
  assert.ok(lockAfterRollback.body.locks.some(lock => lock.orderKey === '9876' && lock.status === 'LOCKED'));

  transactionEvents.length = 0;
  const successfulUpload = await invokeRoute('POST', '/fulfillment/pwa-batch', {
    path: '/fulfillment/pwa-batch',
    headers,
    body: { ...commonBody, packedOrders: [packedOrder] },
  });
  assert.equal(successfulUpload.status, 200);
  assert.equal(successfulUpload.body.success, true);
  assert.ok(transactionEvents.indexOf('commit') >= 0);
  assert.ok(transactionEvents.indexOf('commit') < transactionEvents.length);
  const lockAfterCommit = await invokeRoute('GET', '/orders/locks', { headers });
  assert.ok(lockAfterCommit.body.locks.some(lock => lock.orderKey === '9876' && lock.status === 'COMPLETED'));
});

test('Multi-staff Order ID mutex lock blocks Priya C when Akash is already billing Order #1234', async () => {
  // 1. Akash claims Order #1234
  const akashClaim = await invokeRoute('POST', '/orders/claim', {
    headers: { 'x-scanner-api-key': scannerKeyAkash },
    body: {
      orderId: '1234',
      sessionCode: 'STAFF-AKASH',
      operatorUsername: 'akash',
      operatorName: 'Akash',
    },
  });
  assert.equal(akashClaim.status, 200);
  assert.equal(akashClaim.body.success, true);
  assert.equal(akashClaim.body.lock.lockedByName, 'Akash');

  // 2. Priya C tries to claim Order #1234 at the same time -> MUST BE BLOCKED (409)
  const priyaClaim = await invokeRoute('POST', '/orders/claim', {
    headers: { 'x-scanner-api-key': scannerKeyPriya },
    body: {
      orderId: '1234',
      sessionCode: 'STAFF-PRIYA',
      operatorUsername: 'priya',
      operatorName: 'Priya C',
    },
  });
  assert.equal(priyaClaim.status, 409);
  assert.equal(priyaClaim.body.code, 'ORDER_LOCKED_BY_OTHER_STAFF');
  assert.match(priyaClaim.body.message, /Akash/);

  // 3. Priya C CAN bill or pack a different Order ID (#5678) simultaneously without issue
  const priyaOtherOrder = await invokeRoute('POST', '/orders/claim', {
    headers: { 'x-scanner-api-key': scannerKeyPriya },
    body: {
      orderId: '5678',
      sessionCode: 'STAFF-PRIYA',
      operatorUsername: 'priya',
      operatorName: 'Priya C',
    },
  });
  assert.equal(priyaOtherOrder.status, 200);
  assert.equal(priyaOtherOrder.body.lock.lockedByName, 'Priya C');
});

test('Batch push stacked packed orders wakes MySQL once for the whole stack of orders', async () => {
  const batchRes = await invokeRoute('POST', '/fulfillment/batch-push', {
    headers: { 'x-scanner-api-key': scannerKeyAkash },
    body: {
      operatorUsername: 'akash',
      operatorName: 'Akash',
      stackedOrders: [
        {
          orderId: 1234,
          orderNumber: '1234',
          verifiedItems: [
            { orderItemId: 1, quantity: 2, verifiedCount: 2 },
          ],
          packedAt: Date.now(),
        },
      ],
    },
  });
  assert.equal(batchRes.status, 200);
  assert.equal(batchRes.body.success, true);
  assert.equal(batchRes.body.count, 1);
  assert.equal(batchRes.body.orders[0].status, 'packed');
});

test('Fulfillment QR manifest endpoint handles ORD:1234 and returns order items without SQL column error', async () => {
  const manifestRes = await invokeRoute('GET', '/orders/:id/manifest', {
    path: '/orders/ORD:1234/manifest',
    params: { id: 'ORD:1234' },
    headers: { 'x-scanner-api-key': scannerKeyAkash },
    query: { operatorUsername: 'akash', operatorName: 'Akash' },
  });
  assert.equal(manifestRes.status, 200);
  assert.equal(manifestRes.body.success, true);
  assert.equal(manifestRes.body.order.id, 1234);
  assert.equal(manifestRes.body.order.customerName, 'Patron');
  assert.equal(manifestRes.body.order.customerPhone, '9832000000');
  assert.equal(manifestRes.body.order.totalAmount, 598);
});
