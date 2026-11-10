const assert = require('node:assert/strict');
const { after, describe, it } = require('node:test');
const pool = require('../config/db');
const { getPersonalizedRecommendations } = require('../models/recommendationModel');

describe('product recommendation consent gate', () => {
  after(async () => {
    await pool.end();
  });

  it('uses popular products only when personalization is not enabled', async () => {
    const originalQuery = pool.query;
    const statements = [];
    pool.query = async sql => {
      statements.push(sql);
      return [[{ id: 8 }], []];
    };

    try {
      const result = await getPersonalizedRecommendations(17, 3, 8, false);
      assert.equal(result.personalized, false);
      assert.deepEqual(result.products, [{ id: 8 }]);
      assert.equal(statements.length, 1);
      assert.doesNotMatch(statements[0], /WITH user_signals|FROM wishlist|FROM user_product_views/i);
      assert.doesNotMatch(statements[0], /FROM orders/i);
    } finally {
      pool.query = originalQuery;
    }
  });

  it('uses customer signals only when personalization is enabled', async () => {
    const originalQuery = pool.query;
    const statements = [];
    pool.query = async sql => {
      statements.push(sql);
      return [[{ id: 8 }], []];
    };

    try {
      const result = await getPersonalizedRecommendations(17, 3, 8, true);
      assert.equal(result.personalized, true);
      assert.deepEqual(result.products, [{ id: 8 }]);
      assert.match(statements[0], /WITH user_signals/);
      assert.match(statements[0], /FROM orders/);
      assert.match(statements[0], /FROM wishlist/);
      assert.match(statements[0], /FROM user_product_views/);
    } finally {
      pool.query = originalQuery;
    }
  });
});
