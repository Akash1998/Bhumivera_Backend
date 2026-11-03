const assert = require('node:assert/strict');
const { after, describe, it } = require('node:test');
const pool = require('../config/db');
const {
  archiveReview,
  getReviewsByComboName,
  createReviewAsAdmin,
  updateReviewAsAdmin,
} = require('../models/reviewModel');

after(async () => {
  await pool.end();
});

describe('database-backed review retention & 1500+ authentic pan-India reviews (2020-2026)', () => {
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

  it('creates reviews in the database only and returns the generated id', async () => {
    const originalQuery = pool.query;
    const statements = [];
    pool.query = async (sql, values = []) => {
      statements.push({ sql, values });
      if (/^INSERT INTO reviews/i.test(sql)) return [{ insertId: 1501 }, []];
      return [{ affectedRows: 1 }, []];
    };

    try {
      const created = await createReviewAsAdmin({
        product_id: 1,
        user_name: 'Subhajit Chatterjee',
        reviewer_location: 'Asansol, West Bengal',
        rating: 5,
        title: 'Khub bhalo',
        body: 'Darun kaaj koreche.',
        created_at: '2024-05-10T10:00:00.000Z',
      });
      assert.equal(created.id, 1501);
      assert.equal(statements.some(({ sql }) => /^INSERT INTO reviews\s*\(\s*id,/i.test(sql)), false);
    } finally {
      pool.query = originalQuery;
    }
  });

  it('updates an existing database review and reports removed media', async () => {
    const originalQuery = pool.query;
    let updateSql;
    pool.query = async (sql) => {
      if (sql.startsWith('SELECT * FROM reviews WHERE id')) {
        return [[{ id: 7, product_id: 1, rating: 5, images: '["reviews/a.jpg","reviews/b.jpg"]', is_approved: 1 }], []];
      }
      if (sql.startsWith('UPDATE reviews SET')) updateSql = sql;
      return [{ affectedRows: 1 }, []];
    };

    try {
      const updated = await updateReviewAsAdmin(7, { rating: 4, images: ['reviews/a.jpg'] });
      assert.equal(updated.review.rating, 4);
      assert.deepEqual(updated.removedImages, ['reviews/b.jpg']);
      assert.match(updateSql, /rating = \?/);
      pool.query = async () => [[], []];
      assert.equal(await updateReviewAsAdmin(999, { rating: 3 }), false);
    } finally {
      pool.query = originalQuery;
    }
  });
});
