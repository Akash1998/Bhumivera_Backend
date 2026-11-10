const assert = require('node:assert/strict');
const { beforeEach, describe, it } = require('node:test');
const Module = require('node:module');
const path = require('node:path');

const modelPath = path.resolve(__dirname, '../models/productBatchModel.js');
const queries = [];
let connectionCalls = 0;
let failSerialInsert = false;
let publicVerificationRows = [];

const connection = {
  async beginTransaction() {
    queries.push({ sql: 'BEGIN' });
  },
  async commit() {
    queries.push({ sql: 'COMMIT' });
  },
  async rollback() {
    queries.push({ sql: 'ROLLBACK' });
  },
  release() {
    queries.push({ sql: 'RELEASE' });
  },
  async query(sql, params = []) {
    queries.push({ sql, params });
    if (sql.includes('SELECT id, name, sku FROM products')) {
      return [[{ id: 12, name: 'Test Product', sku: 'TEST-12' }]];
    }
    if (sql.includes('INSERT INTO product_batches')) return [{ insertId: 34 }];
    if (sql.includes('INSERT INTO product_serials')) {
      if (failSerialInsert) throw new Error('serial insert failed');
      return [{ affectedRows: 2 }];
    }
    return [{ affectedRows: 1 }];
  },
};

const fakePool = {
  async getConnection() {
    connectionCalls += 1;
    return connection;
  },
  async query(sql, params = []) {
    queries.push({ sql, params });
    if (sql.includes('FROM product_serials ps')) return [publicVerificationRows];
    return [[], []];
  },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent?.filename === modelPath && request === '../config/db') return fakePool;
  return originalLoad.call(this, request, parent, isMain);
};
const batchModel = require(modelPath);
Module._load = originalLoad;

describe('product batch registry', () => {
  beforeEach(() => {
    queries.length = 0;
    connectionCalls = 0;
    failSerialInsert = false;
    publicVerificationRows = [];
  });

  it('rejects invalid batch data before opening a database transaction', async () => {
    await assert.rejects(
      batchModel.createProductBatch({
        productId: 12,
        count: 0,
        prefix: 'BV',
        manufactureDate: '2026-01-01',
        expiryDate: '2027-01-01',
      }),
      error => error.status === 400 && /quantity/.test(error.message)
    );
    await assert.rejects(
      batchModel.createProductBatch({
        productId: 12,
        count: 1,
        prefix: 'BV',
        manufactureDate: '2026-02-30',
        expiryDate: '2027-01-01',
      }),
      error => error.status === 400 && /dates/.test(error.message)
    );
    assert.equal(connectionCalls, 0);
  });

  it('creates a transactionally linked batch with unique serial codes', async () => {
    const batch = await batchModel.createProductBatch({
      productId: '12',
      count: '2',
      prefix: 'bv',
      manufactureDate: '2026-01-01',
      expiryDate: '2027-01-01',
      details: [{ label: 'Calibrated pH', value: '5.2', visible: false }],
    });

    assert.equal(batch.batchNumber.startsWith('BV-2601-'), true);
    assert.equal(batch.serials.length, 2);
    assert.equal(new Set(batch.serials).size, 2);
    assert.equal(batch.details[0].visible, false);
    assert.equal(queries.some(entry => entry.sql === 'COMMIT'), true);
    const serialInsert = queries.find(entry => entry.sql.includes('INSERT INTO product_serials'));
    assert.equal(serialInsert.params[0].length, 2);
    assert.ok(serialInsert.params[0].every(row => row[1] === 34));
    assert.ok(serialInsert.params[0].every(row => row[3] === 0));
  });

  it('rolls back the batch if serial creation fails', async () => {
    failSerialInsert = true;

    await assert.rejects(
      batchModel.createProductBatch({
        productId: 12,
        count: 2,
        prefix: 'BV',
        manufactureDate: '2026-01-01',
        expiryDate: '2027-01-01',
      }),
      /serial insert failed/
    );
    assert.equal(queries.some(entry => entry.sql === 'ROLLBACK'), true);
    assert.equal(queries.some(entry => entry.sql === 'COMMIT'), false);
  });

  it('verifies only registered serials and returns public batch details and expiry', async () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    publicVerificationRows = [{
      serial_number: 'BV-2601-UNIQUE',
      status: 'available',
      batch_id: 34,
      batch_number: 'BV-2601-BATCH',
      manufacture_date: new Date('2026-01-01T00:00:00.000Z'),
      expiry_date: yesterday,
      unit_count: 2,
      details: JSON.stringify([
        { label: 'Calibrated pH', value: '5.2', visible: true },
        { label: 'Private note', value: 'internal', visible: false },
      ]),
      product_name: 'Test Product',
      sku: 'TEST-12',
      image: null,
    }];

    const result = await batchModel.getPublicProductVerification(' bv-2601-unique ');

    assert.equal(result.verified, true);
    assert.equal(result.expired, true);
    assert.deepEqual(result.details, [{ label: 'Calibrated pH', value: '5.2', visible: true }]);
    assert.equal(queries[0].params[0], 'BV-2601-UNIQUE');

    publicVerificationRows = [];
    assert.equal(await batchModel.getPublicProductVerification('BV-NOT-REGISTERED'), null);
  });
});
