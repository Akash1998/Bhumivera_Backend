const crypto = require('crypto');
const pool = require('../config/db');

const defaultConfig = {
  enabled: 1,
  reward_mode: 'wallet',
  wallet_reward_amount: 100,
  coupon_discount_type: 'fixed',
  coupon_discount_value: 100,
  coupon_min_order_amount: 0,
  coupon_valid_days: 30,
};

const signingSecret = () => {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET must be configured to issue secure referral links.');
  return process.env.JWT_SECRET;
};
const signReferralId = id => crypto.createHmac('sha256', signingSecret()).update(String(id)).digest('hex');

const verifyReferralToken = async token => {
  if (typeof token !== 'string') return null;
  const match = token.match(/^([1-9]\d*)\.([a-f0-9]{64})$/i);
  if (!match) return null;
  const id = Number(match[1]);
  if (!Number.isSafeInteger(id)) return null;
  const expected = Buffer.from(signReferralId(id), 'hex');
  const supplied = Buffer.from(match[2], 'hex');
  if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) return null;
  const [rows] = await pool.query('SELECT id FROM users WHERE id = ? AND role = \'customer\' AND is_active = 1', [id]);
  return rows[0]?.id || null;
};

const findReferralUser = async code => {
  const normalized = String(code || '').trim().toUpperCase();
  if (!/^[A-Z0-9-]{4,32}$/.test(normalized)) return null;
  const [rows] = await pool.query(
    `SELECT rc.user_id FROM referral_codes rc
     JOIN users u ON u.id = rc.user_id
     WHERE rc.code = ? AND u.role = 'customer' AND u.is_active = 1`,
    [normalized]
  );
  return rows[0]?.user_id || null;
};

const ensureReferralCode = async userId => {
  const [customers] = await pool.query("SELECT id FROM users WHERE id = ? AND role = 'customer' AND is_active = 1", [userId]);
  if (!customers.length) throw new Error('A customer account is required to create a referral link.');
  const [existing] = await pool.query('SELECT code FROM referral_codes WHERE user_id = ?', [userId]);
  if (existing.length) return existing[0].code;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = `BV${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
    try {
      await pool.query('INSERT INTO referral_codes (user_id, code) VALUES (?, ?)', [userId, code]);
      return code;
    } catch (error) {
      if (error.code !== 'ER_DUP_ENTRY') throw error;
      const [concurrentCode] = await pool.query('SELECT code FROM referral_codes WHERE user_id = ?', [userId]);
      if (concurrentCode.length) return concurrentCode[0].code;
    }
  }
  throw new Error('Could not create a unique referral code.');
};

const getReferralConfig = async () => {
  const [rows] = await pool.query('SELECT * FROM referral_settings WHERE id = 1');
  return { ...defaultConfig, ...(rows[0] || {}) };
};

const saveReferralConfig = async config => {
  const settings = {
    enabled: config.enabled ? 1 : 0,
    reward_mode: config.reward_mode,
    wallet_reward_amount: Number(config.wallet_reward_amount),
    coupon_discount_type: config.coupon_discount_type,
    coupon_discount_value: Number(config.coupon_discount_value),
    coupon_min_order_amount: Number(config.coupon_min_order_amount),
    coupon_valid_days: Number(config.coupon_valid_days),
  };
  await pool.query(
    `INSERT INTO referral_settings
      (id, enabled, reward_mode, wallet_reward_amount, coupon_discount_type, coupon_discount_value, coupon_min_order_amount, coupon_valid_days)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), reward_mode = VALUES(reward_mode),
       wallet_reward_amount = VALUES(wallet_reward_amount), coupon_discount_type = VALUES(coupon_discount_type),
       coupon_discount_value = VALUES(coupon_discount_value), coupon_min_order_amount = VALUES(coupon_min_order_amount),
       coupon_valid_days = VALUES(coupon_valid_days)`,
    Object.values(settings)
  );
  return settings;
};

const getReferralSummary = async userId => {
  const code = await ensureReferralCode(userId);
  const [[summary]] = await pool.query(
    `SELECT COUNT(DISTINCT u.id) AS referrals,
       COALESCE(SUM(rr.wallet_amount), 0) AS wallet_earned,
       COUNT(rr.id) AS rewarded_referrals
     FROM users u
     LEFT JOIN referral_rewards rr ON rr.referred_user_id = u.id
     WHERE u.referred_by_user_id = ?`,
    [userId]
  );
  const [referrals] = await pool.query(
    `SELECT referred.id, referred.name, referred.created_at,
       rr.wallet_amount, rr.coupon_code, rr.created_at AS rewarded_at
     FROM users referred
     LEFT JOIN referral_rewards rr ON rr.referred_user_id = referred.id
     WHERE referred.referred_by_user_id = ?
     ORDER BY referred.created_at DESC
     LIMIT 100`,
    [userId]
  );
  const config = await getReferralConfig();
  const token = `${userId}.${signReferralId(userId)}`;
  return {
    code,
    referralUrl: `${process.env.FRONTEND_URL || 'https://www.bhumivera.com'}/register?ref=${encodeURIComponent(token)}`,
    ...summary,
    referrals,
    rewardMode: config.reward_mode,
  };
};

const applyReferralRewardForOrder = async orderId => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [orders] = await connection.query(
      `SELECT o.id, o.user_id, o.status, u.referred_by_user_id
       FROM orders o JOIN users u ON u.id = o.user_id
       WHERE o.id = ? FOR UPDATE`,
      [orderId]
    );
    const order = orders[0];
    if (!order || order.status !== 'delivered' || !order.referred_by_user_id) {
      await connection.commit();
      return;
    }
    const [prior] = await connection.query(
      'SELECT id FROM referral_rewards WHERE referred_user_id = ? OR order_id = ? FOR UPDATE',
      [order.user_id, order.id]
    );
    if (prior.length) {
      await connection.commit();
      return;
    }
    const [configs] = await connection.query('SELECT * FROM referral_settings WHERE id = 1');
    const config = { ...defaultConfig, ...(configs[0] || {}) };
    if (!Number(config.enabled)) {
      await connection.commit();
      return;
    }

    const shouldCreditWallet = ['wallet', 'wallet_coupon'].includes(config.reward_mode);
    const shouldIssueCoupon = ['coupon', 'wallet_coupon'].includes(config.reward_mode);
    const walletAmount = shouldCreditWallet ? Number(config.wallet_reward_amount) : 0;
    let couponCode = null;
    if (shouldIssueCoupon) {
      couponCode = `REF${order.referred_by_user_id}${crypto.randomBytes(4).toString('hex').toUpperCase()}`.slice(0, 50);
      await connection.query(
        `INSERT INTO coupons
          (code, description, discount_type, discount_value, min_order_amount, restricted_user_id, is_active, valid_from, expires_at)
         VALUES (?, 'Referral reward', ?, ?, ?, ?, 1, NOW(), DATE_ADD(NOW(), INTERVAL ? DAY))`,
        [couponCode, config.coupon_discount_type, config.coupon_discount_value, config.coupon_min_order_amount, order.referred_by_user_id, config.coupon_valid_days]
      );
    }
    await connection.query(
      `INSERT INTO referral_rewards
        (referred_user_id, referrer_user_id, order_id, wallet_amount, coupon_code)
       VALUES (?, ?, ?, ?, ?)`,
      [order.user_id, order.referred_by_user_id, order.id, walletAmount, couponCode]
    );
    if (walletAmount > 0) {
      await connection.query('INSERT IGNORE INTO wallets (user_id, balance) VALUES (?, 0.00)', [order.referred_by_user_id]);
      await connection.query('UPDATE wallets SET balance = balance + ? WHERE user_id = ?', [walletAmount, order.referred_by_user_id]);
      await connection.query('UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?', [walletAmount, order.referred_by_user_id]);
      await connection.query(
        `INSERT INTO wallet_transactions (user_id, amount, type, description, reference_id)
         VALUES (?, ?, 'credit', 'Referral reward for a delivered order', ?)`,
        [order.referred_by_user_id, walletAmount, `referral-order-${order.id}`]
      );
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
};

module.exports = {
  defaultConfig,
  ensureReferralCode,
  findReferralUser,
  verifyReferralToken,
  getReferralConfig,
  saveReferralConfig,
  getReferralSummary,
  applyReferralRewardForOrder,
};
