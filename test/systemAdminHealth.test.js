const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');
const express = require('express');
const Module = require('node:module');
const path = require('node:path');

const routePath = path.resolve(__dirname, '../routes/systemAdminRoutes.js');
const originalLoad = Module._load;
const originalEnvironment = {
  MAILRELAY_API_KEY: process.env.MAILRELAY_API_KEY,
  RAZORPAY_KEY_ID: process.env.RAZORPAY_KEY_ID,
  RAZORPAY_KEY_SECRET: process.env.RAZORPAY_KEY_SECRET,
};
Object.assign(process.env, {
  MAILRELAY_API_KEY: 'test-mail-configured',
  RAZORPAY_KEY_ID: 'test-payment-configured',
  RAZORPAY_KEY_SECRET: 'test-payment-secret',
});

const state = {
  serverErrorCount: 2,
  errorCountsByPath: { '/api/orders': 2 },
  cachePurgeCalls: 0,
};
const pass = (_req, _res, next) => next();
const mocks = new Map([
  ['../middleware/authMiddleware', { authenticateAdmin: pass }],
  ['../config/db', { query: async () => [[], []], appConfig: { connectionLimit: 3, maxIdle: 1, queueLimit: 100 } }],
  ['../utils/mail', { getMailMetrics: () => ({ acceptedCount: 0, failedCount: 0, recipientCount: 0 }) }],
  ['../middleware/requestObservability', {
    getRequestMetrics: () => ({
      windowMinutes: 15,
      serverErrorCount: state.serverErrorCount,
      errorCountsByPath: state.errorCountsByPath,
      requestCount: 20,
      serverErrorRatePercent: 10,
      recentRequests: [],
      recentServerErrors: [],
    }),
  }],
  ['../middleware/rateLimiter', { getRateLimitStoreStatus: () => ({ status: 'process_local', configured: false, sharedAcrossInstances: false }) }],
  ['../middleware/redisResponseCache', {
    getResponseCacheStatus: () => ({
      status: 'connected',
      configured: true,
      ttlSeconds: 60,
      maxCacheableResponseBytes: 1024 * 1024,
      metrics: { hits: 4, misses: 5, writes: 5, readErrors: 0, writeErrors: 0 },
    }),
    purgePublicResponseCache: async () => {
      state.cachePurgeCalls += 1;
      return { status: 'cleared', deletedEntries: 4 };
    },
    publishPublicCachePurge: async () => ({ status: 'published', recipients: 2 }),
  }],
  ['../utils/providerDiagnostics', {
    fetchRailwayHttpErrors: async () => ({}),
    fetchVercelDeploymentEvents: async () => ({}),
    fetchVercelRuntimeLogs: async () => ({}),
    getProviderConfiguration: () => ({}),
    purgeVercelCdnCache: async () => ({ status: 'cleared', target: 'production', scope: 'entire_project' }),
  }],
  ['../utils/moduleAvailability', {
    getModuleStates: async () => [],
    isKnownModule: () => true,
    setModuleEnabled: async () => {},
  }],
]);

Module._load = function (request, parent, isMain) {
  if (parent?.filename === routePath && mocks.has(request)) return mocks.get(request);
  return originalLoad.call(this, request, parent, isMain);
};
const systemAdminRoutes = require(routePath);
Module._load = originalLoad;

const app = express();
app.locals.publicSwrCache = {
  clear: () => ({ entries: 3, bytes: 2048 }),
};
app.use('/admin/system', systemAdminRoutes);
let server;
let baseUrl;

before(async () => {
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}/admin/system/health`;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('admin health overview', () => {
  it('reports the exact 5xx cause without treating process-local limits as degraded', async () => {
    const response = await fetch(baseUrl);
    const health = await response.json();
    assert.equal(response.status, 200);
    assert.equal(health.status, 'degraded');
    assert.deepEqual(health.healthIssues.map(issue => issue.code), ['RECENT_SERVER_ERRORS']);
    assert.match(health.healthIssues[0].message, /Most affected paths: \/api\/orders \(2\)/);
    assert.equal(health.services.rateLimits.status, 'process_local');
    assert.equal(health.services.responseCache.status, 'connected');
    assert.deepEqual(health.databaseUsage, {
      connectionLimit: 3,
      maxIdleConnections: 1,
      queueLimit: 100,
    });
  });

  it('reports healthy when no degrading condition is present', async () => {
    state.serverErrorCount = 0;
    state.errorCountsByPath = {};
    const response = await fetch(baseUrl);
    const health = await response.json();
    assert.equal(response.status, 200);
    assert.equal(health.status, 'healthy');
    assert.deepEqual(health.healthIssues, []);
  });

  it('purges public caches while preserving authentication and saved user data', async () => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/admin/system/cache/purge`, {
      method: 'POST',
    });
    const result = await response.json();

    assert.equal(response.status, 200);
    assert.equal(result.success, true);
    assert.equal(result.layers.redis.deletedEntries, 4);
    assert.equal(result.layers.processMemory.entries, 3);
    assert.equal(result.layers.vercel.scope, 'entire_project');
    assert.equal(result.layers.backendInstances.recipients, 2);
    assert.deepEqual(result.preserves, [
      'authentication and sessions',
      'rate limits',
      'database records',
      'carts and wishlists',
    ]);
    assert.equal(state.cachePurgeCalls, 1);
  });
});
