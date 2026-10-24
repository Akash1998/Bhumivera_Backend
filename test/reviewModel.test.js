const assert = require('node:assert/strict');
const { after, describe, it } = require('node:test');
const { INITIAL_REVIEWS_SEED } = require('../data/bhumiveraReviewsData');
const pool = require('../config/db');
const { seedAllCustomerReviews } = require('../models/reviewModel');

after(async () => {
  await pool.end();
});

describe('database-backed review seed', () => {
  it('seeds missing reviews idempotently and syncs real product IDs', async () => {
    const seededOrderNumbers = new Set(INITIAL_REVIEWS_SEED.slice(0, 2).map(review => review.order_number));
    const inserts = [];
    const productUpdates = [];
    const productRows = INITIAL_REVIEWS_SEED
      .filter((review, index, all) => all.findIndex(item => item.product_slug === review.product_slug) === index)
      .map((review, index) => ({ id: index + 9, slug: review.product_slug }));
    const database = {
      async query(sql, values = []) {
        if (sql.includes('CREATE TABLE IF NOT EXISTS reviews')) return [{}, []];
        if (sql.startsWith('SHOW COLUMNS FROM reviews')) return [[{ Field: sql.split("'")[1] }], []];
        if (sql === 'SELECT id, slug FROM products') return [productRows, []];
        if (sql === 'SELECT id FROM users ORDER BY id LIMIT 1') return [[{ id: 17 }], []];
        if (sql.startsWith('SELECT order_number FROM reviews')) {
          return [[...seededOrderNumbers].filter(orderNumber => values.includes(orderNumber)).map(order_number => ({ order_number })), []];
        }
        if (sql.startsWith('INSERT IGNORE INTO reviews')) {
          inserts.push({ sql, values });
          seededOrderNumbers.add(values[3]);
          return [{ affectedRows: 1 }, []];
        }
        if (sql.trimStart().startsWith('UPDATE products p')) {
          productUpdates.push(values[0]);
          return [{ affectedRows: 1 }, []];
        }
        throw new Error(`Unexpected SQL in review seed test: ${sql}`);
      },
    };

    assert.equal(await seedAllCustomerReviews(database), INITIAL_REVIEWS_SEED.length - 2);
    assert.equal(inserts.length, INITIAL_REVIEWS_SEED.length - 2);
    assert.ok(inserts.every(({ sql }) => !sql.includes('(id, product_id')));
    assert.deepEqual(new Set(productUpdates), new Set(productRows.map(product => product.id)));

    inserts.length = 0;
    productUpdates.length = 0;
    assert.equal(await seedAllCustomerReviews(database), 0);
    assert.equal(inserts.length, 0);
    assert.deepEqual(new Set(productUpdates), new Set(productRows.map(product => product.id)));
  });
});
