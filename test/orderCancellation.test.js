const assert = require('node:assert/strict');
const { after, describe, it } = require('node:test');
const pool = require('../config/db');
const { assertOrderStatusTransition } = require('../models/orderModel');

describe('order cancellation safeguards', () => {
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
});
