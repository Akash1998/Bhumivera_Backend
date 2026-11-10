const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const Module = require('node:module');
const path = require('node:path');

const modelPath = path.resolve(__dirname, '../models/couponModel.js');
const originalLoad = Module._load;
const state = {};
const pool = { query: (...args) => state.query(...args), end: async () => {} };

Module._load = function (request, parent, isMain) {
  if (parent?.filename === modelPath && request === '../config/db') return pool;
  if (parent?.filename === modelPath && request === './referralModel') {
    return {
      getReferralConfig: async () => {
        const [[settings]] = await pool.query('SELECT * FROM referral_settings WHERE id = 1');
        return {
          ...settings,
          referral_redemption_tiers: typeof settings?.referral_redemption_tiers === 'string'
            ? JSON.parse(settings.referral_redemption_tiers)
            : settings?.referral_redemption_tiers,
        };
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const couponModel = require(modelPath);
Module._load = originalLoad;

describe('referral wallet coupon validation', () => {
  it('uses at most the configured amount from referral balance for one eligible order', async () => {
    const queries = [];
    state.query = async (sql, params) => {
      queries.push({ sql, params });
      if (sql.includes('SELECT * FROM coupons')) {
        return [[{
          code: 'REFTEST',
          restricted_user_id: 7,
          is_active: 1,
          valid_from: null,
          expires_at: null,
          usage_limit: 10,
          used_count: 0,
          min_order_amount: 500,
          discount_value: 100,
          reward_type: 'referral_wallet',
          wallet_per_order_limit: 100,
        }], []];
      }
      if (sql.includes('FROM referral_wallets')) return [[{ balance: '1000.00' }], []];
      if (sql.includes('SELECT * FROM referral_settings')) return [[{
        referral_redemption_tiers: JSON.stringify([
          { min_order_amount: 700, referral_amount: 100 },
          { min_order_amount: 1100, referral_amount: 200 },
        ]),
      }], []];
      throw new Error(`Unexpected query: ${sql}`);
    };

    const result = await couponModel.validateCoupon('REFTEST', 999, 7);

    assert.equal(result.valid, true);
    assert.equal(result.discount, 100);
    assert.equal(result.referralWalletAmount, 100);
    assert.ok(queries.some(({ sql, params }) => sql.includes('FROM referral_wallets') && params[0] === 7));
  });

  it('does not allow a referral coupon to be used by a different customer', async () => {
    let walletBalanceRead = false;
    state.query = async sql => {
      if (sql.includes('SELECT * FROM coupons')) {
        return [[{
          code: 'REFTEST',
          restricted_user_id: 7,
          is_active: 1,
          valid_from: null,
          expires_at: null,
          usage_limit: 10,
          used_count: 0,
          min_order_amount: 0,
          reward_type: 'referral_wallet',
          wallet_per_order_limit: 100,
        }], []];
      }
      if (sql.includes('FROM referral_wallets')) walletBalanceRead = true;
      throw new Error(`Unexpected query: ${sql}`);
    };

    const result = await couponModel.validateCoupon('REFTEST', 999, 8);

    assert.equal(result.valid, false);
    assert.match(result.message, /assigned to a different customer/);
    assert.equal(walletBalanceRead, false);
  });

  it('accepts a free-shipping reward without turning it into a price discount', async () => {
    state.query = async sql => {
      if (sql.includes('SELECT * FROM coupons')) {
        return [[{
          code: 'SHIPTEST',
          restricted_user_id: 7,
          is_active: 1,
          valid_from: null,
          expires_at: null,
          usage_limit: 1,
          used_count: 0,
          min_order_amount: 500,
          discount_type: 'fixed',
          discount_value: 0,
          reward_type: 'free_shipping',
        }], []];
      }
      throw new Error(`Unexpected query: ${sql}`);
    };

    const result = await couponModel.validateCoupon('SHIPTEST', 999, 7);

    assert.equal(result.valid, true);
    assert.equal(result.discount, 0);
    assert.equal(result.coupon.reward_type, 'free_shipping');
  });

  it('blocks a customer from reusing the same storewide coupon once per_user_limit is reached', async () => {
    state.query = async sql => {
      if (sql.includes('SELECT * FROM coupons')) {
        return [[{
          id: 55,
          code: 'SAVE20',
          status: 'active',
          is_active: 1,
          discount_type: 'percentage',
          discount_value: 20,
          min_order_value: 500,
          max_discount: 300,
          usage_limit: 100,
          per_user_limit: 1,
          used_count: 1,
          reward_type: 'standard',
        }], []];
      }
      if (sql.includes('FROM coupon_redemptions')) {
        return [[{ cnt: 1 }], []];
      }
      if (sql.includes('FROM orders')) {
        return [[{ cnt: 1 }], []];
      }
      return [[], []];
    };

    await assert.rejects(
      () => couponModel.validateCoupon('SAVE20', 1200, 7),
      err => err.code === 'COUPON_USER_LIMIT_REACHED' && /already used coupon SAVE20/i.test(err.message)
    );
  });
});
