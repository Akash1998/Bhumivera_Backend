const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { after, before, describe, it } = require('node:test');
const express = require('express');
const {
  createRazorpayWebhookRouter,
  isValidWebhookSignature,
  processRazorpayWebhook,
} = require('../services/razorpayWebhook');

const secret = 'webhook-secret-for-test-only';

const createPaymentEvent = (event = 'payment.captured') => ({
  event,
  payload: {
    payment: {
      entity: { id: 'pay_123', amount: 2500, currency: 'INR' },
    },
  },
});

const createPool = () => {
  const eventIds = new Set();
  const order = { id: 7, total: 25, payment_status: 'pending', payment_mode: 'online' };
  let hasOrder = true;
  return {
    order,
    get hasOrder() { return hasOrder; },
    set hasOrder(value) { hasOrder = value; },
    eventIds,
    async getConnection() {
      let transactionEventIds;
      let transactionPaymentStatus;
      return {
        async beginTransaction() {
          transactionEventIds = new Set(eventIds);
          transactionPaymentStatus = order.payment_status;
        },
        async commit() {},
        async rollback() {
          eventIds.clear();
          for (const eventId of transactionEventIds) eventIds.add(eventId);
          order.payment_status = transactionPaymentStatus;
        },
        release() {},
        async query(sql, params) {
          if (sql.includes('INSERT IGNORE INTO razorpay_webhook_events')) {
            if (eventIds.has(params[0])) return [{ affectedRows: 0 }];
            eventIds.add(params[0]);
            return [{ affectedRows: 1 }];
          }
          if (sql.includes('SELECT user_id, shopping_wallet_reward_amount')) return [[]];
          if (sql.includes('FROM orders') && sql.includes('WHERE payment_id = ?')) {
            return [hasOrder ? [{ ...order }] : []];
          }
          if (sql.includes('UPDATE orders SET payment_status')) {
            if (order.payment_status !== 'pending') return [{ affectedRows: 0 }];
            order.payment_status = params[0];
            return [{ affectedRows: 1 }];
          }
          throw new Error(`Unexpected SQL: ${sql}`);
        },
      };
    },
  };
};

const sign = body => crypto.createHmac('sha256', secret).update(body).digest('hex');

const createRefundWebhookPool = () => {
  const eventIds = new Set();
  const request = {
    id: 19,
    return_id: 4,
    payment_id: 'pay_123',
    amount_paise: 500,
    receipt: 'bvrma-4-1',
    provider_refund_id: null,
    status: 'requesting',
  };
  const result = { request, returnStatus: 'refund_pending', eventIds };
  return {
    result,
    async getConnection() {
      return {
        async beginTransaction() {},
        async commit() {},
        async rollback() {},
        release() {},
        async query(sql, params) {
          if (sql.includes('INSERT IGNORE INTO razorpay_webhook_events')) {
            if (eventIds.has(params[0])) return [{ affectedRows: 0 }];
            eventIds.add(params[0]);
            return [{ affectedRows: 1 }];
          }
          if (sql.includes('WHERE provider_refund_id = ? OR receipt = ?')) {
            return [[request.provider_refund_id === params[0] || request.receipt === params[1]
              ? { ...request }
              : null].filter(Boolean)];
          }
          if (sql.includes('provider_refund_id IS NULL')) {
            return [[{ ...request }]];
          }
          if (sql.includes('UPDATE return_refund_requests')) {
            request.provider_refund_id = params[0];
            request.status = params[1];
            return [{ affectedRows: 1 }];
          }
          if (sql.includes('UPDATE returns SET status')) {
            result.returnStatus = params[0];
            return [{ affectedRows: 1 }];
          }
          if (sql.includes('SELECT total FROM orders')) return [[]];
          throw new Error(`Unexpected refund webhook SQL: ${sql}`);
        },
      };
    },
  };
};

const createRefundEvent = (event, status) => ({
  event,
  payload: {
    refund: {
      entity: {
        id: 'rfnd_123',
        payment_id: 'pay_123',
        amount: 500,
        receipt: 'bvrma-4-1',
        status,
      },
    },
  },
});

describe('Razorpay webhooks', () => {
  let server;
  let baseUrl;
  let pool;

  before(async () => {
    const app = express();
    pool = createPool();
    app.use('/api/webhooks/razorpay', createRazorpayWebhookRouter({ pool, getSecret: () => secret }));
    await new Promise(resolve => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}/api/webhooks/razorpay`;
  });

  after(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  it('checks the signature against the exact raw request bytes', () => {
    const rawBody = Buffer.from(JSON.stringify(createPaymentEvent()));
    assert.equal(isValidWebhookSignature(rawBody, sign(rawBody), secret), true);
    assert.equal(isValidWebhookSignature(Buffer.from(`${rawBody} `), sign(rawBody), secret), false);
    assert.equal(isValidWebhookSignature(rawBody, 'bad-signature', secret), false);
  });

  it('marks matching online orders paid and makes repeated deliveries idempotent', async () => {
    const rawBody = Buffer.from(JSON.stringify(createPaymentEvent()));
    const headers = {
      'content-type': 'application/json',
      'x-razorpay-signature': sign(rawBody),
      'x-razorpay-event-id': 'evt_1',
    };
    const first = await fetch(baseUrl, { method: 'POST', headers, body: rawBody });
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { received: true, duplicate: false, updated: true });
    assert.equal(pool.order.payment_status, 'paid');

    const repeated = await fetch(baseUrl, { method: 'POST', headers, body: rawBody });
    assert.equal(repeated.status, 200);
    assert.deepEqual(await repeated.json(), { received: true, duplicate: true, updated: false });
    pool.order.payment_status = 'pending';
  });

  it('does not change orders when the captured amount does not match the recorded total', async () => {
    const rawBody = Buffer.from(JSON.stringify(createPaymentEvent()));
    pool.order.payment_status = 'pending';
    pool.order.total = 30;
    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-razorpay-signature': sign(rawBody),
        'x-razorpay-event-id': 'evt_amount_mismatch',
      },
      body: rawBody,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { received: true, duplicate: false, updated: false });
    assert.equal(pool.order.payment_status, 'pending');
    pool.order.total = 25;
  });

  it('asks the provider to retry if payment arrives before the order commits', async () => {
    const rawBody = Buffer.from(JSON.stringify(createPaymentEvent()));
    const headers = {
      'content-type': 'application/json',
      'x-razorpay-signature': sign(rawBody),
      'x-razorpay-event-id': 'evt_before_order',
    };
    pool.hasOrder = false;
    const early = await fetch(baseUrl, { method: 'POST', headers, body: rawBody });
    assert.equal(early.status, 503);
    assert.equal(pool.eventIds.has('evt_before_order'), false);

    pool.hasOrder = true;
    const retried = await fetch(baseUrl, { method: 'POST', headers, body: rawBody });
    assert.equal(retried.status, 200);
    assert.deepEqual(await retried.json(), { received: true, duplicate: false, updated: true });
  });

  it('rejects unsigned requests without changing payment state', async () => {
    const rawBody = Buffer.from(JSON.stringify(createPaymentEvent()));
    pool.order.payment_status = 'pending';
    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-razorpay-event-id': 'evt_2' },
      body: rawBody,
    });
    assert.equal(response.status, 400);
    assert.equal(pool.order.payment_status, 'pending');
  });

  it('marks returns refunded only on refund.processed and deduplicates provider events', async () => {
    const refundPool = createRefundWebhookPool();
    const created = await processRazorpayWebhook({
      pool: refundPool,
      eventId: 'evt_refund_created',
      event: createRefundEvent('refund.created', 'pending'),
    });
    assert.equal(created.updated, true);
    assert.equal(refundPool.result.request.status, 'pending');
    assert.equal(refundPool.result.returnStatus, 'refund_pending');

    const processed = await processRazorpayWebhook({
      pool: refundPool,
      eventId: 'evt_refund_processed',
      event: createRefundEvent('refund.processed', 'processed'),
    });
    assert.equal(processed.updated, true);
    assert.equal(refundPool.result.request.status, 'processed');
    assert.equal(refundPool.result.returnStatus, 'refunded');

    const duplicate = await processRazorpayWebhook({
      pool: refundPool,
      eventId: 'evt_refund_processed',
      event: createRefundEvent('refund.processed', 'processed'),
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal(refundPool.result.returnStatus, 'refunded');
  });

  it('returns a failed provider refund to received status without marking it refunded', async () => {
    const refundPool = createRefundWebhookPool();
    const result = await processRazorpayWebhook({
      pool: refundPool,
      eventId: 'evt_refund_failed',
      event: createRefundEvent('refund.failed', 'failed'),
    });
    assert.equal(result.updated, true);
    assert.equal(refundPool.result.request.status, 'failed');
    assert.equal(refundPool.result.returnStatus, 'received');
  });

  it('matches a webhook without a receipt only when one pending payment-and-amount request is unambiguous', async () => {
    const refundPool = createRefundWebhookPool();
    const event = createRefundEvent('refund.processed', 'processed');
    event.payload.refund.entity.receipt = null;
    const result = await processRazorpayWebhook({
      pool: refundPool,
      eventId: 'evt_refund_no_receipt',
      event,
    });
    assert.equal(result.updated, true);
    assert.equal(refundPool.result.request.provider_refund_id, 'rfnd_123');
    assert.equal(refundPool.result.returnStatus, 'refunded');
  });
});
