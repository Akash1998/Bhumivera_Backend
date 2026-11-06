const assert = require('node:assert/strict');
const { after, describe, it } = require('node:test');
const pool = require('../config/db');
const { importBundledPendingReviews } = require('../models/reviewModel');
const bundled = require('../data/bundledPendingReviews.json');

after(async () => {
  await pool.end();
});

const makeConnection = ({ markers = 0, reviewCount = 0, slugs }) => {
  const calls = { inserts: [], committed: false, rolledBack: false, released: false };
  const slugList = slugs || [...new Set(bundled.map(r => r.product_slug))];
  return {
    calls,
    async query(sql, params) {
      if (/GET_LOCK/.test(sql)) return [[{ acquired: 1 }]];
      if (/FROM bhumivera_review_import_runs/.test(sql)) return [[{ total: markers }]];
      if (/COUNT\(\*\) AS total FROM reviews/.test(sql)) return [[{ total: reviewCount }]];
      if (/FROM products/.test(sql)) return [slugList.map((slug, i) => ({ id: i + 1, slug }))];
      if (/INSERT INTO reviews/.test(sql)) {
        calls.inserts.push(params[0]);
        return [{ affectedRows: params[0].length }];
      }
      return [{}];
    },
    async beginTransaction() {},
    async commit() { calls.committed = true; },
    async rollback() { calls.rolledBack = true; },
    release() { calls.released = true; },
  };
};

const withConnection = async (connection, run) => {
  const original = pool.getConnection;
  pool.getConnection = async () => connection;
  try {
    return await run();
  } finally {
    pool.getConnection = original;
  }
};

describe('bundled pending review import', () => {
  it('bundles 1500 reviews', () => {
    assert.equal(bundled.length, 1500);
  });

  it('imports all rows as pending in one commit', async () => {
    const connection = makeConnection({});
    const result = await withConnection(connection, () => importBundledPendingReviews());
    assert.equal(result.imported, 1500);
    assert.equal(connection.calls.committed, true);
    const rows = connection.calls.inserts.flat();
    assert.equal(rows.length, 1500);
    assert.ok(rows.every(row => row[18] === 0 && row[17] === 0));
    assert.equal(connection.calls.released, true);
  });

  it('refuses to run twice or into a non-empty table', async () => {
    for (const options of [{ markers: 1 }, { reviewCount: 3 }]) {
      const connection = makeConnection(options);
      const result = await withConnection(connection, () => importBundledPendingReviews());
      assert.equal(result.imported, 0);
      assert.equal(connection.calls.inserts.length, 0);
      assert.equal(connection.calls.committed, false);
    }
  });

  it('aborts when a product slug is missing', async () => {
    const connection = makeConnection({ slugs: ['only-one'] });
    const result = await withConnection(connection, () => importBundledPendingReviews());
    assert.equal(result.imported, 0);
    assert.equal(connection.calls.inserts.length, 0);
  });
});
