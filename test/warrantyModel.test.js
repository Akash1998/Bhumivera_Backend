const assert = require('node:assert/strict');
const { after, afterEach, beforeEach, describe, it } = require('node:test');
const pool = require('../config/db');
const { registerWarranty, deletGenuiine_test } = require('../models/warrantyModel');

const originalQuery = pool.query;
const originalGetConnection = pool.getConnection;
let serialStatus;
let validatedStatus;
let isLegacySerial;
let insertCalls;
let insertValues;
let existingWarrantyRegistration;

beforeEach(() => {
  serialStatus = 'available';
  validatedStatus = 'available';
  isLegacySerial = 1;
  insertCalls = 0;
  insertValues = null;
  existingWarrantyRegistration = false;

  pool.query = async sql => {
    if (sql.includes('FROM product_serials ps')) {
      return [[{
        serial_id: 12,
        product_id: 4,
        serial_number: 'BV-0012',
        status: validatedStatus,
        is_legacy: isLegacySerial,
      }], []];
    }
    if (sql.includes('SELECT file_path FROM product_images')) return [[], []];
    throw new Error(`Unexpected pool query: ${sql}`);
  };

  pool.getConnection = async () => ({
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
    async query(sql, values) {
      if (sql.includes('SELECT id, status FROM product_serials')) {
        return [[{ status: serialStatus }], []];
      }
      if (sql.includes('SELECT id FROM warranty_registrations WHERE serial_number_id')) {
        return [existingWarrantyRegistration ? [{ id: 51 }] : [], []];
      }
      if (sql.includes('SELECT registered_serial, serial_number_id FROM warranty_registrations')) {
        return [[{ registered_serial: 'BV-0012', serial_number_id: 12 }], []];
      }
      if (sql.includes('INSERT INTO warranty_registrations')) {
        insertCalls += 1;
        insertValues = values;
        return [{ insertId: 51 }, []];
      }
      if (sql.includes("UPDATE product_serials SET status = 'registered'")) {
        serialStatus = 'registered';
        return [{ affectedRows: 1 }, []];
      }
      if (sql.includes("UPDATE product_serials SET status = 'available'")) {
        if (serialStatus === 'registered') serialStatus = 'available';
        return [{ affectedRows: serialStatus === 'available' ? 1 : 0 }, []];
      }
      if (sql.includes('DELETE FROM warranty_registrations')) return [{ affectedRows: 1 }, []];
      throw new Error(`Unexpected connection query: ${sql}`);
    },
  });
});

afterEach(() => {
  pool.query = originalQuery;
  pool.getConnection = originalGetConnection;
});

after(async () => {
  await pool.end();
});

describe('registerWarranty', () => {
  it('associates the authenticated customer in the same insert as the registration', async () => {
    const result = await registerWarranty({
      serialNumber: 'bv-0012',
      productId: 4,
      userId: 9,
    });

    assert.equal(result.registration_id, 51);
    assert.equal(insertCalls, 1);
    assert.equal(insertValues[0], 9);
    assert.equal(insertValues[1], 'BV-0012');
    assert.equal(serialStatus, 'registered');
  });

  it('rejects a duplicate when the serial becomes registered after validation', async () => {
    validatedStatus = 'available';
    serialStatus = 'registered';

    await assert.rejects(
      registerWarranty({ serialNumber: 'bv-0012', productId: 4, userId: 9 }),
      error => error.status === 409
    );

    assert.equal(insertCalls, 0);
  });

  it('allows warranty registration for a sold item without making it available for resale', async () => {
    validatedStatus = 'sold';
    serialStatus = 'sold';

    await registerWarranty({ serialNumber: 'bv-0012', productId: 4, userId: 9 });

    assert.equal(insertCalls, 1);
    assert.equal(serialStatus, 'sold');
  });

  it('rejects a second warranty registration for a sold item', async () => {
    validatedStatus = 'sold';
    serialStatus = 'sold';
    existingWarrantyRegistration = true;

    await assert.rejects(
      registerWarranty({ serialNumber: 'bv-0012', productId: 4, userId: 9 }),
      error => error.status === 409
    );

    assert.equal(insertCalls, 0);
  });

  it('does not make a sold item available when its warranty registration is removed', async () => {
    serialStatus = 'sold';

    await deletGenuiine_test(51);

    assert.equal(serialStatus, 'sold');
  });

  it('rejects impossible and future purchase dates for e-warranty registrations', async () => {
    isLegacySerial = 0;
    const tomorrow = new Date(Date.now() + 19800000 + 86400000).toISOString().slice(0, 10);

    await assert.rejects(
      registerWarranty({
        serialNumber: 'bv-0012',
        productId: 4,
        purchaseDate: '2026-02-30',
      }),
      error => error.status === 400
    );
    await assert.rejects(
      registerWarranty({
        serialNumber: 'bv-0012',
        productId: 4,
        purchaseDate: tomorrow,
      }),
      error => error.status === 400 && /future/.test(error.message)
    );

    assert.equal(insertCalls, 0);
  });
});
