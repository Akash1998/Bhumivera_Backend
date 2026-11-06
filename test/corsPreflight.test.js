const assert = require('node:assert/strict');
const { before, after, describe, it } = require('node:test');

process.env.NODE_ENV = 'test';
process.env.VERCEL = '1';
process.env.FRONTEND_ORIGINS = 'https://www.bhumivera.com';

const app = require('../server');
let server;
let checkoutUrl;

before(async () => {
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  checkoutUrl = `http://127.0.0.1:${server.address().port}/api/inventory-software/pos/checkout`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await require('../config/db').end();
});

describe('POS checkout CORS preflight', () => {
  const requestedHeaders = ['authorization', 'content-type', 'idempotency-key', 'x-idempotency-key', 'x-client-platform'];
  const preflight = origin => fetch(checkoutUrl, {
    method: 'OPTIONS',
    headers: {
      origin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': requestedHeaders.join(','),
    },
  });

  it('allows the checkout headers for the configured storefront without initializing the database', async () => {
    const response = await preflight('https://www.bhumivera.com');
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://www.bhumivera.com');
    assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
    assert.ok(response.headers.get('access-control-allow-methods').split(',').map(value => value.trim()).includes('POST'));
    const allowedHeaders = response.headers.get('access-control-allow-headers')
      .split(',').map(value => value.trim().toLowerCase());
    for (const header of requestedHeaders) assert.ok(allowedHeaders.includes(header), `${header} must be allowed`);
    assert.equal(app.locals.isDatabaseReady(), false);
  });

  it('does not allow an unconfigured origin', async () => {
    const response = await preflight('https://example.com');
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  });
});
