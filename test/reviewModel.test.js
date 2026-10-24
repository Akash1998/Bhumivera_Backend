const assert = require('node:assert/strict');
const { after, describe, it } = require('node:test');
const pool = require('../config/db');
const { archiveReview, getReviewsByComboName } = require('../models/reviewModel');

after(async () => {
  await pool.end();
});

describe('database-backed review retention', () => {
  it('loads only approved reviews matching the selected regimen', async () => {
    const originalQuery = pool.query;
    let query;
    let values;
    pool.query = async (sql, params = []) => {
      query = sql;
      values = params;
      return [[{
        id: 14,
        combo_name: 'The Complete Botanical Daily Regimen',
        reviewer_name: 'Customer',
        rating: 5,
        is_approved: 1,
        created_at: '2026-01-02 12:00:00',
      }], []];
    };

    try {
      const reviews = await getReviewsByComboName('The Complete Botanical Daily Regimen');
      assert.equal(reviews.length, 1);
      assert.equal(reviews[0].reviewer_name, 'Customer');
      assert.match(query, /WHERE r\.combo_name = \? AND r\.is_approved = 1/);
      assert.deepEqual(values, ['The Complete Botanical Daily Regimen']);
    } finally {
      pool.query = originalQuery;
    }
  });

  it('archives reviews without deleting their database records or media', async () => {
    const originalQuery = pool.query;
    const statements = [];
    pool.query = async (sql, values = []) => {
      statements.push({ sql, values });
      if (sql.startsWith('SELECT id, product_id FROM reviews')) {
        return [[{ id: 900000000, product_id: 7 }], []];
      }
      return [{ affectedRows: 1 }, []];
    };

    try {
      assert.equal(await archiveReview(900000000), true);
    } finally {
      pool.query = originalQuery;
    }

    assert.match(statements[1].sql, /^UPDATE reviews SET is_approved = 0 WHERE id = \?$/);
    assert.deepEqual(statements[1].values, [900000000]);
    assert.equal(statements.some(({ sql }) => /DELETE FROM reviews/i.test(sql)), false);
  });
});
