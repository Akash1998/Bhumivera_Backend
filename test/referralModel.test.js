const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const Module = require('node:module');
const path = require('node:path');

const modelPath = path.resolve(__dirname, '../models/referralModel.js');
const originalLoad = Module._load;
const state = {};
const pool = {
  query: (...args) => state.poolQuery(...args),
  getConnection: (...args) => state.getConnection(...args),
};

process.env.JWT_SECRET = 'referral-model-tests-secret-long-enough-for-signing';
Module._load = function (request, parent, isMain) {
  if (parent?.filename === modelPath && request === '../config/db') return pool;
  if (parent?.filename === modelPath && request === '../utils/mail') {
    return { sendMail: async () => undefined };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const referralModel = require(modelPath);
Module._load = originalLoad;

describe('referral model', () => {
  it('returns the referral count separately from the referral list', async () => {
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    state.poolQuery = async sql => {
      if (sql.includes('SELECT id FROM referral_claims')) return [[ ], []];
      if (sql.includes('SELECT id FROM users WHERE id')) return [[{ id: 7 }], []];
      if (sql.includes('SELECT code FROM referral_codes')) return [[{ code: 'BV123456' }], []];
      if (sql.includes('SELECT link_expires_at')) return [[{ link_expires_at: expiresAt }], []];
      if (sql.includes('SELECT c.id, c.status')) return [[{ id: 12, status: 'approved', name: 'Friend' }], []];
      if (sql.includes('SELECT COUNT(*) AS referrals')) return [[{
        referrals: 1,
        wallet_earned: '1000.00',
        rewarded_referrals: 1,
        pending_referrals: 0,
      }], []];
      if (sql.includes('SELECT * FROM referral_settings')) return [[{ reward_mode: 'wallet' }], []];
      throw new Error(`Unexpected query: ${sql}`);
    };

    const result = await referralModel.getReferralSummary(7);
    assert.equal(result.referralCount, 1);
    assert.equal(result.referrals.length, 1);
    assert.equal(result.referrals[0].name, 'Friend');
    assert.equal(result.wallet_earned, 1000);
    assert.match(result.referralUrl, /\/register\?ref=/);
  });

  it('repairs a missing wallet balance without duplicating an existing referral credit', async () => {
    const queries = [];
    state.poolQuery = async sql => {
      if (sql.includes('SELECT id FROM referral_claims')) return [[{ id: 12 }], []];
      throw new Error(`Unexpected pool query: ${sql}`);
    };
    state.getConnection = async () => ({
      beginTransaction: async () => undefined,
      commit: async () => undefined,
      rollback: async () => undefined,
      release: () => undefined,
      query: async (sql, params) => {
        queries.push({ sql, params });
        if (sql.includes('SELECT * FROM referral_claims')) {
          return [[{ id: 12, referrer_user_id: 7, status: 'approved', wallet_amount: '1000.00', coupon_code: null }], []];
        }
        if (sql.includes('SELECT id FROM wallet_transactions')) return [[{ id: 22 }], []];
        if (sql.includes('SELECT w.balance, u.wallet_balance')) {
          return [[{ balance: '0.00', wallet_balance: '0.00' }], []];
        }
        if (sql.includes('SUM(CASE WHEN type')) return [[{ balance: '1000.00' }], []];
        return [{ affectedRows: 1 }, []];
      },
    });

    await referralModel.reconcileReferralRewards(7);

    assert.ok(queries.some(({ sql, params }) =>
      sql.includes('UPDATE wallets SET balance = ?') && params[0] === 1000
    ), JSON.stringify(queries));
    assert.ok(queries.some(({ sql, params }) =>
      sql.includes('UPDATE users SET wallet_balance = GREATEST') && params[0] === 1000
    ));
    assert.equal(queries.filter(({ sql }) => sql.includes('INSERT INTO wallet_transactions')).length, 0);
  });

  it('issues restricted referral credit without a separate spending coupon', async () => {
    const queries = [];
    state.poolQuery = async sql => {
      if (sql.includes('SELECT id, name, email FROM users')) return [[
        { id: 7, name: 'Referrer', email: 'referrer@example.com' },
        { id: 8, name: 'Friend', email: 'friend@example.com' },
      ], []];
      throw new Error(`Unexpected pool query: ${sql}`);
    };
    state.getConnection = async () => ({
      beginTransaction: async () => undefined,
      commit: async () => undefined,
      rollback: async () => undefined,
      release: () => undefined,
      query: async (sql, params) => {
        queries.push({ sql, params });
        if (sql.includes('SELECT *, (auto_approve_at')) {
          return [[{
            id: 12,
            referred_user_id: 8,
            referrer_user_id: 7,
            status: 'pending',
          }], []];
        }
        if (sql.includes('SELECT * FROM referral_settings')) {
          return [[{
            enabled: 1,
            reward_mode: 'wallet_coupon',
            wallet_reward_amount: '500.00',
            wallet_reward_per_order_limit: '100.00',
            coupon_discount_type: 'fixed',
            coupon_discount_value: '100.00',
            coupon_min_order_amount: '500.00',
            coupon_valid_days: 30,
          }], []];
        }
        return [{ affectedRows: 1, insertId: 1 }, []];
      },
    });

    const result = await referralModel.decideReferralClaim(12, 'approved', 3);

    assert.equal(result.walletAmount, 500);
    assert.equal(result.couponCode, null);
    assert.equal(result.walletBucket, 'referral');
    assert.equal(result.status, 'approved');
    assert.ok(queries.some(({ sql, params }) =>
      sql.includes('UPDATE referral_wallets SET balance = balance + ?') && params[0] === 500
    ));
    assert.ok(queries.some(({ sql, params }) =>
      sql.includes('INSERT INTO referral_wallet_transactions') && params[1] === 500 && params[2] === 'referral-claim-12'
    ));
    assert.equal(queries.some(({ sql }) => sql.includes('INSERT INTO coupons')), false);
  });
});
