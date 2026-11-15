const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');
const express = require('express');
const Module = require('node:module');
const path = require('node:path');

const returnRoutesPath = path.resolve(__dirname, '../routes/returnRoutes.js');
const originalLoad = Module._load;
let createdRequest;

Module._load = function (request, parent, isMain) {
  if (parent?.filename === returnRoutesPath && request === '../config/db') {
    return { query: async () => [[]] };
  }
  if (parent?.filename === returnRoutesPath && request === '../middleware/authMiddleware') {
    const authenticateUser = (req, res, next) => {
      req.user = { id: 7, role: 'customer' };
      next();
    };
    return { authenticateUser, authenticateAdmin: authenticateUser };
  }
  if (parent?.filename === returnRoutesPath && request === '../config/s3Upload') {
    return { generateUploadUrl: async () => ({}) };
  }
  if (parent?.filename === returnRoutesPath && request === '../models/returnModel') {
    return {
      createReturn: async requestData => {
        createdRequest = requestData;
        return 42;
      },
      getReturnsByUser: async () => [],
      getReturnById: async () => null,
      getAllReturns: async () => [],
      updateReturnStatus: async () => true,
    };
  }
  if (parent?.filename === returnRoutesPath && request === '../models/orderModel') {
    return {
      getOrderById: async id => ({
        id,
        user_id: id === 99 ? 8 : 7,
        status: 'delivered',
        delivered_at: id === 88
          ? new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
          : new Date(),
      }),
    };
  }
  if (parent?.filename === returnRoutesPath && request === '../models/settingsModel') {
    return { getSetting: async () => '7' };
  }
  if (parent?.filename === returnRoutesPath && request === '../services/razorpayService') {
    return { getRazorpayClient: () => null };
  }
  if (parent?.filename === returnRoutesPath && request === '../services/returnRefundService') {
    return {
      createReturnRefund: async () => ({}),
      reconcileReturnRefund: async () => ({}),
      toPaise: () => null,
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const returnRoutes = require('../routes/returnRoutes');
Module._load = originalLoad;

const app = express();
app.use(express.json());
app.use('/api/returns', returnRoutes);

let server;
let baseUrl;

before(async () => {
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}/api/returns`;
});

after(async () => {
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

const submitRequest = body => fetch(baseUrl, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

describe('customer return request intake', () => {
  it('accepts a delivered-order issue for human review without promising a refund', async () => {
    createdRequest = null;
    const response = await submitRequest({
      order_id: 12,
      reason: 'Item arrived damaged',
      description: 'The bottle leaked in transit.',
    });

    assert.equal(response.status, 201);
    const result = await response.json();
    assert.equal(result.data.id, 42);
    assert.match(result.message, /does not guarantee a refund or replacement/);
    assert.equal(createdRequest.order_id, 12);
    assert.equal(createdRequest.user_id, 7);
    assert.equal(createdRequest.reason, 'Item arrived damaged');
    assert.deepEqual(createdRequest.image_urls, []);
  });

  it('rejects invalid requests and prevents requests for another customer’s order', async () => {
    createdRequest = null;
    assert.equal((await submitRequest({ order_id: 12, reason: 'Damage' })).status, 400);
    assert.equal((await submitRequest({
      order_id: 99,
      reason: 'Damage',
      description: 'The bottle arrived leaking.',
    })).status, 403);
    assert.equal(createdRequest, null);
  });

  it('directs requests outside the standard period to support without denying statutory remedies', async () => {
    createdRequest = null;
    const response = await submitRequest({
      order_id: 88,
      reason: 'Product issue',
      description: 'The item has a defect.',
    });

    assert.equal(response.status, 403);
    assert.match((await response.json()).message, /statutory remedy applies/);
    assert.equal(createdRequest, null);
  });
});
