const crypto = require('node:crypto');
const express = require('express');
const {
  issueOrderShoppingWalletReward,
  reconcileShoppingWalletRewardRefund,
} = require('../models/shoppingWalletRewardModel');
const { sendImpactCertificateForContribution } = require('./impactDonationService');

const isValidWebhookSignature = (rawBody, signature, secret) => {
  if (!Buffer.isBuffer(rawBody) || typeof signature !== 'string' ||
      !/^[a-f\d]{64}$/i.test(signature) || typeof secret !== 'string' || !secret) {
    return false;
  }
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
  const received = Buffer.from(signature, 'hex');
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
};

const processRazorpayWebhook = async ({
  pool,
  eventId,
  event,
  sendImpactCertificate = sendImpactCertificateForContribution,
}) => {
  if (typeof eventId !== 'string' || !eventId.trim() || eventId.length > 100) {
    throw Object.assign(new Error('A valid webhook event ID is required.'), { status: 400 });
  }
  if (typeof event?.event !== 'string' || !event.event.trim() || event.event.length > 100) {
    throw Object.assign(new Error('A valid webhook event type is required.'), { status: 400 });
  }

  let connection = await pool.getConnection();
  let transactionOpen = false;
  try {
    await connection.beginTransaction();
    transactionOpen = true;
    const [insertResult] = await connection.query(
      'INSERT IGNORE INTO razorpay_webhook_events (event_id, event_type) VALUES (?, ?)',
      [eventId, event.event]
    );
    if (insertResult.affectedRows === 0) {
      await connection.commit();
      transactionOpen = false;
      connection.release();
      connection = null;
      if (event.event === 'payment.captured') {
        const payment = event.payload?.payment?.entity;
        if (payment?.id && payment.order_id) {
          const [contributions] = await pool.query(
            `SELECT id FROM impact_contributions
             WHERE razorpay_order_id = ? AND payment_id = ? AND status = 'collected'
             LIMIT 1`,
            [payment.order_id, payment.id]
          );
          if (contributions[0] &&
              !await sendImpactCertificate(pool, contributions[0].id)) {
            throw Object.assign(new Error('Impact certificate email delivery needs a webhook retry.'), { status: 503 });
          }
        }
      }
      return { duplicate: true, updated: false };
    }

    let updated = false;
    let impactContributionId = null;
    if (event.event === 'payment.captured' || event.event === 'payment.failed') {
      const payment = event.payload?.payment?.entity;
      if (!payment?.id || !Number.isSafeInteger(payment.amount) || payment.currency !== 'INR') {
        throw Object.assign(new Error('Webhook payment details are invalid.'), { status: 400 });
      }

      const [orders] = await connection.query(
        `SELECT id, user_id, total, payment_status, payment_mode,
                coupon_credit_eligible_subtotal, shopping_wallet_reward_awarded_at
         FROM orders
         WHERE payment_id = ? FOR UPDATE`,
        [payment.id]
      );
      const order = orders[0];
      if (!order) {
        const [impactRows] = await connection.query(
          `SELECT id, amount, status, payment_id
           FROM impact_contributions
           WHERE razorpay_order_id = ? FOR UPDATE`,
          [payment.order_id]
        );
        const contribution = impactRows[0];
        if (!contribution) {
          throw Object.assign(
            new Error('The order for this payment is not committed yet; retry the webhook.'),
            { status: 503 }
          );
        }
        if (
          payment.currency === 'INR' &&
          Math.round(Number(contribution.amount) * 100) === payment.amount
        ) {
          if (event.event === 'payment.failed') {
            updated = true;
          } else if (
            contribution.status === 'pledged' ||
            contribution.payment_id === payment.id
          ) {
            const [result] = await connection.query(
              `UPDATE impact_contributions
               SET payment_id = ?, status = 'collected', collected_at = COALESCE(collected_at, NOW())
               WHERE id = ? AND (payment_id IS NULL OR payment_id = ?)`,
              [payment.id, contribution.id, payment.id]
            );
            updated = result.affectedRows === 1 || contribution.payment_id === payment.id;
            if (updated) impactContributionId = contribution.id;
          }
        }
      } else if (order && order.payment_mode === 'online' &&
          Math.round(Number(order.total) * 100) === payment.amount) {
        const nextStatus = event.event === 'payment.captured' ? 'paid' : 'failed';
        const [result] = await connection.query(
          `UPDATE orders SET payment_status = ?
           WHERE id = ? AND payment_status = 'pending'`,
          [nextStatus, order.id]
        );
        updated = result.affectedRows === 1;
        if (updated && nextStatus === 'paid' && !order.shopping_wallet_reward_awarded_at) {
          await issueOrderShoppingWalletReward(connection, {
            userId: order.user_id,
            orderId: order.id,
            eligibleSubtotal: order.coupon_credit_eligible_subtotal,
          });
        }
      }
    } else if (['refund.created', 'refund.processed', 'refund.failed'].includes(event.event)) {
      const refund = event.payload?.refund?.entity;
      if (!refund?.id || !refund?.payment_id ||
          !Number.isSafeInteger(refund.amount) || refund.amount < 1) {
        throw Object.assign(new Error('Webhook refund details are invalid.'), { status: 400 });
      }
      const [requests] = await connection.query(
        `SELECT id, return_id, order_id, payment_id, amount_paise, status
         FROM return_refund_requests
         WHERE provider_refund_id = ? OR receipt = ?
         ORDER BY id DESC LIMIT 1 FOR UPDATE`,
        [refund.id, refund.receipt || null]
      );
      let request = requests[0];
      if (!request && !refund.receipt) {
        const [candidates] = await connection.query(
          `SELECT id, return_id, order_id, payment_id, amount_paise, status
           FROM return_refund_requests
           WHERE payment_id = ? AND amount_paise = ? AND provider_refund_id IS NULL
             AND status IN ('requesting', 'pending', 'unknown')
           ORDER BY id ASC LIMIT 2 FOR UPDATE`,
          [refund.payment_id, refund.amount]
        );
        if (candidates.length === 1) {
          [request] = candidates;
        } else if (candidates.length > 1) {
          console.error('[RAZORPAY_WEBHOOK_REFUND_AMBIGUOUS]', {
            eventId,
            refundId: refund.id,
            paymentId: refund.payment_id,
          });
        }
      }
      if (request) {
        if (request.payment_id !== refund.payment_id || Number(request.amount_paise) !== refund.amount) {
          console.error('[RAZORPAY_WEBHOOK_REFUND_MISMATCH]', {
            eventId,
            refundId: refund.id,
            paymentId: refund.payment_id,
          });
        } else {
          const nextStatus = event.event === 'refund.processed'
            ? 'processed'
            : event.event === 'refund.failed'
              ? 'failed'
              : 'pending';
          const canUpdate = request.status !== 'processed' &&
            !(request.status === 'failed' && nextStatus === 'pending');
          if (canUpdate) {
            await connection.query(
              `UPDATE return_refund_requests
               SET provider_refund_id = COALESCE(provider_refund_id, ?), status = ?,
                   failure_code = CASE WHEN ? = 'failed' THEN 'PROVIDER_REFUND_FAILED' ELSE NULL END
               WHERE id = ?`,
              [refund.id, nextStatus, nextStatus, request.id]
            );
            const returnStatus = nextStatus === 'processed'
              ? 'refunded'
              : nextStatus === 'pending'
                ? 'refund_pending'
                : 'received';
            await connection.query(
              `UPDATE returns SET status = ?
               WHERE id = ? AND status IN ('received', 'refund_pending')`,
              [returnStatus, request.return_id]
            );
            if (nextStatus === 'processed') {
              await reconcileShoppingWalletRewardRefund(connection, request.order_id);
            }
            updated = true;
          }
        }
      }
    }

    await connection.commit();
    transactionOpen = false;
    connection.release();
    connection = null;
    if (impactContributionId) {
      if (!await sendImpactCertificate(pool, impactContributionId)) {
        throw Object.assign(new Error('Impact certificate email delivery needs a webhook retry.'), { status: 503 });
      }
    }
    return { duplicate: false, updated };
  } catch (error) {
    if (transactionOpen) await connection.rollback();
    throw error;
  } finally {
    connection?.release();
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
