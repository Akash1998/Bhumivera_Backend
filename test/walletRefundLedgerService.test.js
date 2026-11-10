'use strict';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');
const Module = require('node:module');

const servicePath = require.resolve('../services/walletRefundLedgerService');
const originalLoad = Module._load;
const mocks = new Map([
  ['../utils/walletAccount', { ensureWalletAccount: async () => {} }],
  ['../utils/fortressCrypto', { computeQuantumHash512: () => 'test-signature' }],
  ['../models/shoppingWalletRewardModel', { updateShoppingWalletRewardReversal: async () => {} }],
  ['../models/superAdminVaultModel', {
    SUPERADMIN_EMAIL: 'owner@example.com',
    ensureSuperAdminFortressTables: async () => {},
  }],
]);

Module._load = function (request, parent, isMain) {
  if (parent?.filename === servicePath && mocks.has(request)) return mocks.get(request);
  return originalLoad.call(this, request, parent, isMain);
};
const { executeAtomicOrderCancellationAndRefund } = require(servicePath);
Module._load = originalLoad;

function createPool(order) {
  const state = { committed: false, rolledBack: false, updatedOrder: false };
  const connection = {
    async beginTransaction() {},
    async commit() { state.committed = true; },
    async rollback() { state.rolledBack = true; },
    release() {},
    async query(sql) {
      if (sql.includes('FROM orders') && sql.includes('FOR UPDATE')) return [[order], []];
      if (sql.includes('SELECT product_id, quantity FROM order_items')) return [[], []];
      if (sql.includes('SELECT balance FROM wallets')) return [[{ balance: 20 }], []];
      if (sql.includes('UPDATE orders') && sql.includes("SET status = 'cancelled'")) state.updatedOrder = true;
      return [{ affectedRows: 1, insertId: 1 }, []];
    },
  };
  return {
    state,
    async getConnection() { return connection; },
  };
}

function orderFixture(overrides = {}) {
  return {
    id: 12,
    order_number: '369425268',
    user_id: 7,
    status: 'confirmed',
    payment_mode: 'COD',
    payment_status: 'pending',
    payment_id: null,
    subtotal: 100,
    discount: 0,
    tier_discount: 0,
    referral_wallet_amount: 0,
    shipping_cost: 0,
    impact_amount: 0,
    total: 100,
    coupon_code: null,
    loyalty_points_awarded: 0,
    loyalty_points_redeemed: 0,
    ...overrides,
  };
}

describe('SuperAdmin cancellation and refund ledger', () => {
  it('cancels COD orders without requiring Razorpay configuration', async () => {
    const pool = createPool(orderFixture());
    const result = await executeAtomicOrderCancellationAndRefund(pool, { orderId: '369425268' });

    assert.equal(pool.state.committed, true);
    assert.equal(pool.state.rolledBack, false);
    assert.equal(pool.state.updatedOrder, true);
    assert.equal(result.refundSummary.refundDestination, 'INTERNAL_REFUND_LEDGER');
    assert.equal(result.refundSummary.gatewayRefundAmount, 0);
  });

  it('does not cancel a paid online order when Razorpay is not configured', async () => {
    const pool = createPool(orderFixture({
      payment_mode: 'online',
      payment_status: 'paid',
      payment_id: 'pay_123',
    }));

    await assert.rejects(
      executeAtomicOrderCancellationAndRefund(pool, { orderId: 12 }),
      error => error.code === 'RAZORPAY_NOT_CONFIGURED' && error.statusCode === 503,
    );
    assert.equal(pool.state.committed, false);
    assert.equal(pool.state.rolledBack, true);
    assert.equal(pool.state.updatedOrder, false);
  });

  it('does not cancel a paid online order if the gateway rejects the refund', async () => {
    const pool = createPool(orderFixture({
      payment_mode: 'online',
      payment_status: 'paid',
      payment_id: 'pay_123',
    }));
    const razorpay = { payments: { refund: async () => { throw new Error('Gateway unavailable'); } } };

    await assert.rejects(
      executeAtomicOrderCancellationAndRefund(pool, { orderId: 12, razorpay }),
      error => error.code === 'GATEWAY_REFUND_FAILED' && error.statusCode === 502,
    );
    assert.equal(pool.state.committed, false);
    assert.equal(pool.state.rolledBack, true);
    assert.equal(pool.state.updatedOrder, false);
  });

  it('records the gateway refund reference and status when Razorpay accepts it', async () => {
    const pool = createPool(orderFixture({
      payment_mode: 'online',
      payment_status: 'paid',
      payment_id: 'pay_123',
    }));
    const razorpay = {
      payments: {
        refund: async (_paymentId, options) => {
          assert.equal(options.amount, 10000);
          return { id: 'rfnd_123', payment_id: 'pay_123', amount: 10000, status: 'pending' };
        },
      },
    };

    const result = await executeAtomicOrderCancellationAndRefund(pool, { orderId: 12, razorpay });

    assert.equal(pool.state.committed, true);
    assert.equal(result.refundSummary.refundDestination, 'ORIGINAL_GATEWAY');
    assert.equal(result.refundSummary.gatewayRefundId, 'rfnd_123');
    assert.equal(result.refundSummary.gatewayStatus, 'PENDING_WEBHOOK');
    assert.equal(result.paymentStatus, 'refund_initiated');
  });
});
