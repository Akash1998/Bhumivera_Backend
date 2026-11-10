const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { NightSleepManager } = require('../middleware/nightSleepManager');

describe('NightSleepManager', () => {
  it('correctly calculates night window spanning midnight (22:00 to 06:00)', () => {
    const manager = new NightSleepManager({ startHour: 22, endHour: 6, timezone: 'Asia/Kolkata' });

    // 23:30 (11:30 PM) -> should be in window
    const lateNight = new Date('2026-10-25T18:00:00.000Z'); // 18:00 UTC = 23:30 IST (+5:30)
    assert.equal(manager.isSleeping(lateNight.getTime()), true);

    // 03:00 AM IST -> should be in window
    const earlyMorning = new Date('2026-10-25T21:30:00.000Z'); // 21:30 UTC = 03:00 IST (+5:30)
    assert.equal(manager.isSleeping(earlyMorning.getTime()), true);

    // 14:00 (2:00 PM IST) -> should NOT be in window
    const afternoon = new Date('2026-10-25T08:30:00.000Z'); // 08:30 UTC = 14:00 IST (+5:30)
    assert.equal(manager.isSleeping(afternoon.getTime()), false);
  });

  it('honors manual wake override during sleep hours', () => {
    const manager = new NightSleepManager({ startHour: 22, endHour: 6, timezone: 'Asia/Kolkata' });
    const lateNight = new Date('2026-10-25T18:00:00.000Z').getTime();

    assert.equal(manager.isSleeping(lateNight), true);

    // Wake for 30 minutes
    manager.wake(30 * 60 * 1000, 'test_wake');
    assert.equal(manager.isSleeping(Date.now()), false);

    // Clear overrides
    manager.resetSchedule();
    assert.equal(manager.isSleeping(lateNight), true);
  });

  it('middleware allows whitelisted paths during sleep', () => {
    const manager = new NightSleepManager({ startHour: 0, endHour: 24 }); // always asleep
    const middleware = manager.middleware();

    let nextCalled = false;
    const req = { path: '/api/system/sleep-status', get: () => undefined };
    const res = {};
    middleware(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, true);
  });

  it('middleware handles sleep response when path is not whitelisted', () => {
    const manager = new NightSleepManager({ startHour: 0, endHour: 24 }); // always asleep
    const middleware = manager.middleware();

    let jsonResponse = null;
    let statusCode = null;
    const headers = {};
    const req = { path: '/api/products', get: () => undefined };
    const res = {
      setHeader: (k, v) => { headers[k] = v; },
      status: (code) => {
        statusCode = code;
        return {
          json: (data) => { jsonResponse = data; },
        };
      },
    };

    middleware(req, res, () => {
      assert.fail('next() should not be called when sleeping');
    });

    assert.equal(statusCode, 200);
    assert.equal(jsonResponse.status, 'asleep');
    assert.equal(jsonResponse.code, 'NIGHT_SLEEP_ACTIVE');
    assert.equal(headers['X-Bhumivera-Status'], 'asleep');
  });

  it('middleware wakes on X-Bhumivera-Wake header', () => {
    const manager = new NightSleepManager({ startHour: 0, endHour: 24 }); // always asleep
    const middleware = manager.middleware();

    let nextCalled = false;
    const req = {
      path: '/api/products',
      get: (h) => (h === 'x-bhumivera-wake' ? 'true' : undefined),
    };
    const res = {};

    middleware(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(manager.isSleeping(), false);
  });
});
