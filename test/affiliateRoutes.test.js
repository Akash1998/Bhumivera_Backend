const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');
const express = require('express');
const jwt = require('jsonwebtoken');
const Module = require('node:module');
const path = require('node:path');
const pool = require('../config/db');
const { closeRateLimitStore } = require('../middleware/rateLimiter');

const secret = 'affiliate-tests-only-secret-with-more-than-32-characters';
const authMiddlewarePath = path.resolve(__dirname, '../middleware/authMiddleware.js');
const originalLoad = Module._load;
process.env.JWT_SECRET = secret;

Module._load = function (request, parent, isMain) {
  if (parent?.filename === authMiddlewarePath && request === '../utils/sessionStore') {
    return { isSessionActive: async () => true };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const affiliateRoutes = require('../routes/affiliateRoutes');
Module._load = originalLoad;

const app = express();
app.use(express.json());
app.use('/api/affiliate', affiliateRoutes);

let server;
let baseUrl;

before(async () => {
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}/api/affiliate`;
});

after(async () => {
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await Promise.all([pool.end(), closeRateLimitStore()]);
});

const adminToken = jwt.sign({
  id: 7,
  email: 'admin@example.com',
  role: 'admin',
  sessionType: 'admin',
}, secret, { expiresIn: '5m', jwtid: 'affiliate-test-session' });

const request = (method, endpoint, authenticated = true) => fetch(`${baseUrl}${endpoint}`, {
  method,
  headers: authenticated ? { authorization: `Bearer ${adminToken}` } : {},
});

describe('affiliate routes', () => {
  it('requires administrator authentication for the partner management routes', async () => {
    assert.equal((await request('GET', '/partners', false)).status, 401);
    assert.equal((await request('GET', '/admin/partners', false)).status, 401);
  });

  it('rejects invalid promoter configuration before attempting persistence', async () => {
    const response = await request('PUT', '/admin/program-config');
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'INVALID_AFFILIATE_PROGRAM_CONFIG');
  });

  it('rejects malformed partner updates before attempting persistence', async () => {
    const response = await request('PATCH', '/admin/partners/not-an-id');
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'INVALID_PARTNER_UPDATE');
  });
});
