const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');
const express = require('express');
const { createRedisResponseCache } = require('../middleware/redisResponseCache');

class MemoryRedis {
  constructor() {
    this.entries = new Map();
  }

  async get(key) {
    return this.entries.get(key) || null;
  }

  async set(key, value, options) {
    assert.equal(options.EX, 60);
    this.entries.set(key, value);
  }
}

const redis = new MemoryRedis();
const app = express();
let publicRequestCount = 0;
let privateRequestCount = 0;
let server;
let baseUrl;

app.use(createRedisResponseCache(redis, {
  logger: { error: error => { throw error; } },
}));
app.get('/api/public', (_req, res) => {
  publicRequestCount += 1;
  res.json({ request: publicRequestCount });
});
app.get('/api/private-response', (_req, res) => {
  privateRequestCount += 1;
  res.set('Cache-Control', 'private, no-store').json({ request: privateRequestCount });
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
  it('serves the second anonymous public API request from Redis', async () => {
    const first = await fetch(`${baseUrl}/api/public`);
    const firstBody = await first.json();
    const second = await fetch(`${baseUrl}/api/public`);
    const secondBody = await second.json();

    assert.deepEqual(firstBody, { request: 1 });
    assert.deepEqual(secondBody, firstBody);
    assert.equal(first.headers.get('x-redis-cache'), 'MISS');
    assert.equal(second.headers.get('x-redis-cache'), 'HIT');
  });

  it('does not cache authenticated, cookie-bearing, or explicitly private responses', async () => {
    const authenticated = await fetch(`${baseUrl}/api/public`, {
      headers: { authorization: 'Bearer user-token' },
    });
    const cookieRequest = await fetch(`${baseUrl}/api/public`, {
      headers: { cookie: 'session=user-session' },
    });
    const privateFirst = await fetch(`${baseUrl}/api/private-response`);
    const privateSecond = await fetch(`${baseUrl}/api/private-response`);

    assert.equal(authenticated.headers.get('x-redis-cache'), null);
    assert.equal(cookieRequest.headers.get('x-redis-cache'), null);
    assert.equal(privateFirst.headers.get('x-redis-cache'), 'MISS');
    assert.equal(privateSecond.headers.get('x-redis-cache'), 'MISS');
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

  it('continues serving requests when Redis reads fail', async () => {
    const errors = [];
    const failingApp = express();
    failingApp.use(createRedisResponseCache({
      get: () => new Promise(() => {}),
      set: async () => {},
    }, {
      logger: { error: (...args) => errors.push(args) },
    }));
    failingApp.get('/api/public', (_req, res) => res.json({ available: true }));

    const failingServer = await new Promise(resolve => {
      const listeningServer = failingApp.listen(0, '127.0.0.1', () => resolve(listeningServer));
    });
    try {
      const response = await fetch(`http://127.0.0.1:${failingServer.address().port}/api/public`);
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
});
