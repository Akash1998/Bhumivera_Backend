const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { describe, it } = require('node:test');

const orderModelPath = path.resolve(__dirname, '../models/orderModel.js');
const originalLoad = Module._load;
let insertedOrderValues;
const connection = {
  async beginTransaction() {},
  async commit() {},
  async rollback() {},
  release() {},
  async query(sql, values = []) {
    if (sql.startsWith('SELECT id FROM orders WHERE user_id')) return [[{ id: 1 }, { id: 2 }], []];
    if (sql.startsWith('SELECT pending_lifecycle_gift_product_id')) {
      return [[{ pending_lifecycle_gift_product_id: null, loyalty_points: 0, loyalty_lifetime_points: 0 }], []];
    }
    if (sql.startsWith('SELECT name, sku, price, discount_price, quantity')) {
      return [[{ name: 'Test product', sku: 'TEST-1', price: 100, discount_price: 0, quantity: 5 }], []];
    }
    if (sql.startsWith('INSERT INTO orders')) {
      insertedOrderValues = values;
      return [{ insertId: 77 }, []];
    }
    if (sql.startsWith('UPDATE products') || sql.startsWith('INSERT INTO order_items')) {
      return [{ affectedRows: 1 }, []];
    }
    throw new Error(`Unexpected order-model query: ${sql}`);
  },
};
const pool = { getConnection: async () => connection };

Module._load = function (request, parent, isMain) {
  if (parent?.filename === orderModelPath) {
    if (request === '../config/db') return pool;
    if (request === '../services/orderNumber') return { generateOrderNumber: () => '123456789' };
    if (request === '../services/orderPaymentPolicy') {
      return {
        assertCodEligibility: () => {},
        calculateTieredReferralWalletRedemption: () => 0,
        debitWalletForOrder: async () => {},
        COD_REQUIRED_DELIVERED_ORDERS: 2,
      };
    }
    if (request === '../services/loyaltyPolicy') {
      return {
        calculateTierDiscount: () => 0,
        calculateLoyaltyRedemption: () => ({ points: 0, discount: 0 }),
        calculateLoyaltyPointsAward: () => 123,
      };
    }
    if (request === './referralModel') return { getReferralConfig: async () => ({ referral_redemption_tiers: [] }) };
    if (request === './loyaltyTierModel') {
      return {
        getLoyaltyConfig: async () => ({
          enabled: true,
          redemption_points_per_rupee: 10,
          max_redemption_percent: 20,
          minimum_redemption_points: 100,
          points_per_rupee: 1,
        }),
        listLoyaltyTiers: async () => [],
        getLoyaltyTierForPoints: () => null,
      };
    }
    if (request === './shoppingWalletRewardModel') {
      return { issueOrderShoppingWalletReward: async () => {}, updateShoppingWalletRewardReversal: async () => {} };
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { createOrder } = require('../models/orderModel');
Module._load = originalLoad;

describe('order model', () => {
  it('stores the calculated loyalty points award when creating an order', async () => {
    insertedOrderValues = null;
    await createOrder({
      userId: 1,
      items: [{ product_id: 5, quantity: 1 }],
      paymentMode: 'COD',
      paymentStatus: 'pending',
    });

    assert.ok(insertedOrderValues, 'expected the order insert query to run');
    assert.equal(insertedOrderValues[9], 123);
  });
});
