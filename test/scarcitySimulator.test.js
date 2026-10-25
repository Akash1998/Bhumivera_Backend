const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createDefaultConfig,
  createDefaultProduct,
  getDailyTarget,
  getIstDayInfo,
  getIstDayRange,
  getProductSnapshot,
  normalizeStoredConfig,
  rotateConfigDay,
  validateSimulatorConfig,
} = require('../utils/scarcitySimulator');

test('daily simulation day follows the Asia/Kolkata midnight boundary', () => {
  const beforeMidnight = getIstDayInfo(new Date('2026-10-24T18:29:59.000Z'));
  const atMidnight = getIstDayInfo(new Date('2026-10-24T18:30:00.000Z'));

  assert.equal(beforeMidnight.dayKey, '2026-10-24');
  assert.equal(atMidnight.dayKey, '2026-10-25');
  assert.equal(getIstDayRange(new Date('2026-10-24T18:30:00.000Z')).start, '2026-10-24 18:30:00');
});

test('simulated stock decreases from 01:00 AM and reaches its daily target by 23:45 PM IST', () => {
  const config = createDefaultConfig(new Date('2026-10-25T00:00:00.000Z'));
  config.products['42'] = {
    ...createDefaultProduct(42),
    dailyCap: 250,
    minDailySold: 200,
    maxDailySold: 250,
  };
  const beforeStart = new Date('2026-10-24T19:00:00.000Z'); // 00:30 AM IST (before 01:00 AM)
  const midDay = new Date('2026-10-25T06:30:00.000Z'); // 12:00 PM Noon IST (mid decrease)
  const atTargetTime = new Date('2026-10-25T18:15:00.000Z'); // 23:45 PM IST (target reached)
  const afterTargetTime = new Date('2026-10-25T18:25:00.000Z'); // 23:55 PM IST (steady holding)

  const start = getProductSnapshot(config, 42, beforeStart);
  const midSnapshot = getProductSnapshot(config, 42, midDay);
  const atTarget = getProductSnapshot(config, 42, atTargetTime);
  const afterTarget = getProductSnapshot(config, 42, afterTargetTime);

  assert.equal(start.soldToday, 0);
  assert.ok(midSnapshot.soldToday > start.soldToday);
  assert.ok(atTarget.remaining < midSnapshot.remaining);
  assert.equal(atTarget.simulatedSoldToday, getDailyTarget(config.dayKey, 42, config.products['42']));
  assert.deepEqual(afterTarget, atTarget);
});

test('daily target changes on consecutive days and snapshots omit lifetime counters', () => {
  const config = createDefaultConfig(new Date('2026-10-25T06:30:00.000Z'));
  const product = { ...createDefaultProduct(42), dailyCap: 250, minDailySold: 0, maxDailySold: 250 };
  let previousTarget = null;

  for (let offset = 0; offset < 30; offset += 1) {
    const dayKey = new Date(Date.parse('2026-10-01T00:00:00Z') + offset * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const target = getDailyTarget(dayKey, 42, product);
    assert.ok(target >= 0 && target <= 250);
    if (previousTarget !== null) assert.notEqual(target, previousTarget);
    previousTarget = target;
  }

  config.products['42'] = product;
  const snapshot = getProductSnapshot(config, 42, new Date('2026-10-25T06:30:00.000Z'));
  assert.equal(Object.hasOwn(snapshot, 'lifetimeSold'), false);
});

test('sales progression follows anonymized hourly patterns from recent orders', () => {
  const config = createDefaultConfig(new Date('2026-10-25T06:30:00.000Z'));
  config.products['42'] = {
    ...createDefaultProduct(42),
    dailyCap: 250,
    minDailySold: 250,
    maxDailySold: 250,
  };
  const earlySalesPattern = [0, 50, 50, 50, ...Array(20).fill(0)];
  const lateSalesPattern = [...Array(20).fill(0), 50, 50, 50, 0];
  const testTime = new Date('2026-10-25T04:30:00.000Z'); // 10:00 AM IST
  const earlyWeighted = getProductSnapshot(
    config,
    42,
    testTime,
    earlySalesPattern
  );
  const lateWeighted = getProductSnapshot(
    config,
    42,
    testTime,
    lateSalesPattern
  );

  assert.ok(earlyWeighted.simulatedSoldToday > lateWeighted.simulatedSoldToday);
});

test('sample activity shows fictional shoppers only when explicitly enabled', () => {
  const now = new Date('2026-10-25T06:30:00.000Z');
  const config = createDefaultConfig(now);
  config.products['42'] = createDefaultProduct(42);

  const withoutSampleActivity = getProductSnapshot(config, 42, now);
  assert.deepEqual(withoutSampleActivity.sampleActivity, []);

  config.sampleActivityEnabled = true;
  const withSampleActivity = getProductSnapshot(config, 42, now);
  assert.equal(withSampleActivity.sampleActivity.length, 3);
  assert.ok(withSampleActivity.sampleActivity.every(activity =>
    /^Sample shopper #\d{3}$/.test(activity.buyer) &&
    ['Kolkata', 'Asansol', 'Delhi'].includes(activity.city) &&
    /^\d{1,2}:\d{2}\s?(am|pm)$/i.test(activity.time)
  ));
});

test('simulated remaining stock stays within configured daily capacity and is repeatable', () => {
  const now = new Date('2026-10-25T12:00:00.000Z');
  const config = createDefaultConfig(now);
  config.products['42'] = {
    ...createDefaultProduct(42),
    dailyCap: 250,
    minDailySold: 200,
    maxDailySold: 250,
  };

  const first = getProductSnapshot(config, 42, now);
  const second = getProductSnapshot(config, 42, now);

  assert.deepEqual(first, second);
  assert.ok(first.remaining >= 0 && first.remaining <= 250);
  assert.ok(first.soldToday >= 0 && first.soldToday <= 250);
  assert.match(first.label, /illustrative data, not live inventory or sales/);
});

test('default daily target can vary across the full daily cap', () => {
  const product = createDefaultProduct(42);
  const target = getDailyTarget('2026-10-25', 42, product);
  assert.ok(target >= 0 && target <= 250);
});

test('legacy default target settings migrate to the randomized 0–250 range', () => {
  const config = normalizeStoredConfig({
    enabled: true,
    products: {
      42: {
        enabled: true,
        paused: false,
        outOfStock: false,
        dailyCap: 250,
        minDailySold: 200,
        maxDailySold: 250,
      },
      43: {
        enabled: true,
        paused: false,
        outOfStock: false,
        dailyCap: 250,
        minDailySold: 175,
        maxDailySold: 230,
      },
    },
  });

  assert.equal(config.products['42'].minDailySold, 0);
  assert.equal(config.products['43'].minDailySold, 175);
});

test('pause and out-of-stock controls affect the simulator snapshot only', () => {
  const now = new Date('2026-10-25T12:00:00.000Z');
  const config = createDefaultConfig(now);
  config.products['42'] = {
    ...createDefaultProduct(42),
    paused: true,
  };
  const paused = getProductSnapshot(config, 42, now);
  assert.equal(paused.paused, true);
  assert.equal(paused.soldToday, 0);
  assert.equal(Object.hasOwn(paused, 'lifetimeSold'), false);

  config.products['42'].paused = false;
  config.products['42'].outOfStock = true;
  const soldOut = getProductSnapshot(config, 42, now);
  assert.equal(soldOut.outOfStock, true);
  assert.equal(soldOut.remaining, 0);
  assert.equal(soldOut.soldToday, 0);
});

test('day rollover resets the daily target without accumulating a lifetime counter', () => {
  const config = createDefaultConfig(new Date('2026-10-24T18:00:00.000Z'));
  config.dayKey = '2026-10-24';
  config.products['42'] = {
    ...createDefaultProduct(42),
    dailyCap: 250,
    minDailySold: 200,
    maxDailySold: 250,
  };

  const changed = rotateConfigDay(config, new Date('2026-10-24T18:30:00.000Z'));
  assert.equal(changed, true);
  assert.equal(config.dayKey, '2026-10-25');
  assert.equal(Object.hasOwn(config.products['42'], 'lifetimeSold'), false);
  assert.equal(rotateConfigDay(config, new Date('2026-10-24T19:00:00.000Z')), false);
});

test('daily simulation does not expose cumulative totals', () => {
  const now = new Date('2026-10-25T12:00:00.000Z');
  const config = createDefaultConfig(now);
  config.products['42'] = {
    ...createDefaultProduct(42),
    dailyCap: 250,
    minDailySold: 200,
    maxDailySold: 250,
  };

  const withoutOrder = getProductSnapshot(config, 42, now);
  const nextDayConfig = { ...config, dayKey: '2026-10-26' };
  const nextDay = getProductSnapshot(nextDayConfig, 42, new Date('2026-10-26T12:00:00.000Z'));
  assert.equal(Object.hasOwn(withoutOrder, 'lifetimeSold'), false);
  assert.equal(Object.hasOwn(nextDay, 'lifetimeSold'), false);
});

test('daily rollover does not create lifetime totals', () => {
  const config = createDefaultConfig(new Date('2026-10-24T18:00:00.000Z'));
  config.dayKey = '2026-10-24';
  config.products['42'] = {
    ...createDefaultProduct(42),
    dailyCap: 250,
    minDailySold: 200,
    maxDailySold: 250,
  };
  rotateConfigDay(config, new Date('2026-10-24T18:30:00.000Z'));

  assert.equal(Object.hasOwn(config.products['42'], 'lifetimeSold'), false);
});

test('simulator rejects caps that exceed the 250-unit visual limit', () => {
  const config = {
    enabled: true,
    sampleActivityEnabled: false,
    products: {
      42: {
        enabled: true,
        paused: false,
        outOfStock: false,
        dailyCap: 251,
        minDailySold: 200,
        maxDailySold: 250,
      },
    },
  };

  assert.match(validateSimulatorConfig(config), /Invalid simulator settings for product 42/);
});

test('simulator accepts randomized daily targets below 200', () => {
  const config = {
    enabled: true,
    sampleActivityEnabled: false,
    products: {
      42: {
        enabled: true,
        paused: false,
        outOfStock: false,
        dailyCap: 250,
        minDailySold: 199,
        maxDailySold: 250,
      },
    },
  };

  assert.equal(validateSimulatorConfig(config), null);
});
