const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { authenticator } = require('otplib');
const qrcode = require('qrcode');
const router = express.Router();
const {
  createUser,
  getUserByEmail,
  getUserById,
  verifyPassword,
  updateUser,
  updateUserPassword,
  saveResetOtp,
  clearResetOtp,
  getLast5PasswordHashes,
  insertPasswordHistory,
} = require('../models/userModel');
const { validatePassword } = require('../utils/passwordPolicy');
const { isPwned } = require('../utils/hibp');
const { issueToken } = require('../utils/sessionStore');
const { isTrustedDevice, sendDeviceChallenge, issueTrustedDevice } = require('../utils/trustedDevice');
const { authenticateUser, authenticateAdmin } = require('../middleware/authMiddleware');
const pool = require('../config/db');
const {
  listLoyaltyTiers,
  getLoyaltyConfig,
  saveLoyaltyConfig,
  createLoyaltyTier,
  updateLoyaltyTier,
  deleteLoyaltyTier,
} = require('../models/loyaltyTierModel');
const { computeLoyaltyTier } = require('../utils/loyaltyTier');

const validateLoyaltyTier = tier => {
  const name = typeof tier?.name === 'string' ? tier.name.trim() : '';
  const minPoints = Number(tier?.min_points);
  const multiplier = Number(tier?.points_multiplier);
  const discount = Number(tier?.tier_discount_percent);
  const cashback = Number(tier?.cashback_percent);
  const bonus = Number(tier?.bonus_points);
  const validBoolean = value => [true, false, 0, 1, '0', '1'].includes(value);
  return Boolean(name) && name.length <= 80 && Number.isSafeInteger(minPoints) && minPoints >= 0 &&
    Number.isFinite(multiplier) && multiplier >= 0.1 && multiplier <= 10 &&
    Number.isFinite(discount) && discount >= 0 && discount <= 25 &&
    Number.isFinite(cashback) && cashback >= 0 && cashback <= 25 &&
    Number.isSafeInteger(bonus) && bonus >= 0 && bonus <= 1000000 &&
    validBoolean(tier?.free_shipping) && validBoolean(tier?.is_active);
};

router.get('/loyalty/matrix', authenticateAdmin, async (_req, res) => {
  try {
    const [config, tiers] = await Promise.all([getLoyaltyConfig(), listLoyaltyTiers()]);
    res.json({ data: { config, tiers } });
  } catch (err) {
    console.error('[LOYALTY_MATRIX_LOAD]', err);
    res.status(500).json({ code: 'LOYALTY_MATRIX_LOAD_FAILED', message: 'Failed to load the loyalty matrix.' });
  }
});

router.put('/loyalty/matrix/config', authenticateAdmin, async (req, res) => {
  const config = req.body || {};
  const pointsPerRupee = Number(config.points_per_rupee);
  const redemptionRate = Number(config.redemption_points_per_rupee);
  const maxRedemption = Number(config.max_redemption_percent);
  const minimumPoints = Number(config.minimum_redemption_points);
  if (typeof config.enabled !== 'boolean' || !Number.isFinite(pointsPerRupee) || pointsPerRupee < 0 || pointsPerRupee > 100 ||
      !Number.isSafeInteger(redemptionRate) || redemptionRate < 1 || redemptionRate > 100000 ||
      !Number.isFinite(maxRedemption) || maxRedemption < 0 || maxRedemption > 100 ||
      !Number.isSafeInteger(minimumPoints) || minimumPoints < 0 || minimumPoints > 1000000) {
    return res.status(400).json({ code: 'INVALID_LOYALTY_CONFIG', message: 'Check the earning rate, redemption conversion, order cap, and minimum points.' });
  }
  try {
    res.json({ data: await saveLoyaltyConfig({ enabled: config.enabled, points_per_rupee: pointsPerRupee, redemption_points_per_rupee: redemptionRate, max_redemption_percent: maxRedemption, minimum_redemption_points: minimumPoints }) });
  } catch (err) {
    console.error('[LOYALTY_MATRIX_CONFIG_SAVE]', err);
    res.status(500).json({ code: 'LOYALTY_MATRIX_CONFIG_SAVE_FAILED', message: 'Failed to save loyalty settings.' });
  }
});

router.get('/loyalty/matrix/members', authenticateAdmin, async (_req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, name, email, loyalty_points, loyalty_lifetime_points
       FROM users WHERE role = 'customer' AND is_active = 1
       ORDER BY loyalty_lifetime_points DESC, id DESC LIMIT 500`
    );
    res.json({ data: rows });
  } catch (err) {
    console.error('[LOYALTY_MATRIX_MEMBERS]', err);
    res.status(500).json({ code: 'LOYALTY_MEMBERS_LOAD_FAILED', message: 'Failed to load loyalty members.' });
  }
});

router.get('/loyalty/matrix/transactions', authenticateAdmin, async (req, res) => {
  const limit = Math.max(1, Math.min(100, Number.parseInt(req.query.limit, 10) || 50));
  const userId = req.query.user_id ? Number(req.query.user_id) : null;
  if (req.query.user_id && (!Number.isSafeInteger(userId) || userId < 1)) {
    return res.status(400).json({ code: 'INVALID_LOYALTY_MEMBER', message: 'Member ID must be a positive whole number.' });
  }
  try {
    const [rows] = await pool.query(
      `SELECT t.id, t.user_id, u.name, u.email, t.points_delta, t.balance_after,
        t.type, t.description, t.reference_id, t.order_id, t.created_by_admin_id, t.created_at
       FROM loyalty_point_transactions t
       JOIN users u ON u.id = t.user_id
       WHERE (? IS NULL OR t.user_id = ?)
       ORDER BY t.created_at DESC, t.id DESC LIMIT ?`,
      [userId, userId, limit]
    );
    res.json({ data: rows });
  } catch (err) {
    console.error('[LOYALTY_MATRIX_TRANSACTIONS]', err);
    res.status(500).json({ code: 'LOYALTY_TRANSACTIONS_LOAD_FAILED', message: 'Failed to load loyalty transactions.' });
  }
});

router.patch('/loyalty/matrix/members/:id', authenticateAdmin, async (req, res) => {
  const userId = Number(req.params.id);
  const pointsDelta = Number(req.body?.points_delta);
  const lifetimeDelta = req.body?.lifetime_points_delta === undefined
    ? Math.max(0, pointsDelta)
    : Number(req.body.lifetime_points_delta);
  const description = typeof req.body?.description === 'string' ? req.body.description.trim().slice(0, 240) : '';
    if (!Number.isSafeInteger(userId) || userId < 1 || !Number.isSafeInteger(pointsDelta) ||
      Math.abs(pointsDelta) > 1000000 || !Number.isSafeInteger(lifetimeDelta) || Math.abs(lifetimeDelta) > 1000000 ||
      (pointsDelta === 0 && lifetimeDelta === 0) ||
      description.length < 5) {
    return res.status(400).json({ code: 'INVALID_LOYALTY_ADJUSTMENT', message: 'Enter a valid member, non-zero point adjustment, lifetime adjustment, and reason.' });
  }
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [[user]] = await connection.query(
      "SELECT id, loyalty_points, loyalty_lifetime_points FROM users WHERE id = ? AND role = 'customer' AND is_active = 1 FOR UPDATE",
      [userId]
    );
    if (!user) {
      await connection.rollback();
      return res.status(404).json({ code: 'LOYALTY_MEMBER_NOT_FOUND', message: 'Active customer not found.' });
    }
    const balanceAfter = Number(user.loyalty_points) + pointsDelta;
    const lifetimeAfter = Math.max(0, Number(user.loyalty_lifetime_points) + lifetimeDelta);
    if (balanceAfter < 0) {
      await connection.rollback();
      return res.status(409).json({ code: 'INSUFFICIENT_LOYALTY_POINTS', message: 'This adjustment would make the available points balance negative.' });
    }
    await connection.query(
      'UPDATE users SET loyalty_points = ?, loyalty_lifetime_points = ? WHERE id = ?',
      [balanceAfter, lifetimeAfter, userId]
    );
    await connection.query(
      `INSERT INTO loyalty_point_transactions
        (user_id, points_delta, balance_after, type, description, reference_id, created_by_admin_id)
       VALUES (?, ?, ?, 'adjustment', ?, ?, ?)`,
      [userId, pointsDelta, balanceAfter, description, `loyalty-admin-${crypto.randomUUID()}`, req.user.id]
    );
    await connection.commit();
    return res.json({ success: true, data: { userId, pointsBalance: balanceAfter, lifetimePoints: lifetimeAfter } });
  } catch (err) {
    await connection.rollback();
    console.error('[LOYALTY_MATRIX_ADJUSTMENT]', err);
    return res.status(500).json({ code: 'LOYALTY_ADJUSTMENT_FAILED', message: 'Could not adjust loyalty points.' });
  } finally {
    connection.release();
  }
});

authenticator.options = { window: 1 };

router.post('/register', async (req, res) => {
  try {
    const { name, email, password, phone, marketingEmailOptIn = false } = req.body;
    if (!name || !email || !password) return res.status(400).json({ message: 'Name, email and password are required' });
    if (typeof marketingEmailOptIn !== 'boolean') {
      return res.status(400).json({ message: 'Email marketing preference must be true or false.' });
    }
    
    const existing = await getUserByEmail(email);
    if (existing) return res.status(409).json({ message: 'Email already registered' });
    
    const id = await createUser({ name, email, password, phone, marketingEmailOptIn });
    const deviceHash = await issueTrustedDevice(id, req, res);
    const token = await issueToken({ id, email, role: 'customer' }, req, { sessionType: 'user', deviceHash });
    return res.status(201).json({ token, user: { id, name, email, phone, role: 'customer' } });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Registration failed' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await getUserByEmail(email);
    if (!user) return res.status(401).json({ message: 'Invalid email or password' });
    if (!user.is_active) return res.status(403).json({ message: 'Account is disabled' });
    
    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) return res.status(401).json({ message: 'Invalid email or password' });
    if (user.two_factor_enabled) {
      return res.status(202).json({ requires2FA: true, factor: 'authenticator', email: user.email });
    }
    let deviceHash;
    try {
      deviceHash = await isTrustedDevice(user.id, req);
      if (!deviceHash) {
        await sendDeviceChallenge(user, req);
        return res.status(202).json({
          requires2FA: true,
          factor: 'email',
          message: 'We sent a verification code to your email because this browser is not trusted yet.',
          email: user.email
        });
      }
    } catch (challengeError) {
      console.error('[NEW_DEVICE_CHALLENGE_ERROR]:', challengeError);
      return res.status(503).json({ message: 'Could not verify this browser. Please try again later.' });
    }
    
    const token = await issueToken(
      { id: user.id, email: user.email, role: user.role },
      req,
      { sessionType: 'user', deviceHash }
    );
    return res.json({ token, user: { id: user.id, name: user.name, email: user.email, phone: user.phone, role: user.role } });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Login failed' });
  }
});

router.get('/profile', authenticateUser, async (req, res) => {
  try {
    let user = await getUserById(req.user.id);
    if (!user) {
      const [rows] = await pool.query('SELECT id, name, email, phone, role, is_active, loyalty_points, loyalty_lifetime_points, marketing_email_opt_in, whatsapp_order_updates_opt_in FROM users WHERE id = ?', [req.user.id]);
      if (rows && rows.length > 0) {
        user = rows[0];
      }
    }
    if (!user) return res.status(404).json({ message: 'User not found' });
    const tiers = await listLoyaltyTiers({ activeOnly: true });
    const loyalty = computeLoyaltyTier(user.loyalty_lifetime_points ?? user.loyalty_points, tiers);
    user.loyalty = loyalty;
    user.loyaltyProgress = loyalty;
    return res.json(user);
  } catch (err) {
    return res.status(500).json({ message: 'Failed to fetch user' });
  }
});

router.patch('/profile/whatsapp-preference', authenticateUser, async (req, res) => {
  const preference = req.body?.whatsapp_order_updates_opt_in;
  if (typeof preference !== 'boolean') {
    return res.status(400).json({
      code: 'INVALID_WHATSAPP_PREFERENCE',
      message: 'WhatsApp order update preference must be true or false.',
    });
  }
  if (req.user.role !== 'customer') {
    return res.status(403).json({
      code: 'CUSTOMER_PREFERENCE_ONLY',
      message: 'Only customer accounts can update WhatsApp order preferences.',
    });
  }
  try {
    const [result] = await pool.query(
      `UPDATE users
       SET whatsapp_order_updates_opt_in = ?,
           whatsapp_order_updates_consent_at = CASE
             WHEN ? = 1 THEN CURRENT_TIMESTAMP
             ELSE whatsapp_order_updates_consent_at
           END
       WHERE id = ? AND role = 'customer'`,
      [preference ? 1 : 0, preference ? 1 : 0, req.user.id]
    );
    if (result.affectedRows !== 1) {
      return res.status(404).json({ code: 'USER_NOT_FOUND', message: 'Customer account not found.' });
    }
    return res.json({ whatsapp_order_updates_opt_in: preference });
  } catch (error) {
    console.error('[WHATSAPP_PREFERENCE_UPDATE]', error);
    return res.status(500).json({
      code: 'WHATSAPP_PREFERENCE_UPDATE_FAILED',
      message: 'Could not update your WhatsApp order update preference.',
    });
  }
});

router.get('/loyalty/tiers', authenticateAdmin, async (req, res) => {
  try {
    res.json({ data: await listLoyaltyTiers() });
  } catch (err) {
    console.error('[LOYALTY_TIERS_LIST]', err);
    res.status(500).json({ code: 'LOYALTY_TIERS_LOAD_FAILED', message: 'Failed to load loyalty tiers.' });
  }
});

router.post('/loyalty/tiers', authenticateAdmin, async (req, res) => {
  try {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!validateLoyaltyTier({ ...req.body, name })) {
      return res.status(400).json({ code: 'INVALID_LOYALTY_TIER', message: 'Enter a tier name, unique non-negative threshold, multiplier from 0.1–10, discount/cashback from 0–25%, and whole bonus points.' });
    }
    const [thresholdMatches] = await pool.query('SELECT id FROM loyalty_tiers WHERE min_points = ?', [Number(req.body.min_points)]);
    if (thresholdMatches.length) return res.status(409).json({ code: 'LOYALTY_THRESHOLD_EXISTS', message: 'Each loyalty tier must have a unique lifetime-points threshold.' });
    res.status(201).json({ data: await createLoyaltyTier({ ...req.body, name }) });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ code: 'LOYALTY_TIER_EXISTS', message: 'A tier with that name already exists.' });
    console.error('[LOYALTY_TIER_CREATE]', err);
    res.status(500).json({ code: 'LOYALTY_TIER_CREATE_FAILED', message: 'Failed to create loyalty tier.' });
  }
});

router.put('/loyalty/tiers/:id', authenticateAdmin, async (req, res) => {
  try {
    const [existing] = await pool.query('SELECT * FROM loyalty_tiers WHERE id = ?', [req.params.id]);
    if (!existing.length) return res.status(404).json({ code: 'LOYALTY_TIER_NOT_FOUND', message: 'Loyalty tier not found.' });
    const merged = { ...existing[0], ...(req.body || {}) };
    if (!validateLoyaltyTier(merged)) {
      return res.status(400).json({ code: 'INVALID_LOYALTY_TIER', message: 'Enter a tier name, unique non-negative threshold, multiplier from 0.1–10, discount/cashback from 0–25%, and whole bonus points.' });
    }
    const [thresholdMatches] = await pool.query('SELECT id FROM loyalty_tiers WHERE min_points = ? AND id <> ?', [Number(merged.min_points), req.params.id]);
    if (thresholdMatches.length) return res.status(409).json({ code: 'LOYALTY_THRESHOLD_EXISTS', message: 'Each loyalty tier must have a unique lifetime-points threshold.' });
    const staysActiveBase = Number(merged.min_points) === 0 && (merged.is_active === true || Number(merged.is_active) === 1);
    if (!staysActiveBase) {
      const [otherBaseTiers] = await pool.query('SELECT id FROM loyalty_tiers WHERE min_points = 0 AND is_active = 1 AND id <> ?', [req.params.id]);
      if (!otherBaseTiers.length) return res.status(409).json({ code: 'LOYALTY_BASE_TIER_REQUIRED', message: 'Keep at least one active tier at zero lifetime points.' });
    }
    const tier = await updateLoyaltyTier(req.params.id, req.body || {});
    if (!tier) return res.status(404).json({ code: 'LOYALTY_TIER_NOT_FOUND', message: 'Loyalty tier not found.' });
    res.json({ data: tier });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ code: 'LOYALTY_TIER_EXISTS', message: 'A loyalty tier with that name already exists.' });
    console.error('[LOYALTY_TIER_UPDATE]', err);
    res.status(500).json({ code: 'LOYALTY_TIER_UPDATE_FAILED', message: 'Failed to update loyalty tier.' });
  }
});

router.delete('/loyalty/tiers/:id', authenticateAdmin, async (req, res) => {
  try {
    const [activeTiers] = await pool.query('SELECT id FROM loyalty_tiers WHERE is_active = 1');
    const [selectedTier] = await pool.query('SELECT id, is_active, min_points FROM loyalty_tiers WHERE id = ?', [req.params.id]);
    if (selectedTier[0]?.is_active && activeTiers.length <= 1) {
      return res.status(409).json({ code: 'LAST_ACTIVE_LOYALTY_TIER', message: 'Keep at least one active loyalty tier.' });
    }
    if (Number(selectedTier[0]?.min_points) === 0 && selectedTier[0]?.is_active) {
      const [otherBaseTiers] = await pool.query('SELECT id FROM loyalty_tiers WHERE min_points = 0 AND is_active = 1 AND id <> ?', [req.params.id]);
      if (!otherBaseTiers.length) return res.status(409).json({ code: 'LOYALTY_BASE_TIER_REQUIRED', message: 'Keep at least one active tier at zero lifetime points.' });
    }
    if (!await deleteLoyaltyTier(req.params.id)) return res.status(404).json({ code: 'LOYALTY_TIER_NOT_FOUND', message: 'Loyalty tier not found.' });
    res.json({ success: true });
  } catch (err) {
    console.error('[LOYALTY_TIER_DELETE]', err);
    res.status(500).json({ code: 'LOYALTY_TIER_DELETE_FAILED', message: 'Failed to delete loyalty tier.' });
  }
});

router.put('/profile', authenticateUser, async (req, res) => {
  try {
    const { name, phone, marketing_email_opt_in: marketingEmailOptIn } = req.body;
    if (!name) return res.status(400).json({ message: 'Name is required' });
    const hasMarketingPreference = Object.prototype.hasOwnProperty.call(req.body || {}, 'marketing_email_opt_in');
    if (hasMarketingPreference && typeof marketingEmailOptIn !== 'boolean') {
      return res.status(400).json({ message: 'Email marketing preference must be true or false.' });
    }
    if (hasMarketingPreference && req.user.role !== 'customer') {
      return res.status(403).json({ message: 'Only customer accounts can update marketing preferences.' });
    }
    await updateUser(req.user.id, {
      name,
      phone,
      ...(hasMarketingPreference ? { marketingEmailOptIn } : {})
    });
    let user = await getUserById(req.user.id);
    if (!user) {
      const [rows] = await pool.query('SELECT id, name, email, phone, role, is_active, loyalty_points, loyalty_lifetime_points, marketing_email_opt_in, whatsapp_order_updates_opt_in FROM users WHERE id = ?', [req.user.id]);
      if (rows && rows.length > 0) user = rows[0];
    }
    const tiers = await listLoyaltyTiers({ activeOnly: true });
    const loyalty = computeLoyaltyTier(user?.loyalty_lifetime_points ?? user?.loyalty_points ?? 0, tiers);
    if (user) {
      user.loyalty = loyalty;
      user.loyaltyProgress = loyalty;
    }
    return res.json(user);
  } catch (err) {
    return res.status(500).json({ message: 'Update failed' });
  }
});

router.post('/change-password', authenticateUser, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ code: 'MISSING_FIELDS', message: 'Both currentPassword and newPassword are required.' });
    }

    const user = await getUserByEmail(req.user.email);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const currentValid = await verifyPassword(currentPassword, user.password_hash);
    if (!currentValid) return res.status(401).json({ message: 'Current password is incorrect' });

    const policyResult = await validatePassword(newPassword);
    if (!policyResult.valid && policyResult.errors && policyResult.errors.length > 0) {
      const fatalCodes = new Set(['MIN_LENGTH','MAX_LENGTH','COMPLEXITY','COMMON_PASSWORD']);
      const firstFatal = policyResult.errors.find(e => fatalCodes.has(e.code));
      if (firstFatal) {
        return res.status(400).json({ code: firstFatal.code, message: firstFatal.message });
      }
    }

    try {
      const hibpResult = await isPwned(newPassword);
      if (hibpResult && hibpResult.pwned && !hibpResult.skipped) {
        return res.status(400).json({
          code: 'PWNED_PASSWORD',
          message: `This password has appeared in ${hibpResult.count} public data breach(es). Choose a different one.`
        });
      }
    } catch (hibpErr) {
      console.warn('[CHANGE-PWD] HIBP check skipped due to error:', hibpErr.message);
    }

    const last5 = await getLast5PasswordHashes(user.id, 'customer');
    if (last5 && last5.length > 0) {
      for (const row of last5) {
        const reused = await bcrypt.compare(newPassword, row.password_hash);
        if (reused) {
          return res.status(400).json({
            code: 'PASSWORD_REUSED',
            message: 'Cannot reuse any of your last 5 passwords.'
          });
        }
      }
    }

    const SALT_ROUNDS = 12;
    const hash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    await pool.query(
      'UPDATE users SET password_hash = ?, last_password_change = NOW() WHERE id = ?',
      [hash, user.id]
    );
    await insertPasswordHistory(user.id, 'customer', hash);

    return res.json({ message: 'Password updated successfully' });
  } catch (err) {
    console.error('[CHANGE-PWD] Server error:', err.message);
    return res.status(500).json({ message: 'Server error' });
  }
});

router.post('/2fa/generate', authenticateUser, async (req, res) => {
  try {
    const secret = authenticator.generateSecret();
    const otpauth = authenticator.keyuri(req.user.email, 'Bhumivera Store', secret);
    const qrCodeUrl = await qrcode.toDataURL(otpauth);
    res.json({ secret, qrCode: qrCodeUrl });
  } catch (err) { res.status(500).json({ message: "Server error" }); }
});

// Alias for frontend users.generate2FA() — identical to above
router.post('/2fa/generate-setup', authenticateUser, async (req, res) => {
  try {
    const secret = authenticator.generateSecret();
    const otpauth = authenticator.keyuri(req.user.email, 'Bhumivera Store', secret);
    const qrCodeUrl = await qrcode.toDataURL(otpauth);
    res.json({ secret, qrCode: qrCodeUrl, qrCodeUrl });
  } catch (err) { res.status(500).json({ message: "Server error" }); }
});

router.post('/2fa/enable', authenticateUser, async (req, res) => {
  try {
    const { token, secret } = req.body;
    const isValid = authenticator.verify({ token, secret });
    if (!isValid) return res.status(400).json({ message: "Invalid Authenticator Code." });

    await pool.query('UPDATE users SET two_factor_secret=?, two_factor_enabled=1 WHERE id=?', [secret, req.user.id]);
    res.json({ message: "2FA Enabled Successfully." });
  } catch (err) { res.status(500).json({ message: "Server error" }); }
});

router.post('/2fa/disable', authenticateUser, async (req, res) => {
  try {
    await pool.query('UPDATE users SET two_factor_secret=NULL, two_factor_enabled=0 WHERE id=?', [req.user.id]);
    res.json({ message: "2FA Disabled." });
  } catch (err) { res.status(500).json({ message: "Server error" }); }
});

router.put('/security-question', authenticateUser, async (req, res) => {
  try {
    const { question, answer } = req.body;
    if (!answer) return res.status(400).json({ message: "Security answer is required." });
    const answerHash = await bcrypt.hash(String(answer).toLowerCase(), 10);
    await pool.query('UPDATE users SET security_question=?, security_answer_hash=? WHERE id=?', [question || "What is your mother's maiden name?", answerHash, req.user.id]);
    res.json({ message: "Security question updated." });
  } catch (err) { res.status(500).json({ message: "Server error" }); }
});

module.exports = { router, userAuth: authenticateUser };
