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
};
const pass = (_req, _res, next) => next();
const mocks = new Map([
  ['../middleware/authMiddleware', { authenticateAdmin: pass }],
  ['../config/db', { query: async () => [[], []], appConfig: { connectionLimit: 2, maxIdle: 1, queueLimit: 100 } }],
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
  ['../middleware/redisResponseCache', { getResponseCacheStatus: () => ({
    status: 'connected',
    configured: true,
    ttlSeconds: 60,
    maxCacheableResponseBytes: 128 * 1024,
    metrics: { hits: 4, misses: 5, writes: 5, readErrors: 0, writeErrors: 0 },
  }) }],
  ['../utils/providerDiagnostics', {
    fetchRailwayHttpErrors: async () => ({}),
    fetchVercelDeploymentEvents: async () => ({}),
    fetchVercelRuntimeLogs: async () => ({}),
    getProviderConfiguration: () => ({}),
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
      connectionLimit: 2,
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
});
