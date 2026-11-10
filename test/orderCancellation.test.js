const assert = require('node:assert/strict');
const { after, describe, it } = require('node:test');
const pool = require('../config/db');
const { assertOrderStatusTransition, updateOrderStatus } = require('../models/orderModel');

describe('order lifecycle safeguards', () => {
  after(async () => {
    await pool.end();
  });

  it('allows cancellation while the locked order is in an allowed state', () => {
    assert.doesNotThrow(() => assertOrderStatusTransition(
      { status: 'pending', payment_mode: 'COD', payment_status: 'pending' },
      'cancelled',
      { allowedCurrentStatuses: ['pending', 'confirmed'] },
    ));
  });

  it('rejects cancellation when the order progressed after the caller checked it', () => {
    assert.throws(
      () => assertOrderStatusTransition(
        { status: 'shipped', payment_mode: 'COD', payment_status: 'pending' },
        'cancelled',
        { allowedCurrentStatuses: ['pending', 'confirmed'] },
      ),
      error => error.status === 409 && error.code === 'ORDER_STATUS_CHANGED',
    );
  });

  it('requires refund handling before cancelling an already-paid online order', () => {
    assert.throws(
      () => assertOrderStatusTransition(
        { status: 'confirmed', payment_mode: 'online', payment_status: 'paid' },
        'cancelled',
        { allowedCurrentStatuses: ['pending', 'confirmed'] },
      ),
      error => error.status === 409 && error.code === 'REFUND_REQUIRED',
    );
  });

  it('does not apply the online refund restriction to unpaid or COD orders', () => {
    assert.doesNotThrow(() => assertOrderStatusTransition(
      { status: 'confirmed', payment_mode: 'online', payment_status: 'pending' },
      'cancelled',
    ));
    assert.doesNotThrow(() => assertOrderStatusTransition(
      { status: 'confirmed', payment_mode: 'COD', payment_status: 'pending' },
      'cancelled',
    ));
  });

  it('commits out-for-delivery status and checkpoint in one transaction', async () => {
    const originalGetConnection = pool.getConnection;
    const events = [];
    let updateParameters;
    pool.getConnection = async () => ({
      async beginTransaction() { events.push('begin'); },
      async commit() { events.push('commit'); },
      async rollback() { events.push('rollback'); },
      release() { events.push('release'); },
      async query(sql, params) {
        if (/SELECT id, order_number, user_id, status/.test(sql)) {
          return [[{
            id: 7,
            order_number: 'ORD-7',
            status: 'shipped',
            payment_mode: 'COD',
            payment_status: 'pending',
          }]];
        }
        if (/UPDATE orders SET status/.test(sql)) {
          updateParameters = params;
          return [{ affectedRows: 1 }];
        }
        throw new Error(`Unexpected SQL in lifecycle test: ${sql}`);
      },
    });

    try {
      const updated = await updateOrderStatus(7, 'out_for_delivery', null, {
        trackingNumber: 'AWB-7',
        courier: 'Test Courier',
        trackingUrl: 'https://courier.example/track/AWB-7',
        currentLocationCheckpoint: 'Out for Delivery',
      });
      assert.equal(updated, true);
      assert.deepEqual(events, ['begin', 'commit', 'release']);
      assert.equal(updateParameters[0], 'out_for_delivery');
      assert.equal(updateParameters[6], 'https://courier.example/track/AWB-7');
      assert.equal(updateParameters[8], 'Out for Delivery');
    } finally {
      pool.getConnection = originalGetConnection;
    }
  });

  it('requires a customer tracking link before committing shipment handover', async () => {
    const originalGetConnection = pool.getConnection;
    const events = [];
    pool.getConnection = async () => ({
      async beginTransaction() { events.push('begin'); },
      async commit() { events.push('commit'); },
      async rollback() { events.push('rollback'); },
      release() { events.push('release'); },
      async query(sql) {
        if (/SELECT id, order_number, user_id, status/.test(sql)) {
          return [[{
            id: 8,
            order_number: 'ORD-8',
            status: 'packed',
            payment_mode: 'prepaid',
            payment_status: 'paid',
          }]];
        }
        throw new Error(`Shipment should fail before update SQL: ${sql}`);
      },
    });

    try {
      await assert.rejects(
        () => updateOrderStatus(8, 'shipped', null, { trackingNumber: 'AWB-8', courier: 'Test Courier' }),
        error => error.status === 400 && error.code === 'SHIPMENT_TRACKING_URL_REQUIRED',
      );
      assert.deepEqual(events, ['begin', 'rollback', 'release']);
    } finally {
      pool.getConnection = originalGetConnection;
    }
  });
});
