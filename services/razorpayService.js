const crypto = require('crypto');
const Razorpay = require('razorpay');

const getRazorpayClient = () => {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId?.trim() || !keySecret?.trim()) {
    const error = new Error('Razorpay credentials are not configured on the backend.');
    error.code = 'RAZORPAY_NOT_CONFIGURED';
    error.statusCode = 503;
    throw error;
  }
  return new Razorpay({ key_id: keyId, key_secret: keySecret });
};

const isValidPaymentSignature = (orderId, paymentId, signature) => {
  if (![orderId, paymentId, signature].every(value => typeof value === 'string' && value.length > 0)) {
    return false;
  }
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || '')
    .update(`${orderId}|${paymentId}`)
    .digest();
  let received;
  try {
    received = Buffer.from(signature, 'hex');
  } catch {
    return false;
  }
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
};

const verifyRazorpayPayment = async ({
  orderId,
  paymentId,
  signature,
  userId,
  expectedAmount,
}) => {
  if (!isValidPaymentSignature(orderId, paymentId, signature)) {
    const error = new Error('Payment signature verification failed.');
    error.statusCode = 400;
    throw error;
  }

  const razorpay = getRazorpayClient();
  const [order, fetchedPayment] = await Promise.all([
    razorpay.orders.fetch(orderId),
    razorpay.payments.fetch(paymentId),
  ]);

  if (String(order.notes?.userId) !== String(userId)) {
    const error = new Error('Payment order does not belong to this account.');
    error.statusCode = 400;
    throw error;
  }

  if (
    fetchedPayment.order_id !== orderId ||
    fetchedPayment.amount !== order.amount ||
    fetchedPayment.currency !== order.currency ||
    (expectedAmount !== undefined && order.amount !== expectedAmount)
  ) {
    const error = new Error('Payment amount or status does not match this order.');
    error.statusCode = 400;
    throw error;
  }

  const payment = fetchedPayment.status === 'authorized' && expectedAmount !== undefined
    ? await razorpay.payments.capture(paymentId, order.amount, order.currency)
    : fetchedPayment;

  if (
    payment.status !== 'captured' ||
    payment.order_id !== orderId ||
    payment.amount !== order.amount ||
    payment.currency !== order.currency
  ) {
    const error = new Error('Payment amount or status does not match this order.');
    error.statusCode = 400;
    throw error;
  }

  return { order, payment };
};

module.exports = { getRazorpayClient, isValidPaymentSignature, verifyRazorpayPayment };
