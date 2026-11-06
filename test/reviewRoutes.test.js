const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');
const express = require('express');
const Module = require('node:module');
const path = require('node:path');

const routePath = path.resolve(__dirname, '../routes/reviewRoutes.js');
const originalLoad = Module._load;
const pass = (_req, _res, next) => next();
let deleteResult;
let listResult;
const mocks = new Map([
  ['../config/db', {}],
  ['../middleware/rateLimiter', { reviewLimiter: pass }],
  ['../middleware/authMiddleware', { authenticateUser: pass, authenticateAdmin: pass }],
  ['../config/s3Upload', {}],
  ['../data/luxuryCatalog', { MAISON_REGIMEN_BUNDLES: [] }],
  ['../models/reviewModel', {
    getAllReviews: async () => {
      if (listResult instanceof Error) throw listResult;
      return listResult;
    },
    deleteReviewPermanently: async () => {
      if (deleteResult instanceof Error) throw deleteResult;
      return deleteResult;
    },
  }],
]);

Module._load = function (request, parent, isMain) {
  if (parent?.filename === routePath && mocks.has(request)) return mocks.get(request);
  return originalLoad.call(this, request, parent, isMain);
};
let routes;
try {
  routes = require(routePath);
} finally {
  Module._load = originalLoad;
}

const app = express();
app.use('/api/reviews', routes);
let server;
let baseUrl;
before(async () => {
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}/api/reviews`;
});
after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

describe('admin review API results', () => {
  it('returns an empty database list as an empty list', async () => {
    listResult = [];
    const response = await fetch(baseUrl);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), []);
  });

  it('reports database read and deletion failures', async () => {
    const originalError = console.error;
    console.error = () => {};
    try {
      listResult = new Error('Read failed');
      assert.equal((await fetch(baseUrl)).status, 500);
      deleteResult = new Error('Delete failed');
      assert.equal((await fetch(`${baseUrl}/admin/21?permanent=true`, { method: 'DELETE' })).status, 500);
    } finally {
      console.error = originalError;
    }
  });

  it('distinguishes missing and successfully deleted records', async () => {
    deleteResult = false;
    assert.equal((await fetch(`${baseUrl}/admin/21?permanent=true`, { method: 'DELETE' })).status, 404);
    deleteResult = true;
    const response = await fetch(`${baseUrl}/admin/21?permanent=true`, { method: 'DELETE' });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).deleted, true);
  });
});
