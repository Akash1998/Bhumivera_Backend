const express = require('express');
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
const { listLoyaltyTiers, createLoyaltyTier, updateLoyaltyTier, deleteLoyaltyTier } = require('../models/loyaltyTierModel');
const { computeLoyaltyTier } = require('../utils/loyaltyTier');

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
      const [rows] = await pool.query('SELECT id, name, email, phone, role, is_active, loyalty_points, marketing_email_opt_in FROM users WHERE id = ?', [req.user.id]);
      if (rows && rows.length > 0) {
        user = rows[0];
      }
    }
    if (!user) return res.status(404).json({ message: 'User not found' });
    const tiers = await listLoyaltyTiers({ activeOnly: true });
    const loyalty = computeLoyaltyTier(user.loyalty_points, tiers);
    user.loyalty = loyalty;
    user.loyaltyProgress = loyalty;
    return res.json(user);
  } catch (err) {
    return res.status(500).json({ message: 'Failed to fetch user' });
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
    if (!name || !Number.isFinite(Number(req.body?.min_points)) || Number(req.body.min_points) < 0) {
      return res.status(400).json({ code: 'INVALID_LOYALTY_TIER', message: 'Tier name and a non-negative points threshold are required.' });
    }
    res.status(201).json({ data: await createLoyaltyTier({ ...req.body, name }) });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ code: 'LOYALTY_TIER_EXISTS', message: 'A tier with that name already exists.' });
    console.error('[LOYALTY_TIER_CREATE]', err);
    res.status(500).json({ code: 'LOYALTY_TIER_CREATE_FAILED', message: 'Failed to create loyalty tier.' });
  }
});

router.put('/loyalty/tiers/:id', authenticateAdmin, async (req, res) => {
  try {
    const tier = await updateLoyaltyTier(req.params.id, req.body || {});
    if (!tier) return res.status(404).json({ code: 'LOYALTY_TIER_NOT_FOUND', message: 'Loyalty tier not found.' });
    res.json({ data: tier });
  } catch (err) {
    console.error('[LOYALTY_TIER_UPDATE]', err);
    res.status(500).json({ code: 'LOYALTY_TIER_UPDATE_FAILED', message: 'Failed to update loyalty tier.' });
  }
});

router.delete('/loyalty/tiers/:id', authenticateAdmin, async (req, res) => {
  try {
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
      const [rows] = await pool.query('SELECT id, name, email, phone, role, is_active, loyalty_points, marketing_email_opt_in FROM users WHERE id = ?', [req.user.id]);
      if (rows && rows.length > 0) user = rows[0];
    }
    const tiers = await listLoyaltyTiers({ activeOnly: true });
    const loyalty = computeLoyaltyTier(user?.loyalty_points ?? 0, tiers);
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
