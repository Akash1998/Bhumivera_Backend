const crypto = require('node:crypto');
const express = require('express');

const isValidWebhookSignature = (rawBody, signature, secret) => {
  if (!Buffer.isBuffer(rawBody) || typeof signature !== 'string' ||
      !/^[a-f\d]{64}$/i.test(signature) || typeof secret !== 'string' || !secret) {
    return false;
  }
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
  const received = Buffer.from(signature, 'hex');
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
};

const processRazorpayWebhook = async ({ pool, eventId, event }) => {
  if (typeof eventId !== 'string' || !eventId.trim() || eventId.length > 100) {
    throw Object.assign(new Error('A valid webhook event ID is required.'), { status: 400 });
  }
  if (typeof event?.event !== 'string' || !event.event.trim() || event.event.length > 100) {
    throw Object.assign(new Error('A valid webhook event type is required.'), { status: 400 });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [insertResult] = await connection.query(
      'INSERT IGNORE INTO razorpay_webhook_events (event_id, event_type) VALUES (?, ?)',
      [eventId, event.event]
    );
    if (insertResult.affectedRows === 0) {
      await connection.commit();
      return { duplicate: true, updated: false };
    }

    let updated = false;
    if (event.event === 'payment.captured' || event.event === 'payment.failed') {
      const payment = event.payload?.payment?.entity;
      if (!payment?.id || !Number.isSafeInteger(payment.amount) || payment.currency !== 'INR') {
        throw Object.assign(new Error('Webhook payment details are invalid.'), { status: 400 });
      }

      const [orders] = await connection.query(
        `SELECT id, total, payment_status, payment_mode FROM orders
         WHERE payment_id = ? FOR UPDATE`,
        [payment.id]
      );
      const order = orders[0];
      if (!order) {
        throw Object.assign(
          new Error('The order for this payment is not committed yet; retry the webhook.'),
          { status: 503 }
        );
      }
      if (order && order.payment_mode === 'online' &&
          Math.round(Number(order.total) * 100) === payment.amount) {
        const nextStatus = event.event === 'payment.captured' ? 'paid' : 'failed';
        const [result] = await connection.query(
          `UPDATE orders SET payment_status = ?
           WHERE id = ? AND payment_status = 'pending'`,
          [nextStatus, order.id]
        );
        updated = result.affectedRows === 1;
      }
    }

    await connection.commit();
    return { duplicate: false, updated };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
};

const createRazorpayWebhookRouter = ({ pool, getSecret = () => process.env.RAZORPAY_WEBHOOK_SECRET } = {}) => {
  if (!pool) throw new TypeError('A database pool is required for Razorpay webhooks.');
  const router = express.Router();
  router.post('/', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
    const secret = getSecret();
    if (!secret) {
      return res.status(503).json({ code: 'WEBHOOK_NOT_CONFIGURED', message: 'Payment webhook is not configured.' });
    }
    const signature = req.get('x-razorpay-signature');
    if (!isValidWebhookSignature(req.body, signature, secret)) {
      return res.status(400).json({ code: 'INVALID_WEBHOOK_SIGNATURE', message: 'Webhook signature verification failed.' });
    }

    let event;
    try {
      event = JSON.parse(req.body.toString('utf8'));
    } catch {
      return res.status(400).json({ code: 'INVALID_WEBHOOK_BODY', message: 'Webhook body must contain valid JSON.' });
    }

    try {
      const result = await processRazorpayWebhook({
        pool,
        eventId: req.get('x-razorpay-event-id'),
        event,
      });
      if (!result.duplicate && !result.updated &&
          ['payment.captured', 'payment.failed'].includes(event.event)) {
        console.error('[RAZORPAY_WEBHOOK_PAYMENT_MISMATCH]', {
          eventId: req.get('x-razorpay-event-id'),
          eventType: event.event,
          paymentId: event.payload?.payment?.entity?.id,
        });
      }
      return res.status(200).json({ received: true, ...result });
    } catch (error) {
      if (error.status === 400) {
        return res.status(400).json({ code: 'INVALID_WEBHOOK_EVENT', message: error.message });
      }
      if (error.status === 503) {
        return res.status(503).json({ code: 'WEBHOOK_RETRY_REQUIRED', message: error.message });
      }
      console.error('[RAZORPAY_WEBHOOK]', error);
      return res.status(500).json({ code: 'WEBHOOK_PROCESSING_FAILED', message: 'Webhook could not be processed.' });
    }
  });
  return router;
};

module.exports = { createRazorpayWebhookRouter, isValidWebhookSignature, processRazorpayWebhook };
