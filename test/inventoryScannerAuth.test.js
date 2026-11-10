const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');
const express = require('express');
const Module = require('node:module');
const path = require('node:path');

const routesPath = path.resolve(__dirname, '../routes/inventorySoftwareRoutes.js');
const modelPath = path.resolve(__dirname, '../models/inventorySoftwareModel.js');
const originalLoad = Module._load;

const fakePool = {
  query: async sql => {
    if (/inventory_scanner_devices/.test(sql)) return [[]];
    if (/scanner_api_key FROM inventory_store_config/.test(sql)) return [[{ scanner_api_key: 'LEGACY-KEY' }]];
    return [[]];
  },
  end: async () => {},
};

Module._load = function (request, parent, isMain) {
  if (parent?.filename === routesPath && request === '../config/db') return fakePool;
  if (parent?.filename === routesPath && request === '../models/inventorySoftwareModel') {
    const real = originalLoad.call(this, request, parent, isMain);
    return { ...real, ensureInventorySoftwareTables: async () => {} };
  }
  return originalLoad.call(this, request, parent, isMain);
};

let server;
let baseUrl;

before(async () => {
  const router = require(routesPath);
  Module._load = originalLoad;
  const app = express();
  app.use(express.json());
  app.use('/api/inventory-software', router);
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}/api/inventory-software`;
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  // Route imports open background handles (cache/db) that would keep the runner alive.
  setTimeout(() => process.exit(process.exitCode || 0), 200).unref?.();
});

const post = (pathname, headers, body) =>
  fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

describe('inventory scanner authentication', () => {
  it('rejects an unknown scanner key', async () => {
    const res = await post('/scanner/scan', { 'x-scanner-api-key': 'WRONG' }, { qrCode: 'X' });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).code, 'INVALID_SCANNER_API_KEY');
  });

  it('keeps the legacy key restricted to the default terminal', async () => {
    const res = await post(
      '/scanner/scan',
      { 'x-scanner-api-key': 'LEGACY-KEY' },
      { qrCode: 'X', sessionCode: 'POS-OTHER' }
    );
    assert.equal(res.status, 403);
  });

  it('blocks the legacy key once it is disabled', async () => {
    process.env.INVENTORY_DISABLE_LEGACY_SCANNER_KEY = 'true';
    try {
      const res = await post('/scanner/scan', { 'x-scanner-api-key': 'LEGACY-KEY' }, { qrCode: 'X' });
      assert.equal(res.status, 401);
      assert.equal((await res.json()).code, 'LEGACY_SCANNER_KEY_DISABLED');
    } finally {
      delete process.env.INVENTORY_DISABLE_LEGACY_SCANNER_KEY;
    }
  });
});
