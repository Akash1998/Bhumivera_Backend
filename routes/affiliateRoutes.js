const express = require('express');
const pool = require('../config/db');
const { authenticateAdmin, authenticateUser } = require('../middleware/authMiddleware');
const { referralPreviewLimiter } = require('../middleware/rateLimiter');
const {
  defaultConfig,
  getReferralConfig,
  getReferralSummary,
  previewReferral,
  saveReferralConfig,
  decideReferralClaim,
  reissueReferralCoupon,
  approveDueReferralClaims,
} = require('../models/referralModel');

const router = express.Router();

router.get('/referral/preview', referralPreviewLimiter, async (req, res) => {
  try {
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    if (!code && !token) {
      return res.status(400).json({ success: false, message: 'Provide a referral code or link token.' });
    }
    const referral = await previewReferral({ code, token });
    return res.json({ success: true, valid: Boolean(referral), referrerName: referral?.referrerName || null });
  } catch (error) {
    console.error('[REFERRAL_PREVIEW]', error);
    return res.status(500).json({ success: false, message: 'Could not verify this referral.' });
  }
});

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
  const referredAmount = Number(config.referred_reward_amount);
  const walletPerOrderLimit = Number(config.wallet_reward_per_order_limit);
  const couponValue = Number(config.coupon_discount_value);
  const minimum = Number(config.coupon_min_order_amount);
  const validDays = Number(config.coupon_valid_days);
  const tiers = config.referral_redemption_tiers;
  const validTiers = Array.isArray(tiers) && tiers.length > 0 && tiers.length <= 10 &&
    tiers.every(tier => tier?.min_order_amount !== '' && tier?.min_order_amount !== null && tier?.min_order_amount !== undefined &&
      tier?.referral_amount !== '' && tier?.referral_amount !== null && tier?.referral_amount !== undefined &&
      Number.isFinite(Number(tier?.min_order_amount)) &&
      Number(tier.min_order_amount) >= 0 && Number(tier.min_order_amount) <= 1000000 &&
      Number.isFinite(Number(tier?.referral_amount)) && Number(tier.referral_amount) > 0 &&
      Number(tier.referral_amount) <= 100000) &&
    new Set(tiers.map(tier => Number(tier.min_order_amount))).size === tiers.length;
  if (
    !modes.includes(config.reward_mode) ||
    !['fixed', 'percentage'].includes(config.coupon_discount_type) ||
    !Number.isFinite(amount) || amount < 0 || amount > 100000 ||
    !Number.isFinite(referredAmount) || referredAmount < 0 || referredAmount > 100000 ||
    !Number.isFinite(walletPerOrderLimit) || walletPerOrderLimit < 0 || walletPerOrderLimit > 100000 ||
    (config.reward_mode === 'wallet_coupon' && amount > 0 && walletPerOrderLimit <= 0) ||
    !Number.isFinite(couponValue) || couponValue <= 0 || couponValue > (config.coupon_discount_type === 'percentage' ? 100 : 100000) ||
    !Number.isFinite(minimum) || minimum < 0 ||
    !Number.isInteger(validDays) || validDays < 1 || validDays > 365 || !validTiers
  ) {
    return res.status(400).json({ code: 'INVALID_REFERRAL_CONFIG', message: 'Enter valid reward settings and one to ten unique order thresholds with positive referral amounts.' });
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
        c.reviewed_at, c.decision_reason, c.wallet_amount, c.referred_wallet_amount, c.coupon_code,
        c.wallet_bucket, COALESCE(rw.balance, 0) AS referral_wallet_balance,
        COALESCE(rwr.balance, 0) AS referred_referral_wallet_balance,
        referrer.id AS referrer_id, referrer.name AS referrer_name, referrer.email AS referrer_email,
        referred.id AS referred_id, referred.name AS referred_name, referred.email AS referred_email
       FROM referral_claims c
       LEFT JOIN referral_wallets rw ON rw.user_id = c.referrer_user_id
      LEFT JOIN referral_wallets rwr ON rwr.user_id = c.referred_user_id
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

router.post('/admin/referrals/:claimId/reissue-coupon', authenticateAdmin, async (req, res) => {
  const claimId = Number(req.params.claimId);
  if (!Number.isSafeInteger(claimId) || claimId < 1) {
    return res.status(400).json({ code: 'INVALID_REFERRAL_CLAIM', message: 'Choose a valid referral record.' });
  }
  try {
    const result = await reissueReferralCoupon(claimId);
    return res.json({ success: true, ...result });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ code: 'REFERRAL_COUPON_REISSUE_FAILED', message: error.message });
    console.error('[REFERRAL_COUPON_REISSUE]', error);
    return res.status(500).json({ code: 'REFERRAL_COUPON_REISSUE_FAILED', message: 'Could not reissue this referral coupon.' });
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


const unavailableAffiliateWorkflow = (_req, res) =>
  res.status(501).json({
    success: false,
    code: 'AFFILIATE_WORKFLOW_UNAVAILABLE',
    message: 'Affiliate partner and withdrawal management is not enabled; use referral rewards.',
  });

router.all('/partners', authenticateAdmin, unavailableAffiliateWorkflow);
router.all('/partners/:id/status', authenticateAdmin, unavailableAffiliateWorkflow);
router.all('/withdrawals', authenticateAdmin, unavailableAffiliateWorkflow);
router.all('/withdrawals/:id/approve', authenticateAdmin, unavailableAffiliateWorkflow);
router.all('/config', authenticateAdmin, unavailableAffiliateWorkflow);

module.exports = router;

