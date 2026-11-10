'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { describe, it } = require('node:test');

const modelPath = path.resolve(__dirname, '../models/gstAccountingModel.js');
const originalLoad = Module._load;
const queryCalls = [];
const pool = {
  async query(sql, params) {
    queryCalls.push({ sql, params });
    return [[{ id: 1, name: 'Test product', stock: 4 }]];
  },
};

Module._load = function (request, parent, isMain) {
  if (parent?.filename === modelPath && request === '../config/db') return pool;
  if (parent?.filename === modelPath && request === '../utils/quantumCrypto') {
    return { computeQuantumHash512: () => 'test-hash' };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { getGstProducts } = require(modelPath);
Module._load = originalLoad;

describe('GST product listing', () => {
  it('selects inventory quantity as stock and supports the search filter', async () => {
    queryCalls.length = 0;
    const products = await getGstProducts({ search: 'oil' });

    assert.equal(products[0].stock, 4);
    assert.match(queryCalls[0].sql, /p\.quantity AS stock/);
    assert.doesNotMatch(queryCalls[0].sql, /p\.stock/);
    assert.deepEqual(queryCalls[0].params, ['oil', '%oil%', '%oil%', '%oil%']);
  });
});
