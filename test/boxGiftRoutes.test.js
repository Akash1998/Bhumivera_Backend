const assert = require('node:assert/strict');
const { after, before, beforeEach, describe, it } = require('node:test');
const express = require('express');
const Module = require('node:module');
const path = require('node:path');

const routePath = path.resolve(__dirname, '../routes/gamificationRoutes.js');
const originalLoad = Module._load;
const state = {
  claim: null,
  order: { id: 25, order_number: 'BV000025' },
  serials: new Set(['BV-CH26-8841']),
  walletBalance: 10,
  loyaltyPoints: 2,
  walletTransactions: [],
  pointTransactions: [],
};

const pool = {
  async query(sql, params = []) {
    if (sql.includes('FROM product_serials')) {
      return [[...(state.serials.has(params[0]) ? [{ id: 1 }] : [])], []];
    }
    if (sql.includes('FROM box_gift_claims')) {
      return [[...(state.claim ? [{ created_at: state.claim.created_at }] : [])], []];
    }
    if (sql.includes('FROM orders') && sql.includes("status = 'delivered'")) {
      return [[...(state.order ? [state.order] : [])], []];
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
        if (sql.includes('FROM users WHERE id = ? FOR UPDATE')) {
          return [[{
            id: 7,
            loyalty_points: state.loyaltyPoints,
            loyalty_lifetime_points: state.loyaltyPoints,
          }], []];
        }
        if (sql.includes('FROM box_gift_claims')) {
          return [[...(state.claim ? [{ id: 1 }] : [])], []];
        }
        if (sql.includes('FROM product_serials')) {
          return [[...(state.serials.has(params[0]) ? [{ id: 1 }] : [])], []];
        }
        if (sql.includes('FROM orders') && sql.includes("status = 'delivered'")) {
          return [[...(state.order ? [{ id: state.order.id }] : [])], []];
        }
        if (sql.includes('SELECT balance FROM referral_wallets')) {
          return [[{ balance: state.walletBalance }], []];
        }
        if (sql.includes('UPDATE referral_wallets SET balance')) {
          state.walletBalance = params[0];
          return [{ affectedRows: 1 }, []];
        }
        if (sql.includes('UPDATE users SET loyalty_points')) {
          state.loyaltyPoints = params[0];
          return [{ affectedRows: 1 }, []];
        }
        if (sql.includes('INSERT INTO referral_wallet_transactions')) {
          state.walletTransactions.push(params);
          return [{ insertId: state.walletTransactions.length }, []];
        }
        if (sql.includes('INSERT INTO loyalty_point_transactions')) {
          state.pointTransactions.push(params);
          return [{ insertId: state.pointTransactions.length }, []];
        }
        if (sql.includes('INSERT INTO box_gift_claims')) {
          state.claim = { created_at: new Date().toISOString(), params };
          return [{ insertId: 1 }, []];
        }
        return [{ affectedRows: 1 }, []];
      },
    };
  },
};

Module._load = function (request, parent, isMain) {
  if (parent?.filename === routePath && request === 'express-rate-limit') {
    return () => (_req, _res, next) => next();
  }
  if (parent?.filename === routePath && request === '../config/db') return pool;
  if (parent?.filename === routePath && request === '../middleware/authMiddleware') {
    return {
      authenticateUser(req, _res, next) {
        req.user = { id: 7 };
        next();
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const gamificationRoutes = require('../routes/gamificationRoutes');
Module._load = originalLoad;

const app = express();
app.use(express.json());
app.use('/api/gamification', gamificationRoutes);

let server;
let baseUrl;

before(async () => {
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}/api/gamification`;
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
});

beforeEach(() => {
  state.claim = null;
  state.order = { id: 25, order_number: 'BV000025' };
  state.serials = new Set(['BV-CH26-8841']);
  state.walletBalance = 10;
  state.loyaltyPoints = 2;
  state.walletTransactions = [];
  state.pointTransactions = [];
});

const request = (method, endpoint, body) => fetch(`${baseUrl}${endpoint}`, {
  method,
  headers: body ? { 'content-type': 'application/json' } : {},
  body: body ? JSON.stringify(body) : undefined,
});

describe('delivered-order box gift routes', () => {
  it('only offers the gift when the account has a delivered order', async () => {
    state.order = null;
    const response = await request('GET', '/box-qr-status?qr=BHUMIVERA-GIFT-2026');

    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.canRedeem, false);
    assert.equal(result.code, 'NO_DELIVERED_ORDER');
  });

  it('checks one-time gift status against the authenticated account', async () => {
    const response = await request('GET', '/box-qr-status?qr=BHUMIVERA-GIFT-2026');

    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.canRedeem, true);
    assert.equal(result.qualifyingOrder.id, state.order.id);
  });

  it('credits wallet and loyalty points once and rejects a repeated claim', async () => {
    const first = await request('POST', '/redeem-box-qr', {
      qr: 'BHUMIVERA-GIFT-2026',
      serial: 'BV-CH26-8841',
    });
    assert.equal(first.status, 201);
    assert.deepEqual(
      (({ creditInr, loyaltyPoints, walletBalance, pointsBalance }) => ({
        creditInr,
        loyaltyPoints,
        walletBalance,
        pointsBalance,
      }))(await first.json()),
      { creditInr: 250, loyaltyPoints: 100, walletBalance: 260, pointsBalance: 102 },
    );

    const repeated = await request('POST', '/redeem-box-qr', { qr: 'BHUMIVERA-GIFT-2026' });
    assert.equal(repeated.status, 409);
    assert.equal((await repeated.json()).code, 'GIFT_ALREADY_REDEEMED');
    assert.equal(state.walletTransactions.length, 1);
    assert.equal(state.pointTransactions.length, 1);
  });

  it('rejects invalid codes and unregistered optional serials', async () => {
    const invalidCode = await request('GET', '/box-qr-status?qr=NOT-A-GIFT');
    assert.equal(invalidCode.status, 400);

    const invalidSerial = await request('GET', '/box-qr-status?qr=BHUMIVERA-GIFT-2026&serial=BV-NOT-REGISTERED');
    assert.equal(invalidSerial.status, 404);
    assert.equal((await invalidSerial.json()).code, 'INVALID_SERIAL');
  });
});
