const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { correctOutdatedSiteMetadata } = require('../utils/siteMetadataMigration');

describe('site metadata migration', () => {
  it('corrects only the exact outdated electronics defaults without overwriting custom settings', async () => {
    const calls = [];
    const pool = {
      async query(sql, params) {
        calls.push({ sql, params });
        return [{ affectedRows: 1 }];
      },
    };

    await correctOutdatedSiteMetadata(pool);

    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map(call => call.params), [
      ['Botanical skincare shaped by plant science and crafted for everyday rituals.'],
      ['botanical skincare, plant-based skincare, Bhumivera'],
    ]);
    assert.ok(calls.every(call => call.sql.includes('value = \'Best electronics at best prices\'') ||
      call.sql.includes('value = \'electronics, gadgets, Bhumivera\'')));
  });
});
