const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');
const express = require('express');
const { normalizeErrorResponses, requestErrorHandler } = require('../utils/errorReporting');

describe('request error handling', () => {
  let server;
  let baseUrl;

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use(normalizeErrorResponses);
    app.use(requestErrorHandler);

    await new Promise(resolve => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    const serverClosed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await serverClosed;
  });

  it('returns a client error for malformed JSON request bodies', async () => {
    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{email:invalid-json}',
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.code, 'INVALID_JSON_BODY');
    assert.equal(body.message, 'Request body must be valid JSON.');
  });
});
