const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { after, before, describe, it } = require('node:test');
const express = require('express');
const { createRazorpayWebhookRouter, isValidWebhookSignature } = require('../services/razorpayWebhook');

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
          if (sql.includes('SELECT id, total, payment_status, payment_mode FROM orders')) {
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
});
