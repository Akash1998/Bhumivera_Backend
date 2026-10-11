const crypto = require('crypto');
const pool = require('../config/db');
const { sendMail } = require('../utils/mail');

const REFERRAL_LINK_DAYS = 90;
const AUTO_APPROVAL_MINUTES = 60;
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
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'fallback_secret') {
    throw new Error('A secure JWT_SECRET must be configured to issue referral links.');
  }
  return process.env.JWT_SECRET;
};

const signReferralPayload = payload => crypto
  .createHmac('sha256', signingSecret())
  .update(payload)
  .digest('hex');

const createReferralToken = (userId, expiresAt) => {
  const expiry = Math.floor(expiresAt.getTime() / 1000);
  const payload = `${userId}.${expiry}`;
  return `${payload}.${signReferralPayload(payload)}`;
};

const verifyReferralToken = async token => {
  if (typeof token !== 'string') return null;
  const match = token.match(/^([1-9]\d*)\.(\d{10})\.([a-f0-9]{64})$/i);
  if (!match) return null;
  const userId = Number(match[1]);
  const expiry = Number(match[2]);
  if (!Number.isSafeInteger(userId) || expiry <= Math.floor(Date.now() / 1000)) return null;
  const payload = `${match[1]}.${match[2]}`;
  const expected = Buffer.from(signReferralPayload(payload), 'hex');
  const supplied = Buffer.from(match[3], 'hex');
  if (!crypto.timingSafeEqual(expected, supplied)) return null;
  const [rows] = await pool.query(
    "SELECT id FROM users WHERE id = ? AND role = 'customer' AND is_active = 1",
    [userId]
  );
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
  const [customers] = await pool.query(
    "SELECT id FROM users WHERE id = ? AND role = 'customer' AND is_active = 1",
    [userId]
  );
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

const getReferralConfig = async (connection = pool) => {
  const [rows] = await connection.query('SELECT * FROM referral_settings WHERE id = 1');
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

const createReferralClaim = async (connection, referredUserId, referrerUserId) => {
  if (!referrerUserId) return null;
  if (Number(referrerUserId) === Number(referredUserId)) {
    throw new Error('A customer cannot refer their own account.');
  }
  const config = await getReferralConfig(connection);
  if (!Number(config.enabled)) return null;
  const [result] = await connection.query(
    `INSERT INTO referral_claims
      (referred_user_id, referrer_user_id, status, verified_at, auto_approve_at)
     VALUES (?, ?, 'pending', NOW(), DATE_ADD(NOW(), INTERVAL ? MINUTE))`,
    [referredUserId, referrerUserId, AUTO_APPROVAL_MINUTES]
  );
  return result.insertId;
};

const getReferralSummary = async userId => {
  await reconcileReferralRewards(userId);
  const code = await ensureReferralCode(userId);
  const [codeRows] = await pool.query('SELECT link_expires_at FROM referral_codes WHERE user_id = ?', [userId]);
  let expiresAt = codeRows[0]?.link_expires_at ? new Date(codeRows[0].link_expires_at) : null;
  if (!expiresAt || expiresAt.getTime() <= Date.now()) {
    expiresAt = new Date(Date.now() + REFERRAL_LINK_DAYS * 24 * 60 * 60 * 1000);
    await pool.query('UPDATE referral_codes SET link_expires_at = ? WHERE user_id = ?', [expiresAt, userId]);
  }
  const [referrals] = await pool.query(
    `SELECT c.id, c.status, c.verified_at, c.auto_approve_at, c.reviewed_at, c.decision_reason,
       c.wallet_amount, c.coupon_code, u.name, u.created_at
     FROM referral_claims c
     JOIN users u ON u.id = c.referred_user_id
     WHERE c.referrer_user_id = ?
     ORDER BY c.verified_at DESC
     LIMIT 100`,
    [userId]
  );
  const [[summary]] = await pool.query(
    `SELECT COUNT(*) AS referrals,
       COALESCE(SUM(wallet_amount), 0) AS wallet_earned,
       SUM(status IN ('approved', 'auto_approved')) AS rewarded_referrals,
       SUM(status = 'pending') AS pending_referrals
     FROM referral_claims WHERE referrer_user_id = ?`,
    [userId]
  );
  const config = await getReferralConfig();
  const token = createReferralToken(userId, expiresAt);
  const frontendUrl = (process.env.FRONTEND_URL || 'https://www.bhumivera.com').replace(/\/+$/, '');
  return {
    code,
    referralUrl: `${frontendUrl}/register?ref=${encodeURIComponent(token)}`,
    referralExpiresAt: expiresAt.toISOString(),
    referralCount: Number(summary.referrals) || 0,
    wallet_earned: Number(summary.wallet_earned) || 0,
    rewarded_referrals: Number(summary.rewarded_referrals) || 0,
    pending_referrals: Number(summary.pending_referrals) || 0,
    referrals,
    rewardMode: config.reward_mode,
  };
};

const createRewardForClaim = async (connection, claim, config) => {
  const shouldCreditWallet = ['wallet', 'wallet_coupon'].includes(config.reward_mode);
  const shouldIssueCoupon = ['coupon', 'wallet_coupon'].includes(config.reward_mode);
  const walletAmount = shouldCreditWallet ? Number(config.wallet_reward_amount) : 0;
  let couponCode = null;

  if (shouldIssueCoupon) {
    couponCode = `REF${claim.referrer_user_id}${crypto.randomBytes(5).toString('hex').toUpperCase()}`.slice(0, 50);
    await connection.query(
      `INSERT INTO coupons
        (code, description, discount_type, discount_value, min_order_amount, usage_limit, restricted_user_id, is_active, valid_from, expires_at)
       VALUES (?, 'Referral reward', ?, ?, ?, 1, ?, 1, NOW(), DATE_ADD(NOW(), INTERVAL ? DAY))`,
      [
        couponCode,
        config.coupon_discount_type,
        config.coupon_discount_value,
        config.coupon_min_order_amount,
        claim.referrer_user_id,
        config.coupon_valid_days,
      ]
    );
  }

  if (walletAmount > 0) {
    await connection.query(
      `INSERT IGNORE INTO wallets (user_id, balance)
       SELECT id, COALESCE(wallet_balance, 0.00) FROM users WHERE id = ?`,
      [claim.referrer_user_id]
    );
    const [[wallet]] = await connection.query(
      `SELECT w.balance, u.wallet_balance
       FROM wallets w JOIN users u ON u.id = w.user_id
       WHERE w.user_id = ? FOR UPDATE`,
      [claim.referrer_user_id]
    );
    const balance = Math.max(Number(wallet?.balance) || 0, Number(wallet?.wallet_balance) || 0);
    await connection.query('UPDATE wallets SET balance = ? WHERE user_id = ?', [balance + walletAmount, claim.referrer_user_id]);
    await connection.query(
      'UPDATE users SET wallet_balance = ? WHERE id = ?',
      [balance + walletAmount, claim.referrer_user_id]
    );
    await connection.query(
      `INSERT INTO wallet_transactions (user_id, amount, type, description, reference_id)
       VALUES (?, ?, 'credit', 'Approved referral reward', ?)`,
      [claim.referrer_user_id, walletAmount, `referral-claim-${claim.id}`]
    );
  }

  await connection.query(
    `INSERT INTO referral_rewards
      (referred_user_id, referrer_user_id, order_id, wallet_amount, coupon_code)
     VALUES (?, ?, NULL, ?, ?)`,
    [claim.referred_user_id, claim.referrer_user_id, walletAmount, couponCode]
  );
  return { walletAmount, couponCode };
};

const reconcileReferralRewards = async userId => {
  const [claims] = await pool.query(
    `SELECT id FROM referral_claims
     WHERE referrer_user_id = ? AND status IN ('approved', 'auto_approved')
       AND (wallet_amount > 0 OR coupon_code IS NOT NULL)`,
    [userId]
  );

  for (const row of claims) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [lockedClaims] = await connection.query(
        `SELECT * FROM referral_claims
         WHERE id = ? AND referrer_user_id = ?
           AND status IN ('approved', 'auto_approved')
         FOR UPDATE`,
        [row.id, userId]
      );
      const claim = lockedClaims[0];
      if (!claim) {
        await connection.commit();
        continue;
      }

      if (Number(claim.wallet_amount) > 0) {
        const reference = `referral-claim-${claim.id}`;
        await connection.query(
          `INSERT IGNORE INTO wallets (user_id, balance)
           SELECT id, COALESCE(wallet_balance, 0.00) FROM users WHERE id = ?`,
          [userId]
        );
        const [transactions] = await connection.query(
          'SELECT id FROM wallet_transactions WHERE user_id = ? AND reference_id = ? LIMIT 1',
          [userId, reference]
        );
        if (!transactions.length) {
          const walletAmount = Number(claim.wallet_amount);
          const [[wallet]] = await connection.query(
            `SELECT w.balance, u.wallet_balance
             FROM wallets w JOIN users u ON u.id = w.user_id
             WHERE w.user_id = ? FOR UPDATE`,
            [userId]
          );
          const balance = Math.max(Number(wallet?.balance) || 0, Number(wallet?.wallet_balance) || 0);
          await connection.query('UPDATE wallets SET balance = ? WHERE user_id = ?', [balance + walletAmount, userId]);
          await connection.query(
            'UPDATE users SET wallet_balance = ? WHERE id = ?',
            [balance + walletAmount, userId]
          );
          await connection.query(
            `INSERT INTO wallet_transactions (user_id, amount, type, description, reference_id)
             VALUES (?, ?, 'credit', 'Approved referral reward', ?)`,
            [userId, walletAmount, reference]
          );
        } else {
          const [[wallet]] = await connection.query(
            `SELECT w.balance, u.wallet_balance
             FROM wallets w JOIN users u ON u.id = w.user_id
             WHERE w.user_id = ? FOR UPDATE`,
            [userId]
          );
          const [[ledger]] = await connection.query(
            `SELECT COALESCE(SUM(CASE WHEN type = 'credit' THEN amount ELSE -amount END), 0) AS balance
             FROM wallet_transactions WHERE user_id = ?`,
            [userId]
          );
          const repairedBalance = Math.max(
            Number(wallet?.balance) || 0,
            Number(wallet?.wallet_balance) || 0,
            Number(ledger?.balance) || 0
          );
          if (repairedBalance > (Number(wallet?.balance) || 0)) {
            await connection.query('UPDATE wallets SET balance = ? WHERE user_id = ?', [repairedBalance, userId]);
            await connection.query(
              'UPDATE users SET wallet_balance = GREATEST(COALESCE(wallet_balance, 0), ?) WHERE id = ?',
              [repairedBalance, userId]
            );
          }
        }
      }

      if (claim.coupon_code) {
        const [coupons] = await connection.query(
          'SELECT id, restricted_user_id, usage_limit FROM coupons WHERE code = ? FOR UPDATE',
          [claim.coupon_code]
        );
        if (!coupons.length) {
          const config = await getReferralConfig(connection);
          await connection.query(
            `INSERT INTO coupons
              (code, description, discount_type, discount_value, min_order_amount, usage_limit, restricted_user_id, is_active, valid_from, expires_at)
             VALUES (?, 'Referral reward', ?, ?, ?, 1, ?, 1, NOW(), DATE_ADD(NOW(), INTERVAL ? DAY))`,
            [
              claim.coupon_code,
              config.coupon_discount_type,
              config.coupon_discount_value,
              config.coupon_min_order_amount,
              userId,
              config.coupon_valid_days,
            ]
          );
        } else if (String(coupons[0].restricted_user_id) !== String(userId) || Number(coupons[0].usage_limit) !== 1) {
          await connection.query(
            'UPDATE coupons SET restricted_user_id = ?, usage_limit = 1 WHERE id = ?',
            [userId, coupons[0].id]
          );
        }
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
};

const decideReferralClaim = async (claimId, decision, adminId = null, reason = null, automatic = false) => {
  if (!['approved', 'rejected'].includes(decision)) {
    throw Object.assign(new Error('Choose approve or reject.'), { status: 400 });
  }
  const connection = await pool.getConnection();
  let notification = null;
  try {
    await connection.beginTransaction();
    const [claims] = await connection.query(
      'SELECT *, (auto_approve_at <= NOW()) AS auto_approval_due FROM referral_claims WHERE id = ? FOR UPDATE',
      [claimId]
    );
    const claim = claims[0];
    if (!claim) {
      await connection.rollback();
      throw Object.assign(new Error('Referral was not found.'), { status: 404 });
    }
    if (claim.status !== 'pending') {
      await connection.rollback();
      return { alreadyDecided: true, status: claim.status };
    }
    if (automatic && Number(claim.auto_approval_due) !== 1) {
      await connection.rollback();
      return { notDue: true };
    }

    let reward = { walletAmount: 0, couponCode: null };
    if (decision === 'approved') {
      const config = await getReferralConfig(connection);
      if (!Number(config.enabled)) {
        await connection.rollback();
        if (automatic) return { disabled: true };
        throw Object.assign(new Error('Referral rewards are paused. Enable the program before approving rewards.'), { status: 409 });
      }
      reward = await createRewardForClaim(connection, claim, config);
    }

    const status = automatic ? 'auto_approved' : decision;
    await connection.query(
      `UPDATE referral_claims
       SET status = ?, reviewed_at = NOW(), reviewed_by_admin_id = ?, decision_reason = ?,
           wallet_amount = ?, coupon_code = ?
       WHERE id = ? AND status = 'pending'`,
      [status, automatic ? null : adminId, decision === 'rejected' ? reason : null, reward.walletAmount, reward.couponCode, claim.id]
    );
    notification = {
      referrerUserId: claim.referrer_user_id,
      referredUserId: claim.referred_user_id,
      status,
      reason,
      ...reward,
    };
    await connection.commit();
  } catch (error) {
    if (connection) await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  notifyReferralDecision(notification).catch(error => console.error('[REFERRAL_DECISION_EMAIL]', error));
  return { ...notification, alreadyDecided: false };
};

const notifyReferralDecision = async notification => {
  const [users] = await pool.query(
    'SELECT id, name, email FROM users WHERE id IN (?, ?)',
    [notification.referrerUserId, notification.referredUserId]
  );
  const statusMessage = notification.status === 'rejected'
    ? `Your referral was not approved. ${notification.reason || 'Please contact support if you think this is incorrect.'}`
    : `Your referral was ${notification.status === 'auto_approved' ? 'automatically approved' : 'approved'}.`;
  const rewardMessage = [
    notification.walletAmount > 0 ? `₹${Number(notification.walletAmount).toFixed(2)} was added to your wallet.` : '',
    notification.couponCode ? `Your personal coupon code is ${notification.couponCode}.` : '',
  ].filter(Boolean).join(' ');
  const safe = value => String(value || '').replace(/[&<>"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  })[character]);
  const recipients = users.filter(user => user.email);
  const messages = recipients.map(user => sendMail({
    to: user.email,
    subject: notification.status === 'rejected' ? 'Bhumivera referral update' : 'Your Bhumivera referral reward is ready',
    html: `<p>Hi ${safe(user.name || 'there')},</p><p>${safe(statusMessage)}</p><p>${safe(rewardMessage)}</p><p>Open your Bhumivera account to see your referral status and any rewards.</p>`,
    text: `Hi ${user.name || 'there'}, ${statusMessage} ${rewardMessage} Open your Bhumivera account to see your referral status and rewards.`,
  }));
  const results = await Promise.allSettled(messages);
  results.filter(result => result.status === 'rejected').forEach(result => {
    console.error('[REFERRAL_DECISION_EMAIL_DELIVERY]', result.reason);
  });
};

const approveDueReferralClaims = async () => {
  const [dueClaims] = await pool.query(
    `SELECT id FROM referral_claims
     WHERE status = 'pending' AND auto_approve_at <= NOW()
     ORDER BY auto_approve_at ASC LIMIT 100`
  );
  for (const claim of dueClaims) {
    try {
      await decideReferralClaim(claim.id, 'approved', null, null, true);
    } catch (error) {
      console.error(`[REFERRAL_AUTO_APPROVAL] Claim ${claim.id} was not processed.`, error);
    }
  }
  return dueClaims.length;
};

module.exports = {
  AUTO_APPROVAL_MINUTES,
  REFERRAL_LINK_DAYS,
  defaultConfig,
  ensureReferralCode,
  findReferralUser,
  verifyReferralToken,
  getReferralConfig,
  saveReferralConfig,
  createReferralClaim,
  getReferralSummary,
  reconcileReferralRewards,
  decideReferralClaim,
  approveDueReferralClaims,
};
