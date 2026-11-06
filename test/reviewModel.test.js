const assert = require('node:assert/strict');
const { after, describe, it } = require('node:test');
const pool = require('../config/db');
const {
  archiveReview,
  deleteReviewPermanently,
  getAllReviews,
  getReviewsByProduct,
  getReviewsByComboName,
  getProductRatingSummary,
  getPublicCustomerStories,
  createReviewAsAdmin,
  updateReviewAsAdmin,
} = require('../models/reviewModel');

after(async () => {
  await pool.end();
});

describe('database-backed review retention', () => {
  it('preserves empty review results and reports database errors', async () => {
    const originalQuery = pool.query;
    const originalError = console.error;
    console.error = () => {};
    try {
      pool.query = async () => [[], []];
      assert.deepEqual(await getAllReviews(), []);
      assert.deepEqual(await getReviewsByProduct(1), []);
      assert.deepEqual(await getReviewsByComboName('Regimen'), []);
      assert.equal((await getProductRatingSummary(1)).total, 0);
      const failure = new Error('Database unavailable');
      pool.query = async () => { throw failure; };
      for (const load of [getAllReviews, () => getReviewsByProduct(1), () => getReviewsByComboName('Regimen'), getPublicCustomerStories]) {
        await assert.rejects(load(), failure);
      }
    } finally {
      pool.query = originalQuery;
      console.error = originalError;
    }
  });

  it('deletes only an existing review and propagates database failures', async () => {
    const originalQuery = pool.query;
    const statements = [];
    try {
      pool.query = async (sql, params) => {
        statements.push({ sql, params });
        if (sql.startsWith('SELECT id, product_id')) return [[{ id: 21, product_id: 1 }], []];
        return [{ affectedRows: 1 }, []];
      };
      assert.equal(await deleteReviewPermanently(21), true);
      assert.match(statements[1].sql, /^DELETE FROM reviews WHERE id = \?$/);
      assert.deepEqual(statements[1].params, [21]);
      assert.match(statements[2].sql, /IFNULL\(ROUND\(AVG\(rating\), 2\), 0\)/);
      pool.query = async () => [[], []];
      assert.equal(await deleteReviewPermanently(999), false);
      const failure = new Error('Delete failed');
      pool.query = async sql => {
        if (sql.startsWith('SELECT')) return [[{ id: 21, product_id: 1 }], []];
        throw failure;
      };
      await assert.rejects(deleteReviewPermanently(21), failure);
    } finally {
      pool.query = originalQuery;
    }
  });
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

  it('does not report an update as successful when the database write fails', async () => {
    const originalQuery = pool.query;
    const originalError = console.error;
    const failure = new Error('Update failed');
    console.error = () => {};
    pool.query = async sql => {
      if (sql.startsWith('SELECT * FROM reviews WHERE id')) {
        return [[{ id: 7, product_id: 1, rating: 5, is_approved: 1 }], []];
      }
      throw failure;
    };
    try {
      await assert.rejects(updateReviewAsAdmin(7, { rating: 4 }), failure);
    } finally {
      pool.query = originalQuery;
      console.error = originalError;
    }
  });
});
