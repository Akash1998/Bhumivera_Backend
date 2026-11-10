const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { reconcileOrderPayments, toPaise } = require('../services/paymentReconciliationService');

const createFixture = orders => {
  const fetched = [];
  return {
    fetched,
    pool: {
      async query(_sql, ids) {
        return [orders.filter(order => ids.includes(Number(order.id)))];
      },
    },
    razorpay: {
      payments: {
        async fetch(paymentId) {
          fetched.push(paymentId);
          if (paymentId === 'pay_missing') {
            throw Object.assign(new Error('Not found'), { statusCode: 404, code: 'NOT_FOUND' });
          }
          return {
            id: paymentId,
            status: paymentId === 'pay_authorized' ? 'authorized' : 'captured',
            currency: 'INR',
            amount: paymentId === 'pay_wrong_amount' ? 999 : 1000,
          };
        },
      },
    },
  };
};

describe('order payment reconciliation', () => {
  it('compares stored online orders with provider status and amount without mutating data', async () => {
    const fixture = createFixture([
      { id: 1, payment_id: 'pay_captured', payment_mode: 'online', payment_status: 'paid', total: '10.00' },
      { id: 2, payment_id: 'pay_authorized', payment_mode: 'online', payment_status: 'paid', total: '10.00' },
      { id: 3, payment_id: 'pay_wrong_amount', payment_mode: 'online', payment_status: 'paid', total: '10.00' },
      { id: 4, payment_id: 'pay_missing', payment_mode: 'online', payment_status: 'paid', total: '10.00' },
      { id: 5, payment_id: null, payment_mode: 'online', payment_status: 'pending', total: '10.00' },
      { id: 6, payment_id: null, payment_mode: 'COD', payment_status: 'pending', total: '10.00' },
      { id: 8, payment_id: 'pay_captured', payment_mode: 'online', payment_status: 'pending', total: '10.00' },
    ]);

    const results = await reconcileOrderPayments({
      ...fixture,
      orderIds: [1, 2, 3, 4, 5, 6, 8, 999],
    });

    assert.deepEqual(results.map(row => row.outcome), [
      'matched',
      'provider_not_captured',
      'payment_details_mismatch',
      'provider_lookup_failed',
      'missing_payment_id',
      'not_online_payment',
      'local_status_mismatch',
      'order_not_found',
    ]);
    assert.equal(fixture.fetched.length, 5);
  });

  it('rejects an empty or oversized reconciliation request', async () => {
    await assert.rejects(
      reconcileOrderPayments({ pool: {}, razorpay: {}, orderIds: [] }),
      error => error.code === 'INVALID_RECONCILIATION_ORDER_IDS'
    );
    await assert.rejects(
      reconcileOrderPayments({ pool: {}, razorpay: {}, orderIds: Array.from({ length: 26 }, (_, index) => index + 1) }),
      error => error.code === 'INVALID_RECONCILIATION_ORDER_IDS'
    );
  });

  it('converts database decimal amounts to paise without floating-point rounding', () => {
    assert.equal(toPaise('10.01'), 1001);
    assert.equal(toPaise('10.1'), 1010);
    assert.equal(toPaise('01.00'), null);
    assert.equal(toPaise('10.001'), null);
    assert.equal(toPaise('invalid'), null);
  });
});
