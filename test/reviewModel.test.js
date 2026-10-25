const assert = require('node:assert/strict');
const { after, describe, it } = require('node:test');
const pool = require('../config/db');
const { INITIAL_REVIEWS_SEED } = require('../data/bhumiveraReviewsData');
const {
  archiveReview,
  getReviewsByComboName,
  getReviewsByProduct,
  createReviewAsAdmin,
  updateReviewAsAdmin,
  deleteReviewPermanently,
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

  it('contains 1500 authentic reviews with exact 2020-2026 yearly distribution across all 6 products and 3 combos', async () => {
    assert.equal(INITIAL_REVIEWS_SEED.length, 1500);
    const byYear = {};
    const byStyle = {};
    for (const r of INITIAL_REVIEWS_SEED) {
      const yr = String(r.created_at).slice(0, 4);
      byYear[yr] = (byYear[yr] || 0) + 1;
      byStyle[r.review_style] = (byStyle[r.review_style] || 0) + 1;
    }
    assert.deepEqual(byYear, {
      '2020': 90,
      '2021': 120,
      '2022': 180,
      '2023': 200,
      '2024': 260,
      '2025': 300,
      '2026': 350,
    });
    assert.deepEqual(byStyle, {
      short: 300,
      regional: 450,
      marketplace: 300,
      typo_casual: 300,
      heavy_long: 150,
    });

    for (const pid of [1, 2, 3, 4, 5, 6]) {
      const revs = await getReviewsByProduct(pid, true);
      assert.ok(revs.length >= 210);
    }
    for (const comboName of [
      'The Complete Botanical Daily Regimen',
      'The Inside-Out Skin-Clearing & Cortisol Ritual',
      'The Grand Maison 6-Piece Apothecary Vault',
    ]) {
      const cRevs = await getReviewsByComboName(comboName);
      assert.ok(cRevs.length >= 120);
    }
  });

  it('supports full admin review creation, editing (date, rating, combo, location, order #, helpful count), and deletion', async () => {
    const created = await createReviewAsAdmin({
      product_id: 1,
      user_name: 'Subhajit Chatterjee',
      reviewer_location: 'Asansol, West Bengal',
      rating: 5,
      combo_name: 'The Inside-Out Skin-Clearing & Cortisol Ritual',
      title: 'Khub bhalo',
      body: 'Darun kaaj koreche.',
      created_at: '2024-05-10T10:00:00.000Z',
    });
    assert.ok(created.id > 3000);

    const updated = await updateReviewAsAdmin(created.id, {
      rating: 4,
      user_name: 'Subhajit C.',
      reviewer_location: 'Kolkata, West Bengal',
      combo_name: 'The Grand Maison 6-Piece Apothecary Vault',
      order_number: 'BV-2025-888888',
      helpful_count: 19,
      created_at: '2025-11-12T12:00:00.000Z',
      title: 'Updated title',
      body: 'Updated review text.',
    });
    assert.equal(updated.review.rating, 4);
    assert.equal(updated.review.user_name, 'Subhajit C.');
    assert.equal(updated.review.reviewer_location, 'Kolkata, West Bengal');
    assert.equal(updated.review.combo_name, 'The Grand Maison 6-Piece Apothecary Vault');
    assert.equal(updated.review.order_number, 'BV-2025-888888');
    assert.equal(updated.review.helpful_count, 19);
    assert.ok(updated.review.created_at.startsWith('2025-11-12'));

    await deleteReviewPermanently(created.id);
  });
});
