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
    if (/FROM inventory_scanner_queue/.test(sql)) {
      return [[{ id: 1, session_code: params[0], sku: 'BV-LUX-CFW-01', product_name: 'Charcoal Face Wash', quantity: 2, unit_price: 299, status: 'queued' }]];
    }
    if (/FROM inventory_pos_drafts/.test(sql)) {
      return [[]];
    }
    if (/FROM inventory_pos_saved_drafts/.test(sql)) {
      return [[]];
    }
    if (/INSERT INTO inventory_pos_saved_drafts/.test(sql)) {
      return [{ affectedRows: 1 }];
    }
    if (/FROM orders/.test(sql)) {
      return [[{ id: 1234, order_number: '1234', status: 'pending', total: 598, address_snapshot: JSON.stringify({ full_name: 'Patron', phone: '9832000000' }) }]];
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
      async beginTransaction() {},
      async commit() {},
      async rollback() {},
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
  // Warm in-memory session cache
  await invokeRoute("POST", "/scanner/connect", {
    headers: { "x-scanner-api-key": scannerKeyAkash },
    body: { sessionCode: "STAFF-AKASH", operatorUsername: "akash", operatorName: "Akash" },
  });
  await invokeRoute("POST", "/scanner/connect", {
    headers: { "x-scanner-api-key": scannerKeyPriya },
    body: { sessionCode: "STAFF-PRIYA", operatorUsername: "priya", operatorName: "Priya C" },
  });

  const beforeSql = sqlQueryCount;

  // 1. Akash toggles "Go On Work" 
  const akashWork = await invokeRoute('POST', '/workroom/toggle-work', {
    headers: { 'x-scanner-api-key': scannerKeyAkash },
    body: {
      onWork: true,
      mode: 'PACKING',
      activeOrder: '1234',
      operatorUsername: 'akash',
      operatorName: 'Akash',
    },
  });
  assert.equal(akashWork.status, 200);
  assert.equal(akashWork.body.worker.onWork, true);
  assert.equal(akashWork.body.worker.mode, 'PACKING');

  // 2. Priya toggles "Go On Work"
  const priyaWork = await invokeRoute('POST', '/workroom/toggle-work', {
    headers: { 'x-scanner-api-key': scannerKeyPriya },
    body: {
      onWork: true,
      mode: 'BILLING',
      operatorUsername: 'priya',
      operatorName: 'Priya C',
    },
  });
  assert.equal(priyaWork.status, 200);

  // 3. Query workroom presence -> reads directly from Node.js 24x7 memory!
  const presenceRes = await invokeRoute('GET', '/workroom/presence', {
    headers: { 'x-scanner-api-key': scannerKeyAkash },
  });
  assert.equal(presenceRes.status, 200);
  assert.equal(presenceRes.body.count, 2);
  const workers = presenceRes.body.activeWorkers;
  assert.ok(workers.some(w => w.username === 'akash' && w.mode === 'PACKING'));
  assert.ok(workers.some(w => w.username === 'priya' && w.mode === 'BILLING'));

  // ZERO MySQL queries executed for workroom presence!
  assert.equal(sqlQueryCount - beforeSql, 0);
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
