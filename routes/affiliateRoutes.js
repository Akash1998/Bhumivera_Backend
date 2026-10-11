const express = require('express');
const pool = require('../config/db');
const { authenticateAdmin, authenticateUser } = require('../middleware/authMiddleware');
const {
  defaultConfig,
  getReferralConfig,
  getReferralSummary,
  saveReferralConfig,
  decideReferralClaim,
  approveDueReferralClaims,
} = require('../models/referralModel');

const router = express.Router();

router.get('/referral/link', authenticateUser, async (req, res) => {
  try {
    const data = await getReferralSummary(req.user.id);
    return res.json({ success: true, data });
  } catch (error) {
    console.error('[REFERRAL_LINK]', error);
    return res.status(500).json({ message: 'Could not create your referral link.' });
  }
});

router.get('/referral/summary', authenticateUser, async (req, res) => {
  try {
    const data = await getReferralSummary(req.user.id);
    return res.json({ success: true, data });
  } catch (error) {
    console.error('[REFERRAL_SUMMARY]', error);
    return res.status(500).json({ message: 'Could not load your referral summary.' });
  }
});

router.get('/admin/config', authenticateAdmin, async (_req, res) => {
  try {
    return res.json({ success: true, config: await getReferralConfig() });
  } catch (error) {
    console.error('[REFERRAL_ADMIN_CONFIG]', error);
    return res.status(500).json({ message: 'Could not load referral settings.' });
  }
});

router.put('/admin/config', authenticateAdmin, async (req, res) => {
  const config = req.body || {};
  const modes = ['wallet', 'coupon', 'wallet_coupon'];
  const amount = Number(config.wallet_reward_amount);
  const couponValue = Number(config.coupon_discount_value);
  const minimum = Number(config.coupon_min_order_amount);
  const validDays = Number(config.coupon_valid_days);
  if (
    !modes.includes(config.reward_mode) ||
    !['fixed', 'percentage'].includes(config.coupon_discount_type) ||
    !Number.isFinite(amount) || amount < 0 || amount > 100000 ||
    !Number.isFinite(couponValue) || couponValue <= 0 || couponValue > (config.coupon_discount_type === 'percentage' ? 100 : 100000) ||
    !Number.isFinite(minimum) || minimum < 0 ||
    !Number.isInteger(validDays) || validDays < 1 || validDays > 365
  ) {
    return res.status(400).json({ code: 'INVALID_REFERRAL_CONFIG', message: 'Enter a valid referral reward amount, coupon, minimum order, and expiry.' });
  }
  try {
    const saved = await saveReferralConfig({ ...defaultConfig, ...config, enabled: config.enabled === true || config.enabled === 1 || config.enabled === '1' });
    return res.json({ success: true, config: saved });
  } catch (error) {
    console.error('[REFERRAL_ADMIN_CONFIG_SAVE]', error);
    return res.status(500).json({ message: 'Could not save referral settings.' });
  }
});

router.get('/admin/referrals', authenticateAdmin, async (req, res) => {
  const page = Math.max(1, Math.min(10000, Number.parseInt(req.query.page, 10) || 1));
  const limit = Math.max(1, Math.min(100, Number.parseInt(req.query.limit, 10) || 25));
  try {
    await approveDueReferralClaims();
    const [rows] = await pool.query(
      `SELECT c.id AS claim_id, c.status, c.verified_at, c.auto_approve_at,
        c.reviewed_at, c.decision_reason, c.wallet_amount, c.coupon_code,
        referrer.id AS referrer_id, referrer.name AS referrer_name, referrer.email AS referrer_email,
        referred.id AS referred_id, referred.name AS referred_name, referred.email AS referred_email
       FROM referral_claims c
       JOIN users referred ON referred.id = c.referred_user_id
       JOIN users referrer ON referrer.id = c.referrer_user_id
       ORDER BY (c.status = 'pending') DESC, c.verified_at DESC LIMIT ? OFFSET ?`,
      [limit, (page - 1) * limit]
    );
    return res.json({ success: true, referrals: rows, page, limit });
  } catch (error) {
    console.error('[REFERRAL_ADMIN_LIST]', error);
    return res.status(500).json({ message: 'Could not load referrals.' });
  }
});

router.patch('/admin/referrals/:claimId/decision', authenticateAdmin, async (req, res) => {
  const claimId = Number(req.params.claimId);
  const decision = req.body?.decision;
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 255) : '';
  if (!Number.isSafeInteger(claimId) || claimId < 1 ||
      !['approved', 'rejected'].includes(decision) ||
      (decision === 'rejected' && reason.length < 5)) {
    return res.status(400).json({
      code: 'INVALID_REFERRAL_DECISION',
      message: 'Choose approve or reject. A rejection also needs a reason of at least 5 characters.',
    });
  }
  try {
    const result = await decideReferralClaim(claimId, decision, req.user.id, reason || null);
    if (result.alreadyDecided) {
      return res.status(409).json({ code: 'REFERRAL_ALREADY_REVIEWED', message: `This referral is already ${result.status.replace('_', ' ')}.` });
    }
    return res.json({ success: true, referral: result });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ code: 'REFERRAL_REVIEW_FAILED', message: error.message });
    console.error('[REFERRAL_ADMIN_DECISION]', error);
    return res.status(500).json({ message: 'Could not update this referral.' });
  }
});

module.exports = router;
