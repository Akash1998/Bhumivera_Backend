const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createDefaultConfig,
  createDefaultProduct,
  getDailyTarget,
  getIstDayInfo,
  getIstDayRange,
  getProductSnapshot,
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

test('default illustrative lifetime totals and daily target use the requested ranges', () => {
  const product = createDefaultProduct(42);
  const target = getDailyTarget('2026-10-25', 42, product);
  assert.ok(product.lifetimeSold >= 16000 && product.lifetimeSold <= 30000);
  assert.ok(target >= 200 && target <= 250);
});

test('pause and out-of-stock controls affect the simulator snapshot only', () => {
  const now = new Date('2026-10-25T12:00:00.000Z');
  const config = createDefaultConfig(now);
  config.products['42'] = {
    ...createDefaultProduct(42),
    lifetimeSold: 20000,
    paused: true,
  };
  const paused = getProductSnapshot(config, 42, now, 25);
  assert.equal(paused.paused, true);
  assert.equal(paused.soldToday, 0);
  assert.equal(paused.lifetimeSold, 20000);

  config.products['42'].paused = false;
  config.products['42'].outOfStock = true;
  const soldOut = getProductSnapshot(config, 42, now, 25);
  assert.equal(soldOut.outOfStock, true);
  assert.equal(soldOut.remaining, 0);
  assert.equal(soldOut.soldToday, 0);
});

test('day rollover carries the illustrative completed target into the simulated lifetime total', () => {
  const config = createDefaultConfig(new Date('2026-10-24T18:00:00.000Z'));
  config.dayKey = '2026-10-24';
  config.products['42'] = {
    ...createDefaultProduct(42),
    lifetimeSold: 20000,
    dailyCap: 250,
    minDailySold: 200,
    maxDailySold: 250,
  };

  const changed = rotateConfigDay(config, new Date('2026-10-24T18:30:00.000Z'));
  assert.equal(changed, true);
  assert.equal(config.dayKey, '2026-10-25');
  assert.ok(config.products['42'].lifetimeSold >= 20200);
  assert.ok(config.products['42'].lifetimeSold <= 20250);
  assert.equal(rotateConfigDay(config, new Date('2026-10-24T19:00:00.000Z')), false);
});

test('real eligible orders lower only the simulator display and are included in its labeled total', () => {
  const now = new Date('2026-10-25T12:00:00.000Z');
  const config = createDefaultConfig(now);
  config.products['42'] = {
    ...createDefaultProduct(42),
    dailyCap: 250,
    minDailySold: 200,
    maxDailySold: 250,
  };

  const withoutOrder = getProductSnapshot(config, 42, now);
  const withOrder = getProductSnapshot(config, 42, now, 1);

  assert.equal(withOrder.remaining, withoutOrder.remaining - 1);
  assert.equal(withOrder.lifetimeSold, withoutOrder.lifetimeSold + 1);
});

test('real orders are counted in the daily rollover without exceeding the simulated cap', () => {
  const config = createDefaultConfig(new Date('2026-10-24T18:00:00.000Z'));
  config.dayKey = '2026-10-24';
  config.products['42'] = {
    ...createDefaultProduct(42),
    lifetimeSold: 20000,
    dailyCap: 250,
    minDailySold: 200,
    maxDailySold: 250,
  };
  const target = getDailyTarget('2026-10-24', 42, config.products['42']);

  rotateConfigDay(config, new Date('2026-10-24T18:30:00.000Z'), { 42: 20 });

  assert.equal(config.products['42'].lifetimeSold, 20000 + Math.min(250, target + 20));
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
        lifetimeSold: 20000,
      },
    },
  };

  assert.match(validateSimulatorConfig(config), /Invalid simulator settings for product 42/);
});

test('simulator rejects daily targets below 200 when the visual cap allows at least 200', () => {
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
        lifetimeSold: 20000,
      },
    },
  };

  assert.match(validateSimulatorConfig(config), /Invalid simulator settings for product 42/);
});
