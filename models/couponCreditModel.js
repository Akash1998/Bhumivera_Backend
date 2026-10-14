const crypto = require('node:crypto');

const COUPON_CREDIT_PERCENT = 10;
const COUPON_CREDIT_CAP = 500;
const COUPON_CREDIT_VALID_DAYS = 90;

const roundMoney = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

const calculateCouponCredit = eligibleSubtotal => roundMoney(Math.min(
  COUPON_CREDIT_CAP,
  Math.max(0, Number(eligibleSubtotal) || 0) * COUPON_CREDIT_PERCENT / 100
));

const issueOrderCouponCredit = async (connection, { userId, orderId, eligibleSubtotal }) => {
  const [[existing]] = await connection.query(
    'SELECT id, discount_value FROM coupons WHERE reward_order_id = ? FOR UPDATE',
    [orderId]
  );
  if (existing) return Number(existing.discount_value) || 0;

  const [offsets] = await connection.query(
    `SELECT id, amount_due FROM coupon_credit_offsets
     WHERE user_id = ? AND amount_due > 0
     ORDER BY id ASC FOR UPDATE`,
    [userId]
  );
  const grossCredit = calculateCouponCredit(eligibleSubtotal);
  let creditAmount = grossCredit;

  for (const offset of offsets) {
    if (creditAmount <= 0) break;
    const applied = roundMoney(Math.min(Number(offset.amount_due), creditAmount));
    if (applied <= 0) continue;
    await connection.query(
      'UPDATE coupon_credit_offsets SET amount_due = GREATEST(0, amount_due - ?) WHERE id = ?',
      [applied, offset.id]
    );
    creditAmount = roundMoney(creditAmount - applied);
  }

  if (creditAmount > 0) {
    const code = `BV10-${orderId}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
    await connection.query(
      `INSERT INTO coupons
        (code, description, discount_type, discount_value, min_order_amount, usage_limit,
         restricted_user_id, is_active, valid_from, expires_at, reward_type, reward_order_id)
       VALUES (?, ?, 'fixed', ?, 0, 1, ?, 1, NOW(), DATE_ADD(NOW(), INTERVAL ? DAY), 'coupon_credit', ?)`,
      [
        code,
        `10% order reward credit (up to ₹${COUPON_CREDIT_CAP}); valid for ${COUPON_CREDIT_VALID_DAYS} days.`,
        creditAmount,
        userId,
        COUPON_CREDIT_VALID_DAYS,
        orderId,
      ]
    );
  }

  await connection.query(
    `UPDATE orders
     SET coupon_credit_awarded_amount = ?, coupon_credit_awarded_at = NOW()
     WHERE id = ? AND coupon_credit_awarded_at IS NULL`,
    [creditAmount, orderId]
  );
  return creditAmount;
};

const updateCouponCreditReversal = async (connection, { orderId, refundRatio = 1 }) => {
  const ratio = Math.max(0, Math.min(1, Number(refundRatio) || 0));
  const [[order]] = await connection.query(
    `SELECT user_id, coupon_credit_awarded_amount, coupon_credit_reversed_amount
     FROM orders WHERE id = ? FOR UPDATE`,
    [orderId]
  );
  if (!order || Number(order.coupon_credit_awarded_amount) <= 0) return 0;

  const issuedAmount = Number(order.coupon_credit_awarded_amount);
  const targetReversedAmount = roundMoney(issuedAmount * ratio);
  const alreadyReversedAmount = Number(order.coupon_credit_reversed_amount) || 0;
  const reversalDelta = roundMoney(Math.max(0, targetReversedAmount - alreadyReversedAmount));
  if (reversalDelta <= 0) return 0;

  const [[coupon]] = await connection.query(
    `SELECT id, used_count, discount_value FROM coupons
     WHERE reward_order_id = ? FOR UPDATE`,
    [orderId]
  );
  if (!coupon) return 0;

  if (Number(coupon.used_count) > 0) {
    await connection.query(
      `INSERT INTO coupon_credit_offsets (user_id, source_order_id, amount_due)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE amount_due = amount_due + VALUES(amount_due)`,
      [order.user_id, orderId, reversalDelta]
    );
  } else {
    const remainingCredit = roundMoney(Math.max(0, Number(coupon.discount_value) - reversalDelta));
    await connection.query(
      `UPDATE coupons
       SET discount_value = ?, is_active = ?
       WHERE id = ? AND used_count = 0`,
      [remainingCredit, remainingCredit > 0 ? 1 : 0, coupon.id]
    );
  }
  await connection.query(
    'UPDATE orders SET coupon_credit_reversed_amount = ? WHERE id = ?',
    [targetReversedAmount, orderId]
  );
  return reversalDelta;
};

const reconcileCouponCreditRefund = async (connection, orderId) => {
  const [[order]] = await connection.query(
    `SELECT total FROM orders WHERE id = ? FOR UPDATE`,
    [orderId]
  );
  if (!order || Number(order.total) <= 0) return 0;

  const [[refunds]] = await connection.query(
    `SELECT COALESCE(SUM(amount_paise), 0) AS refunded_paise
     FROM return_refund_requests
     WHERE order_id = ? AND status = 'processed'`,
    [orderId]
  );
  const refundRatio = Math.min(1, Number(refunds?.refunded_paise || 0) /
    (Number(order.total) * 100));
  return updateCouponCreditReversal(connection, { orderId, refundRatio });
};

module.exports = {
  COUPON_CREDIT_CAP,
  COUPON_CREDIT_PERCENT,
  COUPON_CREDIT_VALID_DAYS,
  calculateCouponCredit,
  issueOrderCouponCredit,
  reconcileCouponCreditRefund,
  updateCouponCreditReversal,
};
