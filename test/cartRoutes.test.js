const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');
const express = require('express');
const Module = require('node:module');
const path = require('node:path');

const cartRoutesPath = path.resolve(__dirname, '../routes/cartRoutes.js');
const originalLoad = Module._load;
const nextTier = { id: 3, name: 'Silver', min_points: 100 };
const stubs = {
  '../middleware/authMiddleware': {
    authenticateUser: (req, _res, nextMiddleware) => {
      req.user = { id: 42 };
      nextMiddleware();
    },
  },
  '../config/db': {
    async query(sql) {
      if (sql.includes('loyalty_points, loyalty_lifetime_points')) {
        return [[{ loyalty_points: 20, loyalty_lifetime_points: 50 }], []];
      }
      if (sql.includes('SELECT balance FROM referral_wallets')) {
        return [[{ balance: 0 }], []];
      }
      throw new Error(`Unexpected cart route query: ${sql}`);
    },
  },
  '../models/cartModel': {
    getCartByUser: async () => [],
    upsertCartItem: async () => [],
    updateCartItemQuantity: async () => [],
    removeCartItem: async () => [],
    clearCart: async () => {},
    getCartTotal: async () => ({ items: [], total: 0 }),
  },
  '../models/cartRulesModel': { listCartRules: async () => [] },
  '../utils/cartRulesEngine': { evaluateCartRules: () => ({ totalDiscount: 0 }) },
  '../models/settingsModel': {
    getSetting: async key => ({
      enforce_cart_rule_minimum: '0',
      coupon_stack_policy: 'both',
      cart_abandonment_coupon_enabled: '0',
      cart_abandonment_coupon_delay_minutes: '30',
    })[key],
  },
  '../models/loyaltyTierModel': {
    getUserLoyaltyTier: async () => null,
    getLoyaltyConfig: async () => ({
      enabled: true,
      points_per_rupee: 1,
      redemption_points_per_rupee: 1,
      max_redemption_percent: 10,
      minimum_redemption_points: 1,
    }),
    listLoyaltyTiers: async () => [nextTier],
  },
  '../models/couponModel': { createCouponTable: async () => {} },
  '../models/referralModel': { getReferralConfig: async () => ({ referral_redemption_tiers: [] }) },
  '../services/orderPaymentPolicy': { calculateTieredReferralWalletRedemption: () => 0 },
};

Module._load = function (request, parent, isMain) {
  if (parent?.filename === cartRoutesPath && Object.hasOwn(stubs, request)) {
    return stubs[request];
  }
  return originalLoad.call(this, request, parent, isMain);
};
const cartRoutes = require('../routes/cartRoutes');
Module._load = originalLoad;

const app = express();
app.use('/api/cart', cartRoutes);

let server;
let baseUrl;

before(async () => {
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}/api/cart`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

describe('cart routes', () => {
  it('returns the next loyalty tier when loading the authenticated cart', async () => {
    const response = await fetch(baseUrl);
    assert.equal(response.status, 200);
    const cart = await response.json();
    assert.deepEqual(cart.loyalty.nextTier, nextTier);
  });
});
