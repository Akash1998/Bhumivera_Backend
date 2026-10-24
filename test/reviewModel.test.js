const assert = require('node:assert/strict');
const { after, describe, it } = require('node:test');
const pool = require('../config/db');
const { archiveReview } = require('../models/reviewModel');

after(async () => {
  await pool.end();
});

describe('database-backed review retention', () => {
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
