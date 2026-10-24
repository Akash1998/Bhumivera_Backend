const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { describe, it } = require('node:test');

const orderModelPath = path.resolve(__dirname, '../models/orderModel.js');
const originalLoad = Module._load;
let insertedOrderValues;
let bundleScenario = null;
const insertedOrderItems = [];
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
    if (sql.startsWith('SELECT id, name, sku, price, discount_price, quantity') && bundleScenario) {
      return [[{
        id: 900,
        name: bundleScenario.name,
        sku: bundleScenario.sku,
        price: bundleScenario.mrpTotal,
        discount_price: bundleScenario.bundlePrice,
        quantity: 4,
        specifications: bundleScenario.specifications,
      }], []];
    }
    if (sql.startsWith('SELECT id, slug, name, sku, price, discount_price, quantity')) {
      const component = bundleScenario.components.find(item => item.slug === values[0]);
      return [[component ? { ...component } : null].filter(Boolean), []];
    }
    if (sql.startsWith('SELECT quantity FROM products WHERE slug')) {
      return [[{ quantity: bundleScenario.stock.get(values[0]) }], []];
    }
    if (sql.startsWith('SELECT id, name, sku, price, discount_price, quantity')) {
      return [[{ name: 'Test product', sku: 'TEST-1', price: 100, discount_price: 0, quantity: 5 }], []];
    }
    if (sql.startsWith('INSERT INTO orders')) {
      insertedOrderValues = values;
      return [{ insertId: 77 }, []];
    }
    if (sql.startsWith('UPDATE products SET quantity = quantity -') && bundleScenario) {
      const component = bundleScenario.components.find(item => item.id === values[1]);
      bundleScenario.stock.set(component.slug, bundleScenario.stock.get(component.slug) - values[0]);
      return [{ affectedRows: 1 }, []];
    }
    if (sql.startsWith('INSERT INTO order_items')) {
      insertedOrderItems.push(values);
      return [{ affectedRows: 1 }, []];
    }
    if (sql.startsWith('UPDATE products')) {
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

  it('reserves every bundle component and stores component lines at the bundle price', async () => {
    const components = [
      { slug: 'himalayan-seabuckthorn-luxury-face-wash', id: 12, name: 'Sea Buckthorn Wash', sku: 'BV-SB', price: 799, discount_price: 0, quantity: 4 },
      { slug: 'luxury-2-in-1-botanical-shampoo-conditioner', id: 13, name: 'Botanical Shampoo', sku: 'BV-SH', price: 899, discount_price: 0, quantity: 4 },
      { slug: 'artisanal-aloe-vera-handmade-soap', id: 15, name: 'Aloe Neem Soap', sku: 'BV-AN', price: 349, discount_price: 0, quantity: 4 },
    ];
    const stock = new Map(components.map(component => [component.slug, component.quantity]));
    bundleScenario = {
      name: 'The Complete Botanical Daily Regimen',
      sku: 'BV-BND-DAILY-01',
      mrpTotal: 2047,
      bundlePrice: 1499,
      components,
      stock,
      specifications: {
        product_type: 'bundle',
        bundle_id: 'bundle-daily-regimen',
        components: components.map(({ slug }) => ({ slug })),
      },
    };
    insertedOrderItems.length = 0;

    try {
      await createOrder({
        userId: 1,
        items: [{ product_id: 900, quantity: 1 }],
        paymentMode: 'COD',
        paymentStatus: 'pending',
      });
    } finally {
      bundleScenario = null;
    }

    assert.equal(insertedOrderItems.length, 3);
    assert.equal(insertedOrderItems.reduce((total, values) => total + Number(values[4]), 0), 1499);
    assert.ok(components.every(component => stock.get(component.slug) === 3));
  });
});
