const assert = require('node:assert/strict');
const { beforeEach, describe, it } = require('node:test');
const Module = require('node:module');
const path = require('node:path');

const modelPath = path.resolve(__dirname, '../models/welcomeGiftModel.js');
const queries = [];
let selectedCards = [];
let connectionCalls = 0;

const connection = {
  async beginTransaction() {
    queries.push({ sql: 'BEGIN' });
  },
  async commit() {
    queries.push({ sql: 'COMMIT' });
  },
  async rollback() {
    queries.push({ sql: 'ROLLBACK' });
  },
  release() {
    queries.push({ sql: 'RELEASE' });
  },
  async query(sql, params = []) {
    queries.push({ sql, params });
    if (sql.startsWith('SELECT id, status FROM welcome_gift_cards')) return [selectedCards];
    if (sql.startsWith('DELETE FROM welcome_gift_cards')) return [{ affectedRows: selectedCards.length }];
    return [{ affectedRows: 1 }];
  },
};

const fakePool = {
  async getConnection() {
    connectionCalls += 1;
    return connection;
  },
  async query(sql, params = []) {
    queries.push({ sql, params });
    return [[]];
  },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent?.filename === modelPath && request === '../config/db') return fakePool;
  if (parent?.filename === modelPath && request === './couponModel') return { createCouponTable: async () => {} };
  return originalLoad.call(this, request, parent, isMain);
};
const welcomeGiftModel = require(modelPath);
Module._load = originalLoad;

describe('welcome gift bulk card deletion', () => {
  beforeEach(() => {
    queries.length = 0;
    selectedCards = [];
    connectionCalls = 0;
  });

  it('rejects invalid IDs before opening a database connection', async () => {
    await assert.rejects(
      welcomeGiftModel.bulkDeleteUnclaimedCards(5, [0]),
      error => error.status === 400 && /invalid card ids/i.test(error.message)
    );
    assert.equal(connectionCalls, 0);
  });

  it('deletes only requested unclaimed cards and updates the campaign count atomically', async () => {
    selectedCards = [
      { id: 10, status: 'unclaimed' },
      { id: 11, status: 'unclaimed' },
    ];

    const result = await welcomeGiftModel.bulkDeleteUnclaimedCards(5, [10, 11]);

    assert.deepEqual(result, { count: 2 });
    assert.equal(queries.some(entry => entry.sql === 'COMMIT'), true);
    assert.equal(queries.some(entry => entry.sql === 'ROLLBACK'), false);
    const deletion = queries.find(entry => entry.sql.startsWith('DELETE FROM welcome_gift_cards'));
    assert.match(deletion.sql, /campaign_id = \? AND status = 'unclaimed'/);
    assert.deepEqual(deletion.params, [5, [10, 11]]);
    const countUpdate = queries.find(entry => entry.sql.startsWith('UPDATE welcome_gift_campaigns'));
    assert.deepEqual(countUpdate.params, [2, 5]);
  });

  it('rejects claimed cards and rolls back without deleting any cards', async () => {
    selectedCards = [
      { id: 10, status: 'unclaimed' },
      { id: 11, status: 'claimed' },
    ];

    await assert.rejects(
      welcomeGiftModel.bulkDeleteUnclaimedCards(5, [10, 11]),
      error => error.status === 409 && /only selected unclaimed cards/i.test(error.message)
    );
    assert.equal(queries.some(entry => entry.sql.startsWith('DELETE FROM welcome_gift_cards')), false);
    assert.equal(queries.some(entry => entry.sql === 'ROLLBACK'), true);
  });
});
