const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');
const express = require('express');
const { createRequestObservability } = require('../middleware/requestObservability');

describe('request observability', () => {
  let server;
  let baseUrl;
  const entries = [];
  let clock = 100;

  before(async () => {
    const app = express();
    app.use(createRequestObservability({
      createRequestId: () => 'request-test-id',
      now: () => {
        clock += 17;
        return clock;
      },
      logger: {
        info: entry => entries.push(JSON.parse(entry)),
        error: entry => entries.push(JSON.parse(entry)),
      },
    }));
    app.get('/health/live', (req, res) => {
      assert.equal(req.requestId, 'request-test-id');
      res.json({ status: 'live' });
    });
    app.get('/error', (req, res) => res.status(503).json({ error: true }));
    await new Promise(resolve => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  it('returns a request ID and logs a bounded structured event without query secrets', async () => {
    const response = await fetch(`${baseUrl}/health/live?token=do-not-log`);
    assert.equal(response.headers.get('x-request-id'), 'request-test-id');
    await response.json();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(entries.at(-1), {
      event: 'http.request',
      requestId: 'request-test-id',
      method: 'GET',
      path: '/health/live',
      statusCode: 200,
      durationMs: 17,
    });
  });

  it('logs server failures at error level', async () => {
    const response = await fetch(`${baseUrl}/error`);
    assert.equal(response.status, 503);
    await response.json();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(entries.at(-1).statusCode, 503);
  });
});
