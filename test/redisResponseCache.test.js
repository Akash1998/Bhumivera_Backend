const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');
const express = require('express');
const { createRedisResponseCache, purgePublicResponseCache } = require('../middleware/redisResponseCache');

class MemoryRedis {
  constructor() {
    this.entries = new Map();
  }

  async get(key) {
    return this.entries.get(key) || null;
  }

  async set(key, value, options) {
    assert.equal(options.EX, 900);
    this.entries.set(key, value);
  }

  async *scanIterator({ MATCH }) {
    const prefix = MATCH.replace(/\*$/, '');
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) yield key;
    }
  }

  async del(keys) {
    return keys.filter(key => this.entries.delete(key)).length;
  }
}

const redis = new MemoryRedis();
const app = express();
let publicRequestCount = 0;
let productDetailRequestCount = 0;
let privateRequestCount = 0;
let publicImpactRequestCount = 0;
let databaseGateRequestCount = 0;
let server;
let baseUrl;

app.use(createRedisResponseCache(redis, {
  logger: { error: error => { throw error; } },
}));
app.use((req, _res, next) => {
  if (req.path === '/api/products/active') databaseGateRequestCount += 1;
  next();
});
app.get('/api/products/active', (req, res) => {
  if (req.query.private === '1') {
    privateRequestCount += 1;
    return res.set('Cache-Control', 'private, no-store').json({ request: privateRequestCount });
  }
  if (req.query.vary === '1') return res.set('Vary', 'x-test-variant').json({ request: true });
  if (req.query.large === '1') return res.json({ payload: 'x'.repeat(1024 * 1024) });
  publicRequestCount += 1;
  res.json({ request: publicRequestCount });
});
app.get('/api/products/:id', (req, res) => {
  productDetailRequestCount += 1;
  res.json({ id: req.params.id, request: productDetailRequestCount });
});
app.get('/api/impact/public', (_req, res) => {
  publicImpactRequestCount += 1;
  res.json({ request: publicImpactRequestCount });
});
app.get('/api/search', (_req, res) => {
  publicRequestCount += 1;
  res.json({ request: publicRequestCount });
});
app.get('/api/affiliate/referral/preview', (_req, res) => {
  publicRequestCount += 1;
  res.json({ request: publicRequestCount });
});

before(async () => {
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

describe('Redis response cache', () => {
  it('purges only public response-cache namespaces and preserves rate-limit/session keys', async () => {
    const cacheStore = new MemoryRedis();
    cacheStore.isReady = true;
    cacheStore.entries.set('bhumivera:response-cache:v2:one', 'public');
    cacheStore.entries.set('bhumivera:response-cache:v1:old', 'old-public');
    cacheStore.entries.set('bhumivera:rate-limit:login:one', 'rate-limit');
    cacheStore.entries.set('session:user:one', 'session');

    const result = await purgePublicResponseCache(cacheStore);

    assert.deepEqual(result, { status: 'cleared', deletedEntries: 2 });
    assert.deepEqual([...cacheStore.entries.keys()].sort(), [
      'bhumivera:rate-limit:login:one',
      'session:user:one',
    ]);
  });

  it('serves the second anonymous public API request from Redis', async () => {
    const first = await fetch(`${baseUrl}/api/products/active`, {
      headers: { 'x-request-id': 'first-request' },
    });
    const firstBody = await first.json();
    const second = await fetch(`${baseUrl}/api/products/active`, {
      headers: { 'x-request-id': 'second-request' },
    });
    const secondBody = await second.json();

    assert.deepEqual(firstBody, { request: 1 });
    assert.deepEqual(secondBody, firstBody);
    assert.equal(first.headers.get('x-redis-cache'), 'MISS');
    assert.equal(second.headers.get('x-redis-cache'), 'HIT');
    assert.equal(first.headers.get('cache-control'), 'public, max-age=60, s-maxage=300, stale-while-revalidate=3600');
    assert.equal(second.headers.get('cache-control'), 'public, max-age=60, s-maxage=300, stale-while-revalidate=3600');
    assert.equal(databaseGateRequestCount, 1);
  });

  it('caches individual public product details by numeric ID', async () => {
    const first = await fetch(`${baseUrl}/api/products/123`);
    const firstBody = await first.json();
    const second = await fetch(`${baseUrl}/api/products/123`);

    assert.deepEqual(await second.json(), firstBody);
    assert.equal(first.headers.get('x-redis-cache'), 'MISS');
    assert.equal(second.headers.get('x-redis-cache'), 'HIT');
  });

  it('does not cache responses that vary by a header absent from the cache key', async () => {
    const first = await fetch(`${baseUrl}/api/products/active?vary=1`);
    const second = await fetch(`${baseUrl}/api/products/active?vary=1`);

    assert.equal(first.headers.get('x-redis-cache'), 'MISS');
    assert.equal(second.headers.get('x-redis-cache'), 'MISS');
  });

  it('does not cache authenticated, cookie-bearing, or explicitly private responses', async () => {
    const authenticated = await fetch(`${baseUrl}/api/products/active`, {
      headers: { authorization: 'Bearer user-token' },
    });
    const cookieRequest = await fetch(`${baseUrl}/api/products/active`, {
      headers: { cookie: 'session=user-session' },
    });
    const privateFirst = await fetch(`${baseUrl}/api/products/active?private=1`);
    const privateSecond = await fetch(`${baseUrl}/api/products/active?private=1`);

    assert.equal(authenticated.headers.get('x-redis-cache'), null);
    assert.equal(cookieRequest.headers.get('x-redis-cache'), null);
    assert.equal(privateFirst.headers.get('x-redis-cache'), 'MISS');
    assert.equal(privateSecond.headers.get('x-redis-cache'), 'MISS');
    assert.equal(authenticated.headers.get('cache-control'), null);
    assert.equal(cookieRequest.headers.get('cache-control'), null);
    assert.equal(privateFirst.headers.get('cache-control'), 'private, no-store');
    assert.equal(privateRequestCount, 2);
  });

  it('does not bypass route-level rate limiting on public search and referral preview', async () => {
    const searchFirst = await fetch(`${baseUrl}/api/search`);
    const searchSecond = await fetch(`${baseUrl}/api/search`);
    const referralFirst = await fetch(`${baseUrl}/api/affiliate/referral/preview`);
    const referralSecond = await fetch(`${baseUrl}/api/affiliate/referral/preview`);

    for (const response of [searchFirst, searchSecond, referralFirst, referralSecond]) {
      assert.equal(response.headers.get('x-redis-cache'), null);
    }
    assert.equal(publicRequestCount, 7);
  });

  it('caches additional anonymous public content endpoints', async () => {
    const first = await fetch(`${baseUrl}/api/impact/public`);
    const second = await fetch(`${baseUrl}/api/impact/public`);

    assert.deepEqual(await first.json(), { request: 1 });
    assert.deepEqual(await second.json(), { request: 1 });
    assert.equal(first.headers.get('x-redis-cache'), 'MISS');
    assert.equal(second.headers.get('x-redis-cache'), 'HIT');
    assert.equal(publicImpactRequestCount, 1);
  });

  it('skips caching a response larger than the configured per-entry memory cap', async () => {
    const entriesBefore = redis.entries.size;
    const response = await fetch(`${baseUrl}/api/products/active?large=1`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-redis-cache'), 'MISS');
    assert.equal(redis.entries.size, entriesBefore);
  });

  it('continues serving requests when Redis reads fail', async () => {
    const errors = [];
    const failingApp = express();
    failingApp.use(createRedisResponseCache({
      get: () => new Promise(() => {}),
      set: async () => {},
    }, {
      logger: { error: (...args) => errors.push(args) },
    }));
    failingApp.get('/api/products/active', (_req, res) => res.json({ available: true }));

    const failingServer = await new Promise(resolve => {
      const listeningServer = failingApp.listen(0, '127.0.0.1', () => resolve(listeningServer));
    });
    try {
      const response = await fetch(`http://127.0.0.1:${failingServer.address().port}/api/products/active`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { available: true });
      assert.equal(errors.length, 1);
      assert.match(errors[0][0], /RESPONSE_CACHE_READ_ERROR/);
      assert.match(errors[0][1], /timed out/);
    } finally {
      await new Promise((resolve, reject) =>
        failingServer.close(error => error ? reject(error) : resolve())
      );
    }
  });

  it('connects Redis before the database gate and bypasses the gate on a hit', async () => {
    const disconnectedRedis = new MemoryRedis();
    disconnectedRedis.isReady = false;
    let connectCalls = 0;
    let databaseGateCalls = 0;
    const lazyApp = express();
    lazyApp.use(createRedisResponseCache(disconnectedRedis, {
      connectClient: async () => {
        connectCalls += 1;
        disconnectedRedis.isReady = true;
      },
      logger: { error: error => { throw error; } },
    }));
    lazyApp.use((_req, _res, next) => {
      databaseGateCalls += 1;
      next();
    });
    lazyApp.get('/api/products/active', (_req, res) => res.json({ available: true }));

    const lazyServer = await new Promise(resolve => {
      const listeningServer = lazyApp.listen(0, '127.0.0.1', () => resolve(listeningServer));
    });
    try {
      const url = `http://127.0.0.1:${lazyServer.address().port}/api/products/active`;
      const first = await fetch(url);
      await first.json();
      await new Promise(resolve => setImmediate(resolve));
      const second = await fetch(url);

      assert.equal(first.headers.get('x-redis-cache'), 'MISS');
      assert.equal(second.headers.get('x-redis-cache'), 'HIT');
      assert.equal(connectCalls, 1);
      assert.equal(databaseGateCalls, 1);
    } finally {
      await new Promise((resolve, reject) =>
        lazyServer.close(error => error ? reject(error) : resolve())
      );
    }
  });
});
