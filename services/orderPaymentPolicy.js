const COD_REQUIRED_DELIVERED_ORDERS = 2;
const { ensureWalletAccount } = require('../utils/walletAccount');

const calculateReferralWalletRedemption = (balance, perOrderLimit, subtotal) => {
  const toCents = value => Math.round(Math.max(0, Number(value) || 0) * 100);
  return Math.min(toCents(balance), toCents(perOrderLimit), toCents(subtotal)) / 100;
};

const calculateTieredReferralWalletRedemption = (balance, orderSubtotal, tiers = [], eligibleSubtotal = orderSubtotal, welcomeBonusBalance = null) => {
  const toCents = value => Math.round(Math.max(0, Number(value) || 0) * 100);
  const orderCents = toCents(orderSubtotal);
  const eligibleCents = toCents(eligibleSubtotal);
  const totalBalanceCents = toCents(balance);
  const applicableTier = (Array.isArray(tiers) ? tiers : []).reduce((selected, tier) => {
    const minimumOrderCents = toCents(tier?.min_order_amount);
    const referralLimitCents = toCents(tier?.referral_amount);
    if (referralLimitCents === 0 || minimumOrderCents > orderCents) return selected;
    return !selected || minimumOrderCents > selected.minimumOrderCents
      ? { minimumOrderCents, referralLimitCents }
      : selected;
  }, null);
  const maxReferral = applicableTier?.referralLimitCents || 0;

  if (welcomeBonusBalance !== null && welcomeBonusBalance !== undefined) {
    const welcomeCents = Math.min(totalBalanceCents, toCents(welcomeBonusBalance));
    const referralCents = Math.max(0, totalBalanceCents - welcomeCents);

    const maxWelcome = orderCents >= 79900 ? 10000 : 0;

    const redeemWelcome = Math.min(welcomeCents, maxWelcome);
    const redeemReferral = Math.min(referralCents, maxReferral);

    return Math.min(eligibleCents, redeemWelcome + redeemReferral) / 100;
  }

  return Math.min(totalBalanceCents, eligibleCents, maxReferral) / 100;
};

const assertCodEligibility = (paymentMode, deliveredOrderCount) => {
  if (paymentMode === 'COD' && deliveredOrderCount < COD_REQUIRED_DELIVERED_ORDERS) {
    throw Object.assign(
      new Error(`Cash on delivery becomes available after ${COD_REQUIRED_DELIVERED_ORDERS} orders have been successfully delivered.`),
      { status: 403, code: 'COD_DELIVERY_REQUIREMENT' }
    );
  }
};

const debitWalletForOrder = async (connection, userId, amount, orderId) => {
  await ensureWalletAccount(connection, userId);
  const [[wallet]] = await connection.query(
    'SELECT balance FROM wallets WHERE user_id = ? FOR UPDATE',
    [userId]
  );
  const currentBalance = Number(wallet?.balance) || 0;
  if (currentBalance < amount) {
    throw Object.assign(new Error('Your wallet balance is insufficient for this order.'), {
      status: 400,
      code: 'INSUFFICIENT_WALLET_BALANCE',
    });
  }

  const newBalance = currentBalance - amount;
  await connection.query('UPDATE wallets SET balance = ? WHERE user_id = ?', [newBalance, userId]);
  await connection.query('UPDATE users SET wallet_balance = ? WHERE id = ?', [newBalance, userId]);
  await connection.query(
    'INSERT INTO wallet_transactions (user_id, amount, type, description, reference_id) VALUES (?, ?, ?, ?, ?)',
    [userId, amount, 'debit', `Order payment #${orderId}`, String(orderId)]
  );
};

module.exports = {
  assertCodEligibility,
  calculateReferralWalletRedemption,
  calculateTieredReferralWalletRedemption,
  debitWalletForOrder,
  COD_REQUIRED_DELIVERED_ORDERS,
};
