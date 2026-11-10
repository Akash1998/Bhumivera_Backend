const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const calls = { count: 0, down: false };
const fakeConn = {
  beginTransaction: async () => {},
  commit: async () => {},
  rollback: async () => {},
  release: () => {},
  query: async sql => {
    calls.count += 1;
    if (calls.down) throw new Error('db asleep');
    if (/SELECT value FROM settings/.test(sql)) return [[{ value: null }]];
    return [[]];
  },
};
const fakePool = {
  query: async sql => {
    calls.count += 1;
    if (calls.down) throw new Error('db asleep');
    if (/FROM products/.test(sql)) return [[{ id: 1 }, { id: 2 }]];
    return [[]];
  },
  getConnection: async () => {
    calls.count += 1;
    if (calls.down) throw new Error('db asleep');
    return fakeConn;
  },
};

const originalLoad = Module._load;
Module._load = function patched(request, ...rest) {
  if (request === '../config/db') return fakePool;
  return originalLoad.call(this, request, ...rest);
};
const service = require('../services/scarcitySimulatorService');
Module._load = originalLoad;

test('public snapshots do not touch the DB after the first warm-up', async () => {
  const first = await service.getPublicSnapshots(['1', '2']);
  assert.ok(first.products['1']);
  const warmCount = calls.count;
  assert.ok(warmCount > 0);

  for (let i = 0; i < 20; i += 1) await service.getPublicSnapshots(['1', '2']);
  for (let i = 0; i < 20; i += 1) await service.getTodaysBestsellers();
  const afterBestsellers = calls.count;

  for (let i = 0; i < 20; i += 1) await service.getPublicSnapshots(['1', '2']);
  assert.equal(calls.count, afterBestsellers, 'cached public reads must not query the DB');
});

test('public snapshots still work when the DB is down', async () => {
  calls.down = true;
  const data = await service.getPublicSnapshots(['1', '2']);
  assert.equal(typeof data.products['1'].simulatedSoldToday, 'number');
});
