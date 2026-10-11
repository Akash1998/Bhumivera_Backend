const MAX_RECONCILIATION_ORDERS = 25;

const toPaise = value => {
  const match = String(value ?? '').match(/^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/);
  if (!match) return null;
  const paise = BigInt(match[1]) * 100n + BigInt((match[2] || '').padEnd(2, '0') || '0');
  return paise <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(paise) : null;
};

const reconcileOrderPayments = async ({ pool, razorpay, orderIds }) => {
  if (!Array.isArray(orderIds) || orderIds.length < 1 || orderIds.length > MAX_RECONCILIATION_ORDERS ||
      orderIds.some(id => !Number.isSafeInteger(id) || id < 1)) {
    throw Object.assign(new Error(`Provide between 1 and ${MAX_RECONCILIATION_ORDERS} valid order IDs.`), {
      statusCode: 400,
      code: 'INVALID_RECONCILIATION_ORDER_IDS',
    });
  }
  if (!razorpay?.payments?.fetch) {
    throw Object.assign(new Error('Razorpay payment lookup is not configured.'), {
      statusCode: 503,
      code: 'RAZORPAY_NOT_CONFIGURED',
    });
  }

  const uniqueIds = [...new Set(orderIds)];
  const placeholders = uniqueIds.map(() => '?').join(', ');
  const [orders] = await pool.query(
    `SELECT id, payment_id, payment_mode, payment_status, total
     FROM orders WHERE id IN (${placeholders})`,
    uniqueIds
  );
  const ordersById = new Map(orders.map(order => [Number(order.id), order]));
  const results = [];

  for (const orderId of uniqueIds) {
    const order = ordersById.get(orderId);
    if (!order) {
      results.push({ orderId, outcome: 'order_not_found' });
      continue;
    }
    if (order.payment_mode !== 'online') {
      results.push({ orderId, outcome: 'not_online_payment' });
      continue;
    }
    if (!order.payment_id) {
      results.push({ orderId, outcome: 'missing_payment_id', localStatus: order.payment_status });
      continue;
    }

    let payment;
    try {
      payment = await razorpay.payments.fetch(order.payment_id);
    } catch (error) {
      console.error('[ORDER_PAYMENT_RECONCILIATION_PROVIDER_ERROR]', {
        orderId,
        paymentId: order.payment_id,
        providerCode: error.code || null,
        providerStatus: error.statusCode || error.status || null,
      });
      results.push({
        orderId,
        paymentId: order.payment_id,
        localStatus: order.payment_status,
        outcome: 'provider_lookup_failed',
        providerErrorCode: error.code || 'PROVIDER_LOOKUP_FAILED',
      });
      continue;
    }

    const expectedAmountPaise = toPaise(order.total);
    const validProviderAmount = Number.isSafeInteger(payment?.amount) && payment.amount >= 0;
    const matches = payment?.id === order.payment_id &&
      payment.currency === 'INR' &&
      expectedAmountPaise !== null &&
      validProviderAmount &&
      payment.amount === expectedAmountPaise;
    let outcome;
    if (!matches) outcome = 'payment_details_mismatch';
    else if (payment.status !== 'captured') outcome = 'provider_not_captured';
    else if (order.payment_status !== 'paid') outcome = 'local_status_mismatch';
    else outcome = 'matched';

    results.push({
      orderId,
      paymentId: order.payment_id,
      localStatus: order.payment_status,
      providerStatus: payment?.status || null,
      currency: payment?.currency || null,
      expectedAmountPaise,
      providerAmountPaise: validProviderAmount ? payment.amount : null,
      outcome,
    });
  }

  return results;
};

module.exports = { MAX_RECONCILIATION_ORDERS, reconcileOrderPayments, toPaise };
