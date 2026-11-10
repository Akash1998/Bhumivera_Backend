const assert = require('node:assert/strict');
const { after, before, beforeEach, describe, it } = require('node:test');
const express = require('express');
const Module = require('node:module');
const path = require('node:path');

const originalLoad = Module._load;
const routePath = path.resolve(__dirname, '../routes/impactRoutes.js');
const state = { contribution: null, orderOptions: null, emailAttempts: 0 };
const pool = {
  async query(sql, params) {
    if (sql.includes('SELECT id, email FROM users')) return [[{ id: 17, email: 'registered@example.com' }]];
    if (sql.includes('INSERT INTO impact_contributions')) {
      state.contribution = {
        id: 44,
        user_id: params[0],
        project_key: params[1],
        amount: params[2],
        status: 'pledged',
        razorpay_order_id: params[3],
        payment_id: null,
        certificate_code: params[4],
        dedication: params[5],
        certificate_sent_at: null,
        customer_name: 'Test Patron',
        customer_email: 'registered@example.com',
        created_at: '2026-10-18T12:00:00.000Z',
      };
      return [{ insertId: state.contribution.id }];
    }
    throw new Error(`Unexpected pool query: ${sql}`);
  },
  async getConnection() {
    return {
      async beginTransaction() {},
      async commit() {},
      async rollback() {},
      release() {},
      async query(sql, params) {
        if (sql.includes('FROM impact_contributions') && sql.includes('razorpay_order_id')) {
          return [[state.contribution?.razorpay_order_id === params[0] ? { ...state.contribution } : null].filter(Boolean)];
        }
        if (sql.includes('UPDATE impact_contributions')) {
          state.contribution.payment_id = params[0];
          state.contribution.status = 'collected';
          return [{ affectedRows: 1 }];
        }
        throw new Error(`Unexpected connection query: ${sql}`);
      },
    };
  },
};

const mocks = new Map([
  ['../config/db', pool],
  ['../middleware/authMiddleware', {
    authenticateAdmin: (_req, _res, next) => next(),
    authenticateUser: (req, _res, next) => {
      req.user = { id: 17 };
      next();
    },
  }],
  ['../middleware/rateLimiter', { orderLimiter: (_req, _res, next) => next() }],
  ['../models/impactModel', {
    initImpactTables: async () => {},
    getPublicImpact: async () => ({ totals: [], updates: [] }),
    getAllContributions: async () => [],
    getAllImpactUpdates: async () => [],
  }],
  ['../services/razorpayService', {
    getRazorpayClient: () => ({
      orders: {
        create: async options => {
          state.orderOptions = options;
          return { id: 'order_impact_123', amount: options.amount, currency: options.currency };
        },
      },
    }),
    verifyRazorpayPayment: async ({ orderId, paymentId, expectedAmount }) => ({
      order: {
        id: orderId,
        amount: expectedAmount,
        currency: 'INR',
        notes: {
          purpose: 'impact_donation',
          userId: '17',
          projectKey: 'hungry-feeding',
          amountPaise: String(expectedAmount),
        },
      },
      payment: {
        id: paymentId,
        order_id: orderId,
        amount: expectedAmount,
        currency: 'INR',
        status: 'captured',
      },
    }),
  }],
  ['../services/impactDonationService', {
    IMPACT_DONATION_PROJECTS: new Map([['hungry-feeding', 'Warm Meal Annadaan & Hunger Relief Kitchen']]),
    sendImpactCertificateForContribution: async (_pool, id) => {
      assert.equal(id, 44);
      if (state.contribution.certificate_sent_at) return true;
      state.emailAttempts += 1;
      state.contribution.certificate_sent_at = '2026-10-18T12:01:00.000Z';
      return true;
    },
  }],
  ['../utils/mail', { sendMail: async () => ({ success: true }) }],
]);

Module._load = function (request, parent, isMain) {
  if (parent?.filename === routePath && mocks.has(request)) return mocks.get(request);
  return originalLoad.call(this, request, parent, isMain);
};
const impactRoutes = require(routePath);
Module._load = originalLoad;

const app = express();
app.use(express.json());
app.use('/impact', impactRoutes);
let server;
let baseUrl;

before(async () => {
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}/impact`;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
});

beforeEach(() => {
  state.contribution = null;
  state.orderOptions = null;
  state.emailAttempts = 0;
});

describe('impact donation payment routes', () => {
  it('creates a Razorpay order and reserves the contribution against that order', async () => {
    const response = await fetch(`${baseUrl}/donations/create-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: 100, projectKey: 'hungry-feeding', dedication: 'For the community' }),
    });
    const result = await response.json();

    assert.equal(response.status, 201);
    assert.equal(result.order_id, 'order_impact_123');
    assert.equal(state.orderOptions.amount, 10000);
    assert.equal(state.orderOptions.notes.userId, '17');
    assert.equal(state.contribution.razorpay_order_id, result.order_id);
    assert.equal(state.contribution.status, 'pledged');
    assert.equal(state.contribution.dedication, 'For the community');
  });

  it('records a captured payment exactly once and sends the certificate to the account email', async () => {
    state.contribution = {
      id: 44,
      user_id: 17,
      project_key: 'hungry-feeding',
      amount: 100,
      status: 'pledged',
      razorpay_order_id: 'order_impact_123',
      payment_id: null,
      certificate_code: 'BV-HUNG-TEST-01',
      dedication: null,
      certificate_sent_at: null,
      customer_name: 'Test Patron',
      customer_email: 'registered@example.com',
      created_at: '2026-10-18T12:00:00.000Z',
    };

    const response = await fetch(`${baseUrl}/donations/verify-payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        razorpay_order_id: 'order_impact_123',
        razorpay_payment_id: 'pay_impact_123',
        razorpay_signature: 'verified-signature',
        amountPaise: 10000,
      }),
    });
    const result = await response.json();

    assert.equal(response.status, 200);
    assert.equal(result.success, true);
    assert.equal(result.certificateSent, true);
    assert.equal(result.certificate.email, 'registered@example.com');
    assert.equal(state.contribution.status, 'collected');
    assert.equal(state.contribution.payment_id, 'pay_impact_123');
    assert.equal(state.emailAttempts, 1);

    const duplicateResponse = await fetch(`${baseUrl}/donations/verify-payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        razorpay_order_id: 'order_impact_123',
        razorpay_payment_id: 'pay_impact_123',
        razorpay_signature: 'verified-signature',
        amountPaise: 10000,
      }),
    });
    assert.equal(duplicateResponse.status, 200);
    assert.equal(state.emailAttempts, 1);
  });

  it('rejects unsupported contribution amounts before creating a payment', async () => {
    const response = await fetch(`${baseUrl}/donations/create-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: 1, projectKey: 'hungry-feeding' }),
    });

    assert.equal(response.status, 400);
    assert.equal(state.orderOptions, null);
    assert.equal(state.contribution, null);
  });
});
