const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  calculateCouponCredit,
  issueOrderCouponCredit,
  updateCouponCreditReversal,
} = require('../models/couponCreditModel');
const { processRazorpayWebhook } = require('../services/razorpayWebhook');

describe('coupon credit rewards', () => {
  it('calculates ten percent with a five-hundred-rupee cap', () => {
    assert.equal(calculateCouponCredit(1234.56), 123.46);
    assert.equal(calculateCouponCredit(10000), 500);
    assert.equal(calculateCouponCredit(-1), 0);
  });

  it('issues the remaining credit after consuming refund offsets', async () => {
    const inserts = [];
    const updates = [];
    const connection = {
      query: async (sql, params) => {
        if (sql.includes('SELECT id, discount_value FROM coupons')) return [[], []];
        if (sql.includes('SELECT id, amount_due FROM coupon_credit_offsets')) {
          return [[{ id: 4, amount_due: '20.00' }], []];
        }
        if (sql.includes('UPDATE coupon_credit_offsets')) {
          updates.push({ sql, params });
          return [{ affectedRows: 1 }, []];
        }
        if (sql.includes('INSERT INTO coupons')) {
          inserts.push({ sql, params });
          return [{ insertId: 1 }, []];
        }
        if (sql.includes('SET coupon_credit_awarded_amount')) {
          updates.push({ sql, params });
          return [{ affectedRows: 1 }, []];
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
    };

    assert.equal(await issueOrderCouponCredit(connection, {
      userId: 7,
      orderId: 12,
      eligibleSubtotal: 1000,
    }), 80);
    assert.equal(inserts.length, 1);
    assert.equal(inserts[0].params[2], 80);
    assert.equal(inserts[0].params[4], 90);
    assert.equal(updates.length, 2);
  });

  it('reverses only the incremental refund share and is idempotent', async () => {
    const state = { reversed: 0, couponValue: 100, couponActive: 1, usedCount: 0 };
    const connection = {
      query: async (sql, params) => {
        if (sql.includes('SELECT user_id, coupon_credit_awarded_amount')) {
          return [[{
            user_id: 7,
            coupon_credit_awarded_amount: 100,
            coupon_credit_reversed_amount: state.reversed,
          }], []];
        }
        if (sql.includes('SELECT id, used_count, discount_value FROM coupons')) {
          return [[{
            id: 9,
            used_count: state.usedCount,
            discount_value: state.couponValue,
          }], []];
        }
        if (sql.includes('UPDATE coupons')) {
          state.couponValue = params[0];
          state.couponActive = params[1];
          return [{ affectedRows: 1 }, []];
        }
        if (sql.includes('UPDATE orders SET coupon_credit_reversed_amount')) {
          state.reversed = params[0];
          return [{ affectedRows: 1 }, []];
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
    };

    assert.equal(await updateCouponCreditReversal(connection, { orderId: 12, refundRatio: 0.25 }), 25);
    assert.equal(state.couponValue, 75);
    assert.equal(await updateCouponCreditReversal(connection, { orderId: 12, refundRatio: 0.25 }), 0);
    assert.equal(await updateCouponCreditReversal(connection, { orderId: 12, refundRatio: 0.5 }), 25);
    assert.equal(state.couponValue, 50);
    assert.equal(state.reversed, 50);
  });

  it('adds an incremental offset when the credit coupon was already used', async () => {
    const state = { reversed: 0, amountDue: 0 };
    const connection = {
      query: async (sql, params) => {
        if (sql.includes('SELECT user_id, coupon_credit_awarded_amount')) {
          return [[{
            user_id: 7,
            coupon_credit_awarded_amount: 100,
            coupon_credit_reversed_amount: state.reversed,
          }], []];
        }
        if (sql.includes('SELECT id, used_count, discount_value FROM coupons')) {
          return [[{ id: 9, used_count: 1, discount_value: 100 }], []];
        }
        if (sql.includes('INSERT INTO coupon_credit_offsets')) {
          state.amountDue += params[2];
          return [{ affectedRows: 1 }, []];
        }
        if (sql.includes('UPDATE orders SET coupon_credit_reversed_amount')) {
          state.reversed = params[0];
          return [{ affectedRows: 1 }, []];
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
    };

    assert.equal(await updateCouponCreditReversal(connection, { orderId: 12, refundRatio: 0.2 }), 20);
    assert.equal(await updateCouponCreditReversal(connection, { orderId: 12, refundRatio: 0.5 }), 30);
    assert.equal(state.amountDue, 50);
    assert.equal(state.reversed, 50);
  });

  it('issues credit atomically when an online payment capture is confirmed', async () => {
    const state = { insertedCredit: 0, committed: false };
    const connection = {
      beginTransaction: async () => {},
      commit: async () => { state.committed = true; },
      rollback: async () => {},
      release: () => {},
      query: async (sql, params) => {
        if (sql.includes('INSERT IGNORE INTO razorpay_webhook_events')) {
          return [{ affectedRows: 1 }, []];
        }
        if (sql.includes('FROM orders') && sql.includes('WHERE payment_id = ?')) {
          return [[{
            id: 12,
            user_id: 7,
            total: '110.00',
            payment_status: 'pending',
            payment_mode: 'online',
            coupon_credit_eligible_subtotal: '100.00',
            coupon_credit_awarded_at: null,
          }], []];
        }
        if (sql.includes('UPDATE orders SET payment_status')) return [{ affectedRows: 1 }, []];
        if (sql.includes('SELECT id, discount_value FROM coupons')) return [[], []];
        if (sql.includes('SELECT id, amount_due FROM coupon_credit_offsets')) return [[], []];
        if (sql.includes('INSERT INTO coupons')) {
          state.insertedCredit = params[2];
          return [{ insertId: 1 }, []];
        }
        if (sql.includes('SET coupon_credit_awarded_amount')) return [{ affectedRows: 1 }, []];
        throw new Error(`Unexpected query: ${sql}`);
      },
    };
    const pool = { getConnection: async () => connection };

    const result = await processRazorpayWebhook({
      pool,
      eventId: 'evt-credit-award',
      event: {
        event: 'payment.captured',
        payload: { payment: { entity: { id: 'pay-12', amount: 11000, currency: 'INR' } } },
      },
    });

    assert.deepEqual(result, { duplicate: false, updated: true });
    assert.equal(state.insertedCredit, 10);
    assert.equal(state.committed, true);
  });
});
