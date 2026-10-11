const assert = require('node:assert/strict');
const { after, before, beforeEach, describe, it } = require('node:test');
const express = require('express');
const Module = require('node:module');
const path = require('node:path');
const originalLoad = Module._load;
const adminRoutesPath = path.resolve(__dirname, '../routes/adminUserRoutes.js');
const state = { queries: [], recipients: [], sent: [] };
const pass = (_req, _res, next) => next();

const db = {
  async query(sql, params = []) {
    state.queries.push({ sql, params });
    if (sql.includes('COUNT(DISTINCT email)')) return [[{ recipientCount: 2 }], []];
    if (sql.includes('SELECT DISTINCT email')) return [state.recipients, []];
    throw new Error(`Unexpected database query: ${sql}`);
  },
};

const mocks = new Map([
  ['../config/db', db],
  ['../middleware/authMiddleware', { authenticateAdmin: pass }],
  ['../models/userModel', {
    getAdminCustomers: async () => ({}),
    getUserById: async () => null,
    updateUserStatus: async () => {},
    deleteUser: async () => {},
    saveResetOtp: async () => {},
  }],
  ['../models/orderModel', {
    getAllOrders: async () => [],
    getOrdersByUser: async () => [],
    updateOrderStatus: async () => {},
    getOrderById: async () => null,
  }],
  ['../models/reviewModel', { getAllReviews: async () => [] }],
  ['../utils/mail', {
    sendMail: async options => {
      state.sent.push(options);
      return { success: true };
    },
  }],
  ['../services/orderWhatsAppNotifier', { notifyOrderWhatsApp: async () => {} }],
]);

Module._load = function (request, parent, isMain) {
  if (parent?.filename === adminRoutesPath && mocks.has(request)) return mocks.get(request);
  return originalLoad.call(this, request, parent, isMain);
};
const adminRoutes = require(adminRoutesPath);
Module._load = originalLoad;

const app = express();
app.use(express.json());
app.use('/api/admin', adminRoutes);
let server;
let baseUrl;

before(async () => {
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}/api/admin/users/email-campaigns`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

beforeEach(() => {
  state.queries.length = 0;
  state.recipients = [];
  state.sent.length = 0;
});

describe('admin promotional email campaigns', () => {
  it('counts only distinct addresses with active customer marketing consent', async () => {
    const response = await fetch(`${baseUrl}/recipients`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { recipientCount: 2 });
    assert.match(state.queries[0].sql, /role = 'customer'/);
    assert.match(state.queries[0].sql, /is_active = 1/);
    assert.match(state.queries[0].sql, /marketing_email_opt_in = 1/);
  });

  it('sends the all-opted-in campaign only to active subscribers', async () => {
    state.recipients = [{ email: 'one@example.com' }, { email: 'two@example.com' }];
    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        audience: 'all_opted_in',
        title: 'Spring offer',
        message: '<script>not markup</script>\nUse code SPRING',
      }),
    });

    assert.equal(response.status, 200);
    assert.equal((await response.json()).recipientCount, 2);
    assert.deepEqual(state.sent[0].to, ['one@example.com', 'two@example.com']);
    assert.match(state.queries[0].sql, /marketing_email_opt_in = 1/);
    assert.match(state.sent[0].html, /&lt;script&gt;not markup&lt;\/script&gt;/);
    assert.doesNotMatch(state.sent[0].html, /<script>/);
  });

  it('does not send when the selected customers have no eligible marketing recipients', async () => {
    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userIds: [7], title: 'Offer', message: 'Use code SAVE' }),
    });

    assert.equal(response.status, 409);
    assert.equal(state.sent.length, 0);
    assert.match(state.queries[0].sql, /marketing_email_opt_in = 1/);
    assert.match(state.queries[0].sql, /id IN \(\?\)/);
  });
});
