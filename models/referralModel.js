const crypto = require('crypto');
const pool = require('../config/db');
const { sendMail } = require('../utils/mail');

const REFERRAL_LINK_DAYS = 90;
const AUTO_APPROVAL_MINUTES = 60;
const defaultConfig = {
  enabled: 1,
  reward_mode: 'wallet_coupon',
  wallet_reward_amount: 500,
  referred_reward_amount: 500,
  wallet_reward_per_order_limit: 100,
  coupon_discount_type: 'fixed',
  coupon_discount_value: 100,
  coupon_min_order_amount: 0,
  coupon_valid_days: 30,
  referral_redemption_tiers: [
    { min_order_amount: 700, referral_amount: 100 },
    { min_order_amount: 1100, referral_amount: 200 },
  ],
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

const previewReferral = async ({ code, token }) => {
  const userId = token ? await verifyReferralToken(token) : await findReferralUser(code);
  if (!userId) return null;
  const [rows] = await pool.query(
    "SELECT name FROM users WHERE id = ? AND role = 'customer' AND is_active = 1",
    [userId]
  );
  return rows[0]?.name ? { referrerName: rows[0].name } : null;
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
  const config = { ...defaultConfig, ...(rows[0] || {}) };
  try {
    config.referral_redemption_tiers = typeof config.referral_redemption_tiers === 'string'
      ? JSON.parse(config.referral_redemption_tiers)
      : config.referral_redemption_tiers;
  } catch {
    config.referral_redemption_tiers = defaultConfig.referral_redemption_tiers;
  }
  if (!Array.isArray(config.referral_redemption_tiers)) {
    config.referral_redemption_tiers = defaultConfig.referral_redemption_tiers;
  }
  return config;
};

const saveReferralConfig = async config => {
  const settings = {
    enabled: config.enabled ? 1 : 0,
    reward_mode: config.reward_mode,
    wallet_reward_amount: Number(config.wallet_reward_amount),
    referred_reward_amount: Number(config.referred_reward_amount ?? defaultConfig.referred_reward_amount),
    wallet_reward_per_order_limit: Number(config.wallet_reward_per_order_limit ?? defaultConfig.wallet_reward_per_order_limit),
    coupon_discount_type: config.coupon_discount_type,
    coupon_discount_value: Number(config.coupon_discount_value),
    coupon_min_order_amount: Number(config.coupon_min_order_amount),
    coupon_valid_days: Number(config.coupon_valid_days),
    referral_redemption_tiers: JSON.stringify(config.referral_redemption_tiers || defaultConfig.referral_redemption_tiers),
  };
  await pool.query(
    `INSERT INTO referral_settings
      (id, enabled, reward_mode, wallet_reward_amount, referred_reward_amount, wallet_reward_per_order_limit, coupon_discount_type, coupon_discount_value, coupon_min_order_amount, coupon_valid_days, referral_redemption_tiers)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), reward_mode = VALUES(reward_mode),
       wallet_reward_amount = VALUES(wallet_reward_amount),
       referred_reward_amount = VALUES(referred_reward_amount),
       wallet_reward_per_order_limit = VALUES(wallet_reward_per_order_limit),
       coupon_discount_type = VALUES(coupon_discount_type),
       coupon_discount_value = VALUES(coupon_discount_value), coupon_min_order_amount = VALUES(coupon_min_order_amount),
       coupon_valid_days = VALUES(coupon_valid_days), referral_redemption_tiers = VALUES(referral_redemption_tiers)`,
    Object.values(settings)
  );
  return { ...settings, referral_redemption_tiers: JSON.parse(settings.referral_redemption_tiers) };
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
    referrerRewardAmount: Number(config.wallet_reward_amount) || 0,
    referredRewardAmount: Number(config.referred_reward_amount) || 0,
  };
};

const createRewardForClaim = async (connection, claim, config) => {
  const shouldCreditWallet = ['wallet', 'wallet_coupon'].includes(config.reward_mode);
  const shouldIssueCoupon = config.reward_mode === 'coupon';
  const restrictedReferralCredit = config.reward_mode === 'wallet_coupon';
  const walletAmount = shouldCreditWallet ? Number(config.wallet_reward_amount) : 0;
  const referredWalletAmount = restrictedReferralCredit ? Number(config.referred_reward_amount) : 0;
  const perOrderLimit = Number(config.wallet_reward_per_order_limit);
  let couponCode = null;

  if (shouldIssueCoupon) {
    couponCode = `REF${claim.referrer_user_id}${crypto.randomBytes(5).toString('hex').toUpperCase()}`.slice(0, 50);
    if (restrictedReferralCredit && walletAmount > 0) {
      if (!Number.isFinite(perOrderLimit) || perOrderLimit <= 0) {
        throw Object.assign(new Error('Set a referral wallet limit greater than zero before approving wallet-and-coupon rewards.'), { status: 409 });
      }
      await connection.query(
        `INSERT INTO coupons
          (code, description, discount_type, discount_value, min_order_amount, usage_limit, restricted_user_id, is_active, valid_from, expires_at, reward_type, wallet_per_order_limit)
         VALUES (?, 'Referral wallet reward', 'fixed', ?, ?, ?, ?, 1, NOW(), DATE_ADD(NOW(), INTERVAL ? DAY), 'referral_wallet', ?)`,
        [
          couponCode,
          perOrderLimit,
          config.coupon_min_order_amount,
          Math.ceil(walletAmount / perOrderLimit),
          claim.referrer_user_id,
          config.coupon_valid_days,
          perOrderLimit,
        ]
      );
    } else {
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
  }

  if (walletAmount > 0) {
    if (restrictedReferralCredit) {
      await connection.query('INSERT IGNORE INTO referral_wallets (user_id, balance) VALUES (?, 0.00)', [claim.referrer_user_id]);
      await connection.query('UPDATE referral_wallets SET balance = balance + ? WHERE user_id = ?', [walletAmount, claim.referrer_user_id]);
      await connection.query(
        `INSERT INTO referral_wallet_transactions (user_id, amount, type, description, reference_id, coupon_code)
         VALUES (?, ?, 'credit', 'Approved restricted referral reward', ?, ?)`,
        [claim.referrer_user_id, walletAmount, `referral-claim-${claim.id}`, couponCode]
      );
    } else {
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
      await connection.query('UPDATE users SET wallet_balance = ? WHERE id = ?', [balance + walletAmount, claim.referrer_user_id]);
      await connection.query(
        `INSERT INTO wallet_transactions (user_id, amount, type, description, reference_id)
         VALUES (?, ?, 'credit', 'Approved referral reward', ?)`,
        [claim.referrer_user_id, walletAmount, `referral-claim-${claim.id}`]
      );
    }
  }

  if (referredWalletAmount > 0) {
    await connection.query('INSERT IGNORE INTO referral_wallets (user_id, balance) VALUES (?, 0.00)', [claim.referred_user_id]);
    await connection.query('UPDATE referral_wallets SET balance = balance + ? WHERE user_id = ?', [referredWalletAmount, claim.referred_user_id]);
    await connection.query(
      `INSERT INTO referral_wallet_transactions (user_id, amount, type, description, reference_id)
       VALUES (?, ?, 'credit', 'Approved new-customer referral reward', ?)`,
      [claim.referred_user_id, referredWalletAmount, `referral-claim-${claim.id}-referred`]
    );
  }

  await connection.query(
    `INSERT INTO referral_rewards
      (referred_user_id, referrer_user_id, order_id, wallet_amount, referred_wallet_amount, coupon_code)
     VALUES (?, ?, NULL, ?, ?, ?)`,
    [claim.referred_user_id, claim.referrer_user_id, walletAmount, referredWalletAmount, couponCode]
  );
  return { walletAmount, referredWalletAmount, couponCode, walletBucket: restrictedReferralCredit ? 'referral' : 'cash' };
};

const reconcileReferralRewards = async userId => {
  const [claims] = await pool.query(
    `SELECT id FROM referral_claims
     WHERE status IN ('approved', 'auto_approved') AND (
       (referrer_user_id = ? AND (wallet_amount > 0 OR coupon_code IS NOT NULL)) OR
       (referred_user_id = ? AND referred_wallet_amount > 0)
     )`,
    [userId, userId]
  );

  for (const row of claims) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [lockedClaims] = await connection.query(
        `SELECT * FROM referral_claims
         WHERE id = ? AND (referrer_user_id = ? OR referred_user_id = ?)
           AND status IN ('approved', 'auto_approved')
         FOR UPDATE`,
        [row.id, userId, userId]
      );
      const claim = lockedClaims[0];
      if (!claim) {
        await connection.commit();
        continue;
      }

      const isReferrer = String(claim.referrer_user_id) === String(userId);
      const walletAmount = Number(isReferrer ? claim.wallet_amount : claim.referred_wallet_amount) || 0;
      const walletBucket = isReferrer ? claim.wallet_bucket : 'referral';
      if (walletAmount > 0) {
        const reference = isReferrer ? `referral-claim-${claim.id}` : `referral-claim-${claim.id}-referred`;
        if (walletBucket === 'referral') {
          await connection.query('INSERT IGNORE INTO referral_wallets (user_id, balance) VALUES (?, 0.00)', [userId]);
          const [transactions] = await connection.query(
            'SELECT id FROM referral_wallet_transactions WHERE user_id = ? AND reference_id = ? LIMIT 1',
            [userId, reference]
          );
          if (!transactions.length) {
            await connection.query('UPDATE referral_wallets SET balance = balance + ? WHERE user_id = ?', [walletAmount, userId]);
            await connection.query(
              `INSERT INTO referral_wallet_transactions (user_id, amount, type, description, reference_id, coupon_code)
               VALUES (?, ?, 'credit', 'Approved restricted referral reward', ?, ?)`,
              [userId, walletAmount, reference, isReferrer ? claim.coupon_code : null]
            );
          }
        } else {
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
      }

      if (isReferrer && claim.coupon_code) {
        const [coupons] = await connection.query(
          'SELECT id, restricted_user_id, usage_limit, reward_type, wallet_per_order_limit FROM coupons WHERE code = ? FOR UPDATE',
          [claim.coupon_code]
        );
        if (!coupons.length) {
          const config = await getReferralConfig(connection);
          if (claim.wallet_bucket === 'referral') {
            const limit = Number(config.wallet_reward_per_order_limit);
            await connection.query(
              `INSERT INTO coupons
                (code, description, discount_type, discount_value, min_order_amount, usage_limit, restricted_user_id, is_active, valid_from, expires_at, reward_type, wallet_per_order_limit)
               VALUES (?, 'Referral wallet reward', 'fixed', ?, ?, ?, ?, 1, NOW(), DATE_ADD(NOW(), INTERVAL ? DAY), 'referral_wallet', ?)`,
              [claim.coupon_code, limit, config.coupon_min_order_amount, Math.ceil(Number(claim.wallet_amount) / limit), userId, config.coupon_valid_days, limit]
            );
          } else {
            await connection.query(
              `INSERT INTO coupons
                (code, description, discount_type, discount_value, min_order_amount, usage_limit, restricted_user_id, is_active, valid_from, expires_at)
               VALUES (?, 'Referral reward', ?, ?, ?, 1, ?, 1, NOW(), DATE_ADD(NOW(), INTERVAL ? DAY))`,
              [claim.coupon_code, config.coupon_discount_type, config.coupon_discount_value, config.coupon_min_order_amount, userId, config.coupon_valid_days]
            );
          }
        } else if (claim.wallet_bucket === 'referral') {
          const config = await getReferralConfig(connection);
          const limit = Number(coupons[0].wallet_per_order_limit) || Number(config.wallet_reward_per_order_limit);
          const uses = Math.ceil(Number(claim.wallet_amount) / limit);
          if (String(coupons[0].restricted_user_id) !== String(userId) ||
              coupons[0].reward_type !== 'referral_wallet' ||
              Number(coupons[0].wallet_per_order_limit) !== limit ||
              Number(coupons[0].usage_limit) !== uses) {
            await connection.query(
              `UPDATE coupons SET restricted_user_id = ?, reward_type = 'referral_wallet',
                discount_type = 'fixed', discount_value = ?, wallet_per_order_limit = ?, usage_limit = ? WHERE id = ?`,
              [userId, limit, limit, uses, coupons[0].id]
            );
          }
        } else if (String(coupons[0].restricted_user_id) !== String(userId) || Number(coupons[0].usage_limit) !== 1) {
          await connection.query('UPDATE coupons SET restricted_user_id = ?, usage_limit = 1 WHERE id = ?', [userId, coupons[0].id]);
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

    let reward = { walletAmount: 0, referredWalletAmount: 0, couponCode: null, walletBucket: 'cash' };
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
           wallet_amount = ?, referred_wallet_amount = ?, coupon_code = ?, wallet_bucket = ?
       WHERE id = ? AND status = 'pending'`,
        [status, automatic ? null : adminId, decision === 'rejected' ? reason : null, reward.walletAmount, reward.referredWalletAmount, reward.couponCode, reward.walletBucket, claim.id]
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

const reissueReferralCoupon = async claimId => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [claims] = await connection.query(
      `SELECT * FROM referral_claims
       WHERE id = ? AND status IN ('approved', 'auto_approved') AND wallet_bucket = 'referral'
       FOR UPDATE`,
      [claimId]
    );
    const claim = claims[0];
    if (!claim || !claim.coupon_code) {
      throw Object.assign(new Error('This referral does not have a reissuable reward coupon.'), { status: 404 });
    }
    const [[wallet]] = await connection.query(
      'SELECT balance FROM referral_wallets WHERE user_id = ? FOR UPDATE',
      [claim.referrer_user_id]
    );
    const balance = Math.max(0, Number(wallet?.balance) || 0);
    if (balance <= 0) {
      throw Object.assign(new Error('No referral reward balance remains to use with a replacement coupon.'), { status: 409 });
    }
    const [oldCoupons] = await connection.query('SELECT * FROM coupons WHERE code = ? FOR UPDATE', [claim.coupon_code]);
    const oldCoupon = oldCoupons[0];
    const config = await getReferralConfig(connection);
    const perOrderLimit = Number(oldCoupon?.wallet_per_order_limit) || Number(config.wallet_reward_per_order_limit);
    if (!Number.isFinite(perOrderLimit) || perOrderLimit <= 0) {
      throw Object.assign(new Error('The referral per-order limit is not configured.'), { status: 409 });
    }

    const couponCode = `REF${claim.referrer_user_id}${crypto.randomBytes(6).toString('hex').toUpperCase()}`.slice(0, 50);
    if (oldCoupon) {
      await connection.query('UPDATE coupons SET is_active = 0 WHERE id = ?', [oldCoupon.id]);
    }
    await connection.query(
      `INSERT INTO coupons
        (code, description, discount_type, discount_value, min_order_amount, usage_limit, restricted_user_id, is_active, valid_from, expires_at, reward_type, wallet_per_order_limit)
       VALUES (?, 'Reissued referral wallet reward', 'fixed', ?, ?, ?, ?, 1, NOW(), DATE_ADD(NOW(), INTERVAL ? DAY), 'referral_wallet', ?)`,
      [
        couponCode,
        perOrderLimit,
        Number(oldCoupon?.min_order_amount) || Number(config.coupon_min_order_amount) || 0,
        Math.ceil(balance / perOrderLimit),
        claim.referrer_user_id,
        Number(config.coupon_valid_days),
        perOrderLimit,
      ]
    );
    await connection.query('UPDATE referral_claims SET coupon_code = ? WHERE id = ?', [couponCode, claim.id]);
    await connection.query('UPDATE referral_rewards SET coupon_code = ? WHERE referred_user_id = ?', [couponCode, claim.referred_user_id]);
    await connection.commit();
    return { couponCode, remainingBalance: balance };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
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
    notification.walletAmount > 0
      ? notification.walletBucket === 'referral'
        ? `₹${Number(notification.walletAmount).toFixed(2)} was added to your order-only referral balance and will be applied automatically when an order reaches an eligible threshold.`
        : `₹${Number(notification.walletAmount).toFixed(2)} was added to your wallet.`
      : '',
    notification.couponCode ? `Your personal coupon code is ${notification.couponCode}.` : '',
  ].filter(Boolean).join(' ');
  const referredRewardMessage = notification.referredWalletAmount > 0
    ? `₹${Number(notification.referredWalletAmount).toFixed(2)} was added to your order-only referral balance and will apply automatically when your order reaches an eligible threshold.`
    : '';
  const safe = value => String(value || '').replace(/[&<>"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  })[character]);
  const recipients = users.filter(user => user.email);
  const messages = recipients.map(user => sendMail({
    to: user.email,
    subject: notification.status === 'rejected' ? 'Bhumivera referral update' : 'Your Bhumivera referral reward is ready',
    html: `<p>Hi ${safe(user.name || 'there')},</p><p>${safe(statusMessage)}</p><p>${safe(String(user.id) === String(notification.referredUserId) ? referredRewardMessage : rewardMessage)}</p><p>Open your Bhumivera account to see your referral status and any rewards.</p>`,
    text: `Hi ${user.name || 'there'}, ${statusMessage} ${String(user.id) === String(notification.referredUserId) ? referredRewardMessage : rewardMessage} Open your Bhumivera account to see your referral status and rewards.`,
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
  previewReferral,
  verifyReferralToken,
  getReferralConfig,
  saveReferralConfig,
  createReferralClaim,
  getReferralSummary,
  reconcileReferralRewards,
  decideReferralClaim,
  reissueReferralCoupon,
  approveDueReferralClaims,
};
