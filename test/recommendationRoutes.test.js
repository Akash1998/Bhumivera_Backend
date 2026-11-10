const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');
const express = require('express');
const Module = require('node:module');
const path = require('node:path');

const originalLoad = Module._load;
const routePath = path.resolve(__dirname, '../routes/recommendationRoutes.js');
const state = {
  consent: { ad_personalization_opt_in: 0, ad_personalization_consent_version: null },
  productViews: 0,
  personalizationFlags: [],
};
const pool = {
  async query(sql) {
    if (sql.includes('FROM users')) return [[state.consent], []];
    if (sql.includes('FROM products')) return [[{ id: 3 }], []];
    throw new Error(`Unexpected query: ${sql}`);
  },
};
const mocks = new Map([
  ['../config/db', pool],
  ['../middleware/authMiddleware', {
    authenticateUser: (req, _res, next) => {
      req.user = { id: 17, role: 'customer' };
      next();
    },
  }],
  ['../models/productModel', { attachImages: async products => products }],
  ['../models/recommendationModel', {
    recordProductView: async () => { state.productViews += 1; },
    getPersonalizedRecommendations: async (_userId, _productId, _limit, enabled) => {
      state.personalizationFlags.push(enabled);
      return { products: [{ id: 8 }], personalized: enabled };
    },
  }],
]);

Module._load = function (request, parent, isMain) {
  if (parent?.filename === routePath && mocks.has(request)) return mocks.get(request);
  return originalLoad.call(this, request, parent, isMain);
};
const recommendationRoutes = require(routePath);
Module._load = originalLoad;

const app = express();
app.use(express.json());
app.use('/recommendations', recommendationRoutes);
let server;
let baseUrl;

before(async () => {
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}/recommendations`;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
});

describe('recommendation route consent gate', () => {
  it('does not record views or use customer signals without current consent', async () => {
    const viewResponse = await fetch(`${baseUrl}/view`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ product_id: 3 }),
    });
    assert.equal(viewResponse.status, 204);
    assert.equal(state.productViews, 0);

    const response = await fetch(`${baseUrl}/for-you?product_id=3`);
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.personalized, false);
    assert.deepEqual(state.personalizationFlags, [false]);
  });

  it('records views and uses customer signals after the current consent is granted', async () => {
    state.consent = {
      ad_personalization_opt_in: 1,
      ad_personalization_consent_version: 'product-recommendations-v2',
    };

    const viewResponse = await fetch(`${baseUrl}/view`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ product_id: 3 }),
    });
    assert.equal(viewResponse.status, 204);
    assert.equal(state.productViews, 1);

    const response = await fetch(`${baseUrl}/for-you?product_id=3`);
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.personalized, true);
    assert.deepEqual(state.personalizationFlags, [false, true]);
  });
});
