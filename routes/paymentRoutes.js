const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const { authenticateUser } = require('../middleware/authMiddleware');
const { getRazorpayClient, isValidPaymentSignature } = require('../services/razorpayService');

router.post('/create-order', authenticateUser, async (req, res) => {
  const amount = Number(req.body.amount);
  if (!Number.isSafeInteger(amount) || amount < 100) {
    return res.status(400).json({ success: false, message: 'Amount must be at least 100 paise.' });
  }

  if (req.body.currency && req.body.currency !== 'INR') {
    return res.status(400).json({ success: false, message: 'Only INR payments are supported.' });
  }

  try {
    const razorpay = getRazorpayClient();
    const order = await razorpay.orders.create({
      amount,
      currency: 'INR',
      receipt: `user-${req.user.id}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
      notes: { userId: String(req.user.id) },
    });
    return res.status(201).json({
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      key_id: process.env.RAZORPAY_KEY_ID,
    });
  } catch (error) {
    console.error('[RAZORPAY_CREATE_ORDER]', error);
    const status = error.statusCode === 401 || error.status === 401 ? 401 : 500;
    return res.status(status).json({
      success: false,
      message: status === 401 ? 'Razorpay authentication failed.' : 'Could not create the payment order.',
    });
  }
});

router.post('/verify-payment', authenticateUser, async (req, res) => {
  const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body;
  if (![orderId, paymentId, signature].every(value => typeof value === 'string' && value.trim())) {
    return res.status(400).json({ success: false, message: 'Payment order, payment ID, and signature are required.' });
  }
  if (!isValidPaymentSignature(orderId, paymentId, signature)) {
    return res.status(400).json({ success: false, message: 'Payment signature verification failed.' });
  }

  try {
    const razorpay = getRazorpayClient();
    const [order, payment] = await Promise.all([
      razorpay.orders.fetch(orderId),
      razorpay.payments.fetch(paymentId),
    ]);
    if (String(order.notes?.userId) !== String(req.user.id)) {
      return res.status(400).json({ success: false, message: 'Payment order does not belong to this account.' });
    }
    if (
      payment.order_id !== orderId ||
      payment.amount !== order.amount ||
      payment.currency !== order.currency ||
      !['authorized', 'captured'].includes(payment.status)
    ) {
      return res.status(400).json({ success: false, message: 'Payment does not match the Razorpay order.' });
    }
    return res.json({ success: true, order_id: orderId, payment_id: paymentId });
  } catch (error) {
    console.error('[RAZORPAY_VERIFY_PAYMENT]', error);
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.statusCode === 401 ? 'Razorpay authentication failed.' : 'Could not verify the payment.',
    });
  }
});

module.exports = router;
