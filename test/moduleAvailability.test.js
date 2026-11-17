const assert = require('node:assert/strict');
const { after, it } = require('node:test');
const pool = require('../config/db');
const { createModuleAvailabilityMiddleware } = require('../utils/moduleAvailability');

after(async () => {
  await pool.end();
});

it('allows public checkout config through when affiliate routes are paused', async () => {
  const middleware = createModuleAvailabilityMiddleware(
    'affiliate',
    req => req.method !== 'GET' || req.path !== '/program-config'
  );
  let continued = false;

  await middleware(
    { method: 'GET', path: '/program-config' },
    {
      setHeader() {},
      status() {
        throw new Error('Public checkout config should not be blocked.');
      },
      json() {
        throw new Error('Public checkout config should not be blocked.');
      },
    },
    () => { continued = true; }
  );

  assert.equal(continued, true);
});
