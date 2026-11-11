const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');
const express = require('express');
const jwt = require('jsonwebtoken');
const Module = require('node:module');
const path = require('node:path');

const routesPath = path.resolve(__dirname, '../routes/inventorySoftwareRoutes.js');
const originalLoad = Module._load;
let failQuery = '';
let bootstrapItemQuery = '';
const fakePool = {
  query: async sql => {
    if (/inventory_staff_accounts WHERE id/.test(sql)) {
      return [[{ id: 1, username: 'test', role: 'admin', status: 'active' }]];
    }
    if (/SELECT m\.\*/.test(sql) && /FROM inventory_product_meta m/.test(sql)) {
      bootstrapItemQuery = sql;
    }
    if (failQuery === 'orders' && /FROM orders o/.test(sql)) throw new Error('orders unavailable');
    if (failQuery === 'items' && /FROM order_items WHERE/.test(sql)) throw new Error('order items unavailable');
    if (/FROM orders o/.test(sql)) return [[{ id: 1 }]];
    return [[]];
  },
};

Module._load = function (request, parent, isMain) {
  if (parent?.filename === routesPath && request === '../config/db') return fakePool;
  if (parent?.filename === routesPath && request === '../models/inventorySoftwareModel') {
    const real = originalLoad.call(this, request, parent, isMain);
    return {
      ...real,
      ensureInventorySoftwareTables: async () => {},
      syncWebsiteProductsToInventoryMeta: async () => {},
      ensureDailyAutoBackup: async () => {},
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

let server;
let baseUrl;
before(async () => {
  const router = require(routesPath);
  Module._load = originalLoad;
  const app = express();
  app.use('/api/inventory-software', router);
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}/api/inventory-software`;
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  setTimeout(() => process.exit(process.exitCode || 0), 200).unref?.();
});

describe('inventory bootstrap order failures', () => {
  for (const kind of ['orders', 'items']) {
    it(`reports ${kind} query failure instead of an empty order feed`, async () => {
      failQuery = kind;
      const token = jwt.sign({ scope: 'inventory-software', id: 1 }, process.env.JWT_SECRET || 'fallback_secret');
      const response = await fetch(`${baseUrl}/bootstrap`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(response.status, 500);
      const body = await response.json();
      assert.equal(body.success, false);
      assert.match(body.message, /unavailable/);
    });
  }

  it('excludes inventory rows whose linked product was deleted and returns empty item arrays', async () => {
    failQuery = '';
    bootstrapItemQuery = '';
    const token = jwt.sign({ scope: 'inventory-software', id: 1 }, process.env.JWT_SECRET || 'fallback_secret');
    const response = await fetch(`${baseUrl}/bootstrap`, { headers: { authorization: ['Bearer', token].join(' ') } });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.items, []);
    assert.match(bootstrapItemQuery, /WHERE m\.product_id IS NULL OR p\.id IS NOT NULL/);
  });
});
