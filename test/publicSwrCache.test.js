const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createPublicSwrCache } = require('../middleware/publicSwrCache');

const startApp = async () => {
  const hits = { products: 0, me: 0 };
  const app = express();
  let server;
  const cache = createPublicSwrCache({ getPort: () => server.address().port });
  app.use(cache);
  app.get('/api/products/active', (req, res) => {
    hits.products += 1;
    res.json({ n: hits.products });
  });
  app.get('/api/users/me', (req, res) => {
    hits.me += 1;
    res.json({ n: hits.me });
  });
  app.post('/api/products', (req, res) => res.json({ ok: true }));
  server = await new Promise(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, hits, cache, close: () => server.close() };
};

test('public GETs are served from cache without re-running the handler', async () => {
  const ctx = await startApp();
  try {
    const first = await fetch(`${ctx.base}/api/products/active`);
    assert.equal(first.headers.get('x-public-cache'), 'MISS');
    for (let i = 0; i < 10; i += 1) {
      const res = await fetch(`${ctx.base}/api/products/active`, { headers: { Authorization: 'Bearer x' } });
      assert.equal(res.headers.get('x-public-cache'), 'HIT');
      assert.deepEqual(await res.json(), { n: 1 });
    }
    assert.equal(ctx.hits.products, 1);

    await fetch(`${ctx.base}/api/users/me`);
    await fetch(`${ctx.base}/api/users/me`);
    assert.equal(ctx.hits.me, 2, 'non-allowlisted paths are never cached');
  } finally {
    ctx.close();
  }
});

test('successful writes flush the cache so admin edits show immediately', async () => {
  const ctx = await startApp();
  try {
    await fetch(`${ctx.base}/api/products/active`);
    await fetch(`${ctx.base}/api/products`, { method: 'POST' });
    const res = await fetch(`${ctx.base}/api/products/active`);
    assert.equal(res.headers.get('x-public-cache'), 'MISS');
    assert.deepEqual(await res.json(), { n: 2 });
  } finally {
    ctx.close();
  }
});

test('stale entries are served instantly and refreshed in the background', async () => {
  const realNow = Date.now;
  const ctx = await startApp();
  try {
    await fetch(`${ctx.base}/api/products/active`);
    const offset = 31 * 60 * 1000;
    Date.now = () => realNow() + offset;
    const stale = await fetch(`${ctx.base}/api/products/active`);
    assert.equal(stale.headers.get('x-public-cache'), 'STALE');
    assert.deepEqual(await stale.json(), { n: 1 });
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(ctx.hits.products, 2, 'background refresh ran once');
    const fresh = await fetch(`${ctx.base}/api/products/active`);
    assert.equal(fresh.headers.get('x-public-cache'), 'HIT');
    assert.deepEqual(await fresh.json(), { n: 2 });
  } finally {
    Date.now = realNow;
    ctx.close();
  }
});
