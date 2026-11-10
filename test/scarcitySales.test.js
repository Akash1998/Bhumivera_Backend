const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const calls = [];
const pool = {
  async query(sql, params) {
    calls.push({ sql, params });
    return [[{ id: 17, units_sold_today: 4 }]];
  },
};

const originalLoad = Module._load;
Module._load = function patched(request, ...rest) {
  if (request === '../config/db') return pool;
  return originalLoad.call(this, request, ...rest);
};
const { getTodayProductSales } = require('../services/scarcitySimulatorService');
Module._load = originalLoad;

test('today product sales return real paid and COD units with zeroes for products without orders', async () => {
  calls.length = 0;
  const result = await getTodayProductSales(['17', '18']);

  assert.match(result.dayKey, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(result.products, {
    17: { unitsOrdered: 4 },
    18: { unitsOrdered: 0 },
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /FROM_UNIXTIME\(\?\).*FROM_UNIXTIME\(\?\)/s);
  assert.match(calls[0].sql, /payment_status = 'paid' OR o\.payment_mode = 'COD'/);
  assert.match(calls[0].sql, /o\.status NOT IN \('cancelled', 'returned', 'archived'\)/);
  assert.deepEqual(calls[0].params.slice(2), ['17', '18']);
});

test('today product sales validates product identifiers before querying', async () => {
  calls.length = 0;
  await assert.rejects(getTodayProductSales(['0']), /valid product IDs/);
  assert.equal(calls.length, 0);
});
