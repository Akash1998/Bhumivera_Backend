const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');
const express = require('express');
const jwt = require('jsonwebtoken');
const Module = require('node:module');
const path = require('node:path');

const secret = 'authorization-tests-only-secret-with-more-than-32-characters';
const authMiddlewarePath = path.resolve(__dirname, '../middleware/authMiddleware.js');
const originalLoad = Module._load;
process.env.JWT_SECRET = secret;

Module._load = function (request, parent, isMain) {
  if (parent?.filename === authMiddlewarePath && request === '../utils/sessionStore') {
    return { isSessionActive: async () => true };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { authenticateAdmin } = require(authMiddlewarePath);
Module._load = originalLoad;

const app = express();
app.use(express.json());
app.use('/api', authenticateAdmin, (req, res) => {
  res.json({ permission: req.permission, role: req.admin.role });
});

let server;
let baseUrl;

before(async () => {
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

const tokenFor = role => jwt.sign({
  id: 42,
  email: `${role}@example.com`,
  role,
  sessionType: 'admin',
}, secret, { expiresIn: '5m', jwtid: `session-${role}` });

const request = (role, method, path, body) => fetch(`${baseUrl}${path}`, {
  method,
  headers: {
    ...(role ? { authorization: `Bearer ${tokenFor(role)}` } : {}),
    ...(body ? { 'content-type': 'application/json' } : {}),
  },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

describe('central admin route authorization', () => {
  it('requires authentication and rejects customer roles with the correct status', async () => {
    assert.equal((await request(null, 'GET', '/inventory')).status, 401);
    const customer = await request('customer', 'GET', '/inventory');
    assert.equal(customer.status, 403);
  });

  it('allows customer-service reads but reserves account changes for superadmins', async () => {
    assert.equal((await request('admin', 'GET', '/inventory')).status, 200);
    assert.equal((await request('superadmin', 'PUT', '/inventory/12/stock', { stock: 4 })).status, 200);
    const warehouseUsers = await request('warehouse_admin', 'GET', '/admin/users');
    assert.equal(warehouseUsers.status, 403);
    assert.equal((await warehouseUsers.json()).permission, 'users.read');
    assert.equal((await request('admin', 'GET', '/admin/users')).status, 200);
    assert.equal((await request('admin', 'PATCH', '/admin/users/9/status', { status: 'disabled' })).status, 403);
    assert.equal((await request('superadmin', 'PATCH', '/admin/users/9/status', { status: 'disabled' })).status, 200);
  });

  it('limits warehouse users to operational inventory, fulfillment, and label permissions', async () => {
    assert.equal((await request('warehouse_admin', 'GET', '/inventory/low-stock')).status, 200);
    assert.equal((await request('warehouse_admin', 'PUT', '/inventory/12/stock', { stock: 4 })).status, 200);
    assert.equal((await request('warehouse_admin', 'POST', '/shipping/labels', { provider: 'shiprocket' })).status, 200);
    assert.equal((await request('warehouse_admin', 'GET', '/gst/documents')).status, 403);
    assert.equal((await request('warehouse_admin', 'GET', '/orders/all')).status, 403);
  });

  it('permits fulfillment statuses for warehouse users but blocks financial/order-management statuses', async () => {
    assert.equal((await request('warehouse_admin', 'PUT', '/orders/12/status', { status: 'shipped' })).status, 200);
    const denied = await request('warehouse_admin', 'PUT', '/orders/12/status', { status: 'cancelled' });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).code, 'AUTH_PERMISSION_DENIED');
    assert.equal((await request('admin', 'PUT', '/orders/12/status', { status: 'cancelled' })).status, 200);
  });

  it('reserves customer and warehouse account administration for superadmins', async () => {
    assert.equal((await request('superadmin', 'GET', '/admin/users')).status, 200);
    assert.equal((await request('superadmin', 'POST', '/warehouse/admin/grant-access', { user_id: 9 })).status, 200);
    assert.equal((await request('admin', 'POST', '/warehouse/admin/grant-access', { user_id: 9 })).status, 403);
  });

  it('requires a refund permission for return refunds and authenticates affiliate management', async () => {
    const adminRefund = await request('admin', 'PUT', '/returns/admin/7', { status: 'refunded' });
    assert.equal(adminRefund.status, 200);
    assert.equal((await request('warehouse_admin', 'PUT', '/returns/admin/7', { status: 'refunded' })).status, 403);
    assert.equal((await request('admin', 'GET', '/affiliate/partners')).status, 200);
    assert.equal((await request('warehouse_admin', 'GET', '/affiliate/partners')).status, 403);
  });
});
