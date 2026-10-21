const SHOPPING_WALLET_REWARD_PERCENT = 10;
const NEW_CUSTOMER_BONUS_PERCENT = 5;
const SHOPPING_WALLET_REWARD_CAP = 500;

const roundMoney = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

const calculateShoppingWalletReward = (eligibleSubtotal, isNewCustomer = false) => {
  const percentage = SHOPPING_WALLET_REWARD_PERCENT + (isNewCustomer ? NEW_CUSTOMER_BONUS_PERCENT : 0);
  return roundMoney(Math.min(
    SHOPPING_WALLET_REWARD_CAP,
    Math.max(0, Number(eligibleSubtotal) || 0) * percentage / 100
  ));
};

const issueOrderShoppingWalletReward = async (connection, { userId, orderId, eligibleSubtotal }) => {
  const [[order]] = await connection.query(
    `SELECT user_id, shopping_wallet_reward_amount, shopping_wallet_reward_awarded_at
     FROM orders WHERE id = ? FOR UPDATE`,
    [orderId]
  );
  if (!order || order.shopping_wallet_reward_awarded_at) {
    return Number(order?.shopping_wallet_reward_amount) || 0;
  }

  if (String(order.user_id) !== String(userId)) {
    throw new Error('Shopping wallet reward owner does not match the order.');
  }

  await connection.query('SELECT id FROM users WHERE id = ? FOR UPDATE', [userId]);
  const [[previousOrder]] = await connection.query(
    `SELECT COUNT(*) AS order_count FROM orders
     WHERE user_id = ? AND id < ? AND status NOT IN ('cancelled', 'returned')
       AND (payment_status = 'paid' OR (payment_mode = 'COD' AND delivered_at IS NOT NULL))`,
    [userId, orderId]
  );
  const isNewCustomer = Number(previousOrder?.order_count) === 0;
  const grossReward = calculateShoppingWalletReward(eligibleSubtotal, isNewCustomer);
  const [offsets] = await connection.query(
    `SELECT id, amount_due FROM coupon_credit_offsets
     WHERE user_id = ? AND amount_due > 0
     ORDER BY id ASC FOR UPDATE`,
    [userId]
  );

  let rewardAmount = grossReward;
  for (const offset of offsets) {
    if (rewardAmount <= 0) break;
    const applied = roundMoney(Math.min(Number(offset.amount_due), rewardAmount));
    if (applied <= 0) continue;
    await connection.query(
      'UPDATE coupon_credit_offsets SET amount_due = GREATEST(0, amount_due - ?) WHERE id = ?',
      [applied, offset.id]
    );
    rewardAmount = roundMoney(rewardAmount - applied);
  }

  if (rewardAmount > 0) {
    await connection.query(
      'INSERT IGNORE INTO referral_wallets (user_id, balance) VALUES (?, 0.00)',
      [userId]
    );
    const [[wallet]] = await connection.query(
      'SELECT balance FROM referral_wallets WHERE user_id = ? FOR UPDATE',
      [userId]
    );
    const balance = roundMoney((Number(wallet?.balance) || 0) + rewardAmount);
    await connection.query('UPDATE referral_wallets SET balance = ? WHERE user_id = ?', [balance, userId]);
    await connection.query(
      `INSERT INTO referral_wallet_transactions
       (user_id, amount, type, description, reference_id, order_id)
       VALUES (?, ?, 'credit', ?, ?, ?)`,
      [
        userId,
        rewardAmount,
        `Shopping wallet reward${isNewCustomer ? ' including 5% new-customer bonus' : ''} for order #${orderId}`,
        `shopping-reward-order-${orderId}`,
        orderId,
      ]
    );
  }

  await connection.query(
    `UPDATE orders
     SET shopping_wallet_reward_amount = ?, shopping_wallet_reward_awarded_at = NOW()
     WHERE id = ? AND shopping_wallet_reward_awarded_at IS NULL`,
    [rewardAmount, orderId]
  );
  return rewardAmount;
};

const updateShoppingWalletRewardReversal = async (connection, { orderId, refundRatio = 1 }) => {
  const ratio = Math.max(0, Math.min(1, Number(refundRatio) || 0));
  const [[order]] = await connection.query(
    `SELECT user_id, shopping_wallet_reward_amount, shopping_wallet_reward_reversed_amount
     FROM orders WHERE id = ? FOR UPDATE`,
    [orderId]
  );
  if (!order || Number(order.shopping_wallet_reward_amount) <= 0) return 0;

  const targetReversedAmount = roundMoney(Number(order.shopping_wallet_reward_amount) * ratio);
  const alreadyReversedAmount = Number(order.shopping_wallet_reward_reversed_amount) || 0;
  const reversalDelta = roundMoney(Math.max(0, targetReversedAmount - alreadyReversedAmount));
  if (reversalDelta <= 0) return 0;

  await connection.query(
    'INSERT IGNORE INTO referral_wallets (user_id, balance) VALUES (?, 0.00)',
    [order.user_id]
  );
  const [[wallet]] = await connection.query(
    'SELECT balance FROM referral_wallets WHERE user_id = ? FOR UPDATE',
    [order.user_id]
  );
  const currentBalance = roundMoney(Number(wallet?.balance) || 0);
  const walletDebit = roundMoney(Math.min(currentBalance, reversalDelta));
  const offsetAmount = roundMoney(reversalDelta - walletDebit);

  if (walletDebit > 0) {
    const balance = roundMoney(currentBalance - walletDebit);
    await connection.query('UPDATE referral_wallets SET balance = ? WHERE user_id = ?', [balance, order.user_id]);
    await connection.query(
      `INSERT INTO referral_wallet_transactions
       (user_id, amount, type, description, reference_id, order_id)
       VALUES (?, ?, 'debit', ?, ?, ?)`,
      [
        order.user_id,
        walletDebit,
        `Shopping wallet reward reversed for refunded order #${orderId}`,
        `shopping-reward-refund-${orderId}-${Math.round(targetReversedAmount * 100)}`,
        orderId,
      ]
    );
  }
  if (offsetAmount > 0) {
    await connection.query(
      `INSERT INTO coupon_credit_offsets (user_id, source_order_id, amount_due)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE amount_due = amount_due + VALUES(amount_due)`,
      [order.user_id, orderId, offsetAmount]
    );
  }

  await connection.query(
    'UPDATE orders SET shopping_wallet_reward_reversed_amount = ? WHERE id = ?',
    [targetReversedAmount, orderId]
  );
  return reversalDelta;
};

const reconcileShoppingWalletRewardRefund = async (connection, orderId) => {
  const [[order]] = await connection.query(
    'SELECT total FROM orders WHERE id = ? FOR UPDATE',
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
  return updateShoppingWalletRewardReversal(connection, { orderId, refundRatio });
};

module.exports = {
  NEW_CUSTOMER_BONUS_PERCENT,
  SHOPPING_WALLET_REWARD_CAP,
  SHOPPING_WALLET_REWARD_PERCENT,
  calculateShoppingWalletReward,
  issueOrderShoppingWalletReward,
  reconcileShoppingWalletRewardRefund,
  updateShoppingWalletRewardReversal,
};
