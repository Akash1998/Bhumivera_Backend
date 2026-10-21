const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');
const express = require('express');
const { createHealthRouter } = require('../utils/healthRoutes');

describe('health routes', () => {
  let server;
  let baseUrl;
  let readiness;

  before(async () => {
    const app = express();
    readiness = { databaseReady: false, failure: { code: 'MIGRATION_FAILED' } };
    app.use('/health', createHealthRouter(() => readiness));
    await new Promise(resolve => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}/health`;
  });

  after(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  it('reports liveness independently from readiness and includes safe failure state', async () => {
    const live = await fetch(`${baseUrl}/live`);
    const ready = await fetch(`${baseUrl}/ready`);
    const legacyHealth = await fetch(baseUrl);

    assert.equal(live.status, 200);
    assert.deepEqual(await live.json(), { status: 'live' });
    assert.equal(ready.status, 503);
    assert.equal(legacyHealth.status, 503);
    assert.deepEqual(await ready.json(), {
      status: 'starting',
      databaseReady: false,
      failure: { code: 'MIGRATION_FAILED' },
    });
  });

  it('marks readiness healthy after successful database initialization', async () => {
    readiness = { databaseReady: true, failure: null };
    const ready = await fetch(`${baseUrl}/ready`);
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { status: 'ready', databaseReady: true });
  });
});
