const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');
const express = require('express');
const {
  accountNetworkKey,
  createLimiter,
  createRedisCommand,
  getLoginIpKey,
  loginLimiter,
  otpRequestLimiter,
  otpVerificationLimiter,
} = require('../middleware/rateLimiter');

const app = express();
app.use(express.json());
app.post('/login-test', loginLimiter, (req, res) => {
  if (req.body.error) return res.status(503).json({ error: true });
  return res.status(req.body.success ? 200 : 401).json({ success: Boolean(req.body.success) });
});

let server;
let baseUrl;

before(async () => {
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}/login-test`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

const post = (url, body) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

describe('authentication rate limiting', () => {
  it('connects Redis before issuing commands from rate-limit store initialization', async () => {
    let isReady = false;
    const client = {
      sendCommand: async args => {
        assert.equal(isReady, true);
        return args.join(' ');
      },
    };
    const command = createRedisCommand(client, async () => {
      await Promise.resolve();
      isReady = true;
    });

    assert.equal(await command('SCRIPT', 'LOAD', 'return 1'), 'SCRIPT LOAD return 1');
  });

  it('does not count successful logins and returns a useful Retry-After after failures', async () => {
    const email = `rate-limit-${Date.now()}@example.com`;
    const sendAttempt = success => post(baseUrl, { email, success });

    for (let attempt = 0; attempt < 7; attempt += 1) {
      assert.equal((await sendAttempt(true)).status, 200);
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      assert.equal((await post(baseUrl, { email, error: true })).status, 503);
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.equal((await sendAttempt(false)).status, 401);
    }

    const limited = await sendAttempt(false);
    const body = await limited.json();
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    assert.equal(Number(limited.headers.get('retry-after')), body.retryAfterSeconds);
    assert.ok(limited.headers.get('ratelimit-limit'));
    assert.equal(body.code, 'LOGIN_ATTEMPTS_LIMIT');
    assert.equal((await sendAttempt(false)).status, 429);
    assert.ok(Number((await sendAttempt(false)).headers.get('retry-after')) > 0);
  });

  it('isolates account limits by normalized account and network', async () => {
    const sharedEmail = `isolation-${Date.now()}@example.com`;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.equal((await post(baseUrl, { email: sharedEmail, success: false })).status, 401);
    }
    assert.equal((await post(baseUrl, { email: `other-${sharedEmail}`, success: false })).status, 401);

    const normalizedA = accountNetworkKey({ body: { email: '  Admin@Example.com ' }, ip: '192.0.2.10' });
    const normalizedB = accountNetworkKey({ body: { email: 'admin@example.com' }, ip: '192.0.2.10' });
    assert.equal(normalizedA, normalizedB);
    assert.notEqual(normalizedA, accountNetworkKey({
      body: { email: 'admin@example.com' },
      ip: '192.0.2.11',
    }));
  });

  it('uses the same network key for IPv4-mapped IPv6 and groups native IPv6 to /56', () => {
    assert.equal(getLoginIpKey('::ffff:192.0.2.4'), getLoginIpKey('192.0.2.4'));
    assert.equal(getLoginIpKey('2001:db8:1234:5600::1'), getLoginIpKey('2001:db8:1234:56ff::9'));
    assert.notEqual(getLoginIpKey('2001:db8:1234:5600::1'), getLoginIpKey('2001:db8:1234:5700::1'));
  });

  it('separates OTP issuance throttles from failed OTP verification throttles', async () => {
    const otpApp = express();
    otpApp.use(express.json());
    otpApp.post('/request', otpRequestLimiter, (_req, res) => res.status(200).end());
    otpApp.post('/verify', otpVerificationLimiter, (req, res) => {
      res.status(req.body.valid ? 200 : 401).end();
    });
    const otpServer = await new Promise(resolve => {
      const listeningServer = otpApp.listen(0, '127.0.0.1', () => resolve(listeningServer));
    });
    const otpBaseUrl = `http://127.0.0.1:${otpServer.address().port}`;
    try {
      const account = `otp-${Date.now()}@example.com`;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        assert.equal((await post(`${otpBaseUrl}/request`, { email: account })).status, 200);
      }
      const requestLimited = await post(`${otpBaseUrl}/request`, { email: account });
      assert.equal(requestLimited.status, 429);
      assert.equal((await requestLimited.json()).code, 'OTP_REQUEST_LIMIT');
      assert.equal((await post(`${otpBaseUrl}/request`, { email: `another-${account}` })).status, 200);

      for (let attempt = 0; attempt < 12; attempt += 1) {
        assert.equal((await post(`${otpBaseUrl}/verify`, { email: account, valid: true })).status, 200);
      }
      for (let attempt = 0; attempt < 10; attempt += 1) {
        assert.equal((await post(`${otpBaseUrl}/verify`, { email: account, valid: false })).status, 401);
      }
      const verificationLimited = await post(`${otpBaseUrl}/verify`, { email: account, valid: false });
      assert.equal(verificationLimited.status, 429);
      assert.equal((await verificationLimited.json()).code, 'OTP_VERIFICATION_LIMIT');
    } finally {
      await new Promise((resolve, reject) =>
        otpServer.close(error => error ? reject(error) : resolve())
      );
    }
  });

  it('shares counters across separate application instances with a shared store', async () => {
    class SharedMemoryStore {
      constructor(sharedHits) {
        this.hits = sharedHits;
      }

      init() {}

      async increment(key) {
        const now = Date.now();
        let entry = this.hits.get(key);
        if (!entry || entry.resetTime <= now) {
          entry = { totalHits: 0, resetTime: now + 60_000 };
        }
        entry.totalHits += 1;
        this.hits.set(key, entry);
        return { totalHits: entry.totalHits, resetTime: new Date(entry.resetTime) };
      }

      async decrement(key) {
        const entry = this.hits.get(key);
        if (entry) entry.totalHits = Math.max(0, entry.totalHits - 1);
      }

      async resetKey(key) {
        this.hits.delete(key);
      }
    }

    const sharedHits = new Map();
    const createInstance = async () => {
      const instance = express();
      instance.use(express.json());
      instance.post('/login', createLimiter('shared-store-test', {
        windowMs: 60_000,
        max: 1,
        keyGenerator: req => accountNetworkKey(req),
        code: 'SHARED_STORE_LIMIT',
        message: 'Request throttled.',
        store: new SharedMemoryStore(sharedHits),
      }), (_req, res) => res.status(401).end());
      const instanceServer = await new Promise(resolve => {
        const listeningServer = instance.listen(0, '127.0.0.1', () => resolve(listeningServer));
      });
      return {
        url: `http://127.0.0.1:${instanceServer.address().port}/login`,
        close: () => new Promise((resolve, reject) =>
          instanceServer.close(error => error ? reject(error) : resolve())
        ),
      };
    };

    const first = await createInstance();
    const second = await createInstance();
    try {
      const email = `shared-${Date.now()}@example.com`;
      assert.equal((await post(first.url, { email })).status, 401);
      const blockedAcrossInstance = await post(second.url, { email });
      assert.equal(blockedAcrossInstance.status, 429);
      assert.equal((await blockedAcrossInstance.json()).code, 'SHARED_STORE_LIMIT');
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });
});
