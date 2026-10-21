const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  createReturnRefund,
  reconcileReturnRefund,
  toPaise,
} = require('../services/returnRefundService');

const createFixture = ({ existingRefunds = [], paymentRefunds = [], providerResponse, providerError } = {}) => {
  const state = {
    returnStatus: 'received',
    refundStatus: null,
    inserted: null,
    submittedRefund: null,
    commits: 0,
    rollbacks: 0,
  };
  const returnRow = {
    id: 4,
    order_id: 9,
    refund_type: 'refund',
    status: 'received',
    payment_id: 'pay_123',
    payment_mode: 'online',
    payment_status: 'paid',
    total: '10.00',
  };
  const pool = {
    async query(sql, params = []) {
      if (sql.includes('SELECT r.id, r.order_id, r.refund_type')) {
        return [[{ ...returnRow, status: state.returnStatus }]];
      }
      if (sql.includes('SELECT status FROM return_refund_requests')) {
        return [[{ status: state.refundStatus }]];
      }
      if (sql.includes('UPDATE return_refund_requests SET status')) {
        state.refundStatus = params[0];
        return [{ affectedRows: 1 }];
      }
      if (sql.includes('UPDATE returns SET status')) {
        state.returnStatus = 'received';
        return [{ affectedRows: 1 }];
      }
      if (sql.includes('SELECT status FROM return_refund_requests WHERE id')) {
        return [[{ status: state.refundStatus }]];
      }
      throw new Error(`Unexpected pool query: ${sql}`);
    },
    async getConnection() {
      return {
        async beginTransaction() {},
        async commit() { state.commits += 1; },
        async rollback() { state.rollbacks += 1; },
        release() {},
        async query(sql, params = []) {
          if (sql.includes('SELECT r.id, r.order_id, r.refund_type')) {
            return [[{ ...returnRow, status: state.returnStatus }]];
          }
          if (sql.includes('SELECT return_id, receipt, amount_paise')) return [existingRefunds];
          if (sql.includes('SELECT COALESCE(MAX(attempt_no)')) return [[{ last_attempt: 0 }]];
          if (sql.includes('INSERT INTO return_refund_requests')) {
            state.inserted = params;
            state.refundStatus = 'requesting';
            return [{ insertId: 33 }];
          }
          if (sql.includes("UPDATE returns SET status = 'refund_pending'")) {
            state.returnStatus = 'refund_pending';
            return [{ affectedRows: 1 }];
          }
          if (sql.includes("UPDATE returns SET status = 'received'")) {
            state.returnStatus = 'received';
            return [{ affectedRows: 1 }];
          }
          if (sql.includes('SELECT status FROM return_refund_requests WHERE id')) {
            return [[{ status: state.refundStatus }]];
          }
          if (sql.includes('UPDATE return_refund_requests SET provider_refund_id')) {
            state.refundStatus = params[1];
            return [{ affectedRows: 1 }];
          }
          if (sql.includes('UPDATE return_refund_requests SET status')) {
            state.refundStatus = params[0];
            return [{ affectedRows: 1 }];
          }
          if (sql.includes("UPDATE returns SET status = ?")) {
            state.returnStatus = params[0];
            return [{ affectedRows: 1 }];
          }
          if (sql.includes('UPDATE return_refund_requests SET provider_refund_id = COALESCE')) {
            return [{ affectedRows: 1 }];
          }
          if (sql.includes('SELECT total FROM orders')) return [[]];
          throw new Error(`Unexpected connection query: ${sql}`);
        },
      };
    },
  };
  const razorpay = {
    payments: {
      async fetch(paymentId) {
        assert.equal(paymentId, 'pay_123');
        return {
          id: paymentId,
          status: 'captured',
          currency: 'INR',
          amount: 1000,
          amount_refunded: 200,
        };
      },
      async fetchMultipleRefund(paymentId, params) {
        assert.equal(paymentId, 'pay_123');
        assert.equal(params.count, 100);
        return { items: paymentRefunds };
      },
      async refund(paymentId, payload) {
        state.submittedRefund = { paymentId, payload };
        if (providerError) throw providerError;
        return providerResponse || {
          id: 'rfnd_123',
          payment_id: paymentId,
          amount: payload.amount,
          status: 'pending',
        };
      },
    },
  };
  return { pool, razorpay, state };
};

describe('return refund service', () => {
  it('converts rupees to paise without floating-point rounding', () => {
    assert.equal(toPaise('1'), 100);
    assert.equal(toPaise('10.01'), 1001);
    assert.equal(toPaise('01.00'), null);
    assert.equal(toPaise('1.001'), null);
    assert.equal(toPaise('-1'), null);
  });

  it('requires an admin-confirmed amount within the remaining captured balance', async () => {
    const fixture = createFixture({
      paymentRefunds: [{ id: 'rfnd_external', status: 'processed', amount: 200 }],
    });
    const result = await createReturnRefund({
      ...fixture,
      returnId: 4,
      amountPaise: 800,
      admin: { id: 7, email: 'admin@example.com' },
    });
    assert.equal(result.status, 'pending');
    assert.equal(result.returnStatus, 'refund_pending');
    assert.equal(fixture.state.returnStatus, 'refund_pending');
    assert.equal(fixture.state.submittedRefund.payload.amount, 800);
    assert.equal(fixture.state.submittedRefund.payload.receipt, 'bvrma-4-1');
  });

  it('rejects amounts above provider-reported refundable balance without submitting a refund', async () => {
    const fixture = createFixture();
    await assert.rejects(
      createReturnRefund({
        ...fixture,
        returnId: 4,
        amountPaise: 801,
        admin: { id: 7, email: 'admin@example.com' },
      }),
      error => error.code === 'REFUND_EXCEEDS_REMAINING_BALANCE' && error.remainingPaise === 800
    );
    assert.equal(fixture.state.submittedRefund, null);
    assert.equal(fixture.state.rollbacks, 1);
  });

  it('does not repeat a refund when an earlier attempt is still active', async () => {
    const fixture = createFixture({
      existingRefunds: [{
        return_id: 4,
        amount_paise: 500,
        status: 'unknown',
        provider_refund_id: null,
      }],
    });
    await assert.rejects(
      createReturnRefund({
        ...fixture,
        returnId: 4,
        amountPaise: 100,
        admin: { id: 7, email: 'admin@example.com' },
      }),
      error => error.code === 'REFUND_ALREADY_REQUESTED'
    );
    assert.equal(fixture.state.submittedRefund, null);
  });

  it('holds an ambiguous provider timeout in unknown state and returns its receipt for manual reconciliation', async () => {
    const fixture = createFixture({ providerError: new Error('network timeout') });
    await assert.rejects(
      createReturnRefund({
        ...fixture,
        returnId: 4,
        amountPaise: 500,
        admin: { id: 7, email: 'admin@example.com' },
      }),
      error => error.code === 'REFUND_STATUS_UNKNOWN' && error.receipt === 'bvrma-4-1'
    );
    assert.equal(fixture.state.refundStatus, 'unknown');
    assert.equal(fixture.state.returnStatus, 'refund_pending');
    assert.ok(fixture.state.submittedRefund);
  });

  it('treats provider conflicts as ambiguous rather than allowing an unsafe retry', async () => {
    const fixture = createFixture({
      providerError: Object.assign(new Error('conflict'), { statusCode: 409 }),
    });
    await assert.rejects(
      createReturnRefund({
        ...fixture,
        returnId: 4,
        amountPaise: 500,
        admin: { id: 7, email: 'admin@example.com' },
      }),
      error => error.code === 'REFUND_STATUS_UNKNOWN'
    );
    assert.equal(fixture.state.refundStatus, 'unknown');
    assert.equal(fixture.state.returnStatus, 'refund_pending');
  });

  it('releases a reservation after a definite provider rejection', async () => {
    const fixture = createFixture({
      providerError: Object.assign(new Error('invalid request'), { statusCode: 400 }),
    });
    await assert.rejects(
      createReturnRefund({
        ...fixture,
        returnId: 4,
        amountPaise: 500,
        admin: { id: 7, email: 'admin@example.com' },
      }),
      error => error.code === 'REFUND_PROVIDER_REJECTED'
    );
    assert.equal(fixture.state.refundStatus, 'failed');
    assert.equal(fixture.state.returnStatus, 'received');
  });

  it('reconciles an unknown request by exact provider receipt without submitting a second refund', async () => {
    const state = { requestStatus: 'unknown', returnStatus: 'refund_pending' };
    const request = {
      id: 33,
      receipt: 'bvrma-4-1',
      payment_id: 'pay_123',
      provider_refund_id: null,
      amount_paise: 500,
      status: 'unknown',
    };
    const pool = {
      async query(sql) {
        if (sql.includes('WHERE return_id = ?')) return [[request]];
        throw new Error(`Unexpected pool query: ${sql}`);
      },
      async getConnection() {
        return {
          async beginTransaction() {},
          async commit() {},
          async rollback() {},
          release() {},
          async query(sql, params) {
            if (sql.includes('SELECT id, return_id') && sql.includes('FROM return_refund_requests')) return [[request]];
            if (sql.includes('SELECT total FROM orders')) return [[]];
            if (sql.includes('UPDATE return_refund_requests')) {
              request.provider_refund_id = params[0];
              request.status = params[1];
              state.requestStatus = params[1];
              return [{ affectedRows: 1 }];
            }
            if (sql.includes('UPDATE returns SET status')) {
              state.returnStatus = params[0];
              return [{ affectedRows: 1 }];
            }
            throw new Error(`Unexpected connection query: ${sql}`);
          },
        };
      },
    };
    let refundSubmissions = 0;
    const razorpay = {
      payments: {
        async fetchMultipleRefund() {
          return {
            items: [{
              id: 'rfnd_123',
              payment_id: 'pay_123',
              amount: 500,
              receipt: 'bvrma-4-1',
              status: 'processed',
            }],
          };
        },
        async refund() {
          refundSubmissions += 1;
        },
      },
    };
    const result = await reconcileReturnRefund({ pool, razorpay, returnId: 4 });
    assert.equal(result.status, 'processed');
    assert.equal(result.returnStatus, 'refunded');
    assert.equal(state.requestStatus, 'processed');
    assert.equal(state.returnStatus, 'refunded');
    assert.equal(refundSubmissions, 0);
  });
});
