const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  calculateShoppingWalletReward,
  issueOrderShoppingWalletReward,
  updateShoppingWalletRewardReversal,
} = require('../models/shoppingWalletRewardModel');
const { processRazorpayWebhook } = require('../services/razorpayWebhook');

describe('shopping wallet rewards', () => {
  it('calculates ten percent normally and adds the capped five-percent welcome bonus', () => {
    assert.equal(calculateShoppingWalletReward(1234.56), 123.46);
    assert.equal(calculateShoppingWalletReward(1000, true), 150);
    assert.equal(calculateShoppingWalletReward(10000, true), 500);
    assert.equal(calculateShoppingWalletReward(-1, true), 0);
  });

  it('credits new-customer wallet rewards after refund offsets', async () => {
    const state = { walletBalance: 30, walletCredit: 0, offsetDue: 20 };
    const connection = {
      query: async (sql, params) => {
        if (sql.includes('SELECT user_id, shopping_wallet_reward_amount')) return [[{
          user_id: 7,
          shopping_wallet_reward_amount: 0,
          shopping_wallet_reward_awarded_at: null,
        }], []];
        if (sql.includes('SELECT id FROM users WHERE id = ? FOR UPDATE')) return [[{ id: 7 }], []];
        if (sql.includes('SELECT COUNT(*) AS order_count')) return [[{ order_count: 0 }], []];
        if (sql.includes('SELECT id, amount_due FROM coupon_credit_offsets')) {
          return [[{ id: 2, amount_due: state.offsetDue }], []];
        }
        if (sql.includes('UPDATE coupon_credit_offsets')) {
          state.offsetDue -= params[0];
          return [{ affectedRows: 1 }, []];
        }
        if (sql.includes('INSERT IGNORE INTO referral_wallets')) return [{ affectedRows: 1 }, []];
        if (sql.includes('SELECT balance FROM referral_wallets')) return [[{ balance: state.walletBalance }], []];
        if (sql.includes('UPDATE referral_wallets')) {
          state.walletBalance = params[0];
          return [{ affectedRows: 1 }, []];
        }
        if (sql.includes('INSERT INTO referral_wallet_transactions')) {
          state.walletCredit = params[1];
          return [{ affectedRows: 1 }, []];
        }
        if (sql.includes('SET shopping_wallet_reward_amount')) return [{ affectedRows: 1 }, []];
        throw new Error(`Unexpected query: ${sql}`);
      },
    };

    assert.equal(await issueOrderShoppingWalletReward(connection, {
      userId: 7,
      orderId: 12,
      eligibleSubtotal: 1000,
    }), 130);
    assert.equal(state.walletCredit, 130);
    assert.equal(state.walletBalance, 160);
    assert.equal(state.offsetDue, 0);
  });

  it('reverses partial refunds incrementally and is idempotent', async () => {
    const state = { balance: 100, reversed: 0 };
    const connection = {
      query: async (sql, params) => {
        if (sql.includes('SELECT user_id, shopping_wallet_reward_amount')) return [[{
          user_id: 7,
          shopping_wallet_reward_amount: 100,
          shopping_wallet_reward_reversed_amount: state.reversed,
        }], []];
        if (sql.includes('INSERT IGNORE INTO referral_wallets')) return [{ affectedRows: 1 }, []];
        if (sql.includes('SELECT balance FROM referral_wallets')) return [[{ balance: state.balance }], []];
        if (sql.includes('UPDATE referral_wallets')) {
          state.balance = params[0];
          return [{ affectedRows: 1 }, []];
        }
        if (sql.includes('INSERT INTO referral_wallet_transactions')) return [{ affectedRows: 1 }, []];
        if (sql.includes('UPDATE orders SET shopping_wallet_reward_reversed_amount')) {
          state.reversed = params[0];
          return [{ affectedRows: 1 }, []];
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
    };

    assert.equal(await updateShoppingWalletRewardReversal(connection, { orderId: 12, refundRatio: 0.25 }), 25);
    assert.equal(state.balance, 75);
    assert.equal(await updateShoppingWalletRewardReversal(connection, { orderId: 12, refundRatio: 0.25 }), 0);
    assert.equal(await updateShoppingWalletRewardReversal(connection, { orderId: 12, refundRatio: 0.5 }), 25);
    assert.equal(state.balance, 50);
    assert.equal(state.reversed, 50);
  });

  it('offsets the future reward when a refunded wallet reward has already been spent', async () => {
    const state = { balance: 5, reversed: 0, offset: 0 };
    const connection = {
      query: async (sql, params) => {
        if (sql.includes('SELECT user_id, shopping_wallet_reward_amount')) return [[{
          user_id: 7,
          shopping_wallet_reward_amount: 100,
          shopping_wallet_reward_reversed_amount: state.reversed,
        }], []];
        if (sql.includes('INSERT IGNORE INTO referral_wallets')) return [{ affectedRows: 1 }, []];
        if (sql.includes('SELECT balance FROM referral_wallets')) return [[{ balance: state.balance }], []];
        if (sql.includes('UPDATE referral_wallets')) {
          state.balance = params[0];
          return [{ affectedRows: 1 }, []];
        }
        if (sql.includes('INSERT INTO referral_wallet_transactions')) return [{ affectedRows: 1 }, []];
        if (sql.includes('INSERT INTO coupon_credit_offsets')) {
          state.offset = params[2];
          return [{ affectedRows: 1 }, []];
        }
        if (sql.includes('UPDATE orders SET shopping_wallet_reward_reversed_amount')) {
          state.reversed = params[0];
          return [{ affectedRows: 1 }, []];
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
    };

    assert.equal(await updateShoppingWalletRewardReversal(connection, { orderId: 12, refundRatio: 0.2 }), 20);
    assert.equal(state.balance, 0);
    assert.equal(state.offset, 15);
  });

  it('credits the shopping wallet in the payment-capture transaction', async () => {
    const state = { balance: 0, reward: 0, committed: false };
    const connection = {
      beginTransaction: async () => {},
      commit: async () => { state.committed = true; },
      rollback: async () => {},
      release: () => {},
      query: async (sql, params) => {
        if (sql.includes('INSERT IGNORE INTO razorpay_webhook_events')) return [{ affectedRows: 1 }, []];
        if (sql.includes('FROM orders') && sql.includes('WHERE payment_id = ?')) return [[{
          id: 12,
          user_id: 7,
          total: '110.00',
          payment_status: 'pending',
          payment_mode: 'online',
          coupon_credit_eligible_subtotal: '100.00',
          shopping_wallet_reward_awarded_at: null,
        }], []];
        if (sql.includes('UPDATE orders SET payment_status')) return [{ affectedRows: 1 }, []];
        if (sql.includes('SELECT user_id, shopping_wallet_reward_amount')) return [[{
          user_id: 7,
          shopping_wallet_reward_amount: 0,
          shopping_wallet_reward_awarded_at: null,
        }], []];
        if (sql.includes('SELECT id FROM users WHERE id = ? FOR UPDATE')) return [[{ id: 7 }], []];
        if (sql.includes('SELECT COUNT(*) AS order_count')) return [[{ order_count: 0 }], []];
        if (sql.includes('SELECT id, amount_due FROM coupon_credit_offsets')) return [[], []];
        if (sql.includes('INSERT IGNORE INTO referral_wallets')) return [{ affectedRows: 1 }, []];
        if (sql.includes('SELECT balance FROM referral_wallets')) return [[{ balance: state.balance }], []];
        if (sql.includes('UPDATE referral_wallets')) {
          state.balance = params[0];
          return [{ affectedRows: 1 }, []];
        }
        if (sql.includes('INSERT INTO referral_wallet_transactions')) {
          state.reward = params[1];
          return [{ affectedRows: 1 }, []];
        }
        if (sql.includes('SET shopping_wallet_reward_amount')) return [{ affectedRows: 1 }, []];
        throw new Error(`Unexpected query: ${sql}`);
      },
    };

    const result = await processRazorpayWebhook({
      pool: { getConnection: async () => connection },
      eventId: 'evt-wallet-reward',
      event: {
        event: 'payment.captured',
        payload: { payment: { entity: { id: 'pay-12', amount: 11000, currency: 'INR' } } },
      },
    });

    assert.deepEqual(result, { duplicate: false, updated: true });
    assert.equal(state.reward, 15);
    assert.equal(state.balance, 15);
    assert.equal(state.committed, true);
  });
});
