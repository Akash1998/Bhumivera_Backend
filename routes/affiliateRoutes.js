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
const {
  defaultProgramConfig,
  getProgramConfig,
  saveProgramConfig,
  applyForPartner,
  getPartnerByCode,
  updatePartner,
  listPartners,
  getPartnerDashboard,
  listCommissions,
  listPayouts,
  payCommission,
} = require('../models/affiliatePartnerModel');

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




router.get('/program-config', async (_req, res) => {
  try {
    const config = await getProgramConfig();
    return res.json({ success: true, minimumOrderAmount: config.minimum_order_amount });
  } catch (error) {
    console.error('[AFFILIATE_PROGRAM_PUBLIC_CONFIG]', error);
    return res.status(500).json({ message: 'Could not load checkout minimum settings.' });
  }
});

router.get('/offer', referralPreviewLimiter, async (req, res) => {
  const code = typeof req.query.code === 'string' ? req.query.code.trim() : '';
  if (!code) return res.status(400).json({ success: false, message: 'Enter a promoter code.' });
  try {
    const [partner, config] = await Promise.all([getPartnerByCode(code), getProgramConfig()]);
    if (!partner) return res.status(404).json({ success: false, code: 'PROMOTER_CODE_INVALID', message: 'This promoter offer is not active.' });
    return res.json({
      success: true,
      offer: {
        code: partner.referral_code,
        discountPercent: Number(partner.discount_percent),
        minimumOrderAmount: Number(config.minimum_order_amount),
      },
    });
  } catch (error) {
    console.error('[AFFILIATE_OFFER_LOOKUP]', error);
    return res.status(500).json({ message: 'Could not verify this promoter offer.' });
  }
});

router.post('/partner/apply', authenticateUser, async (req, res) => {
  const socialPlatform = typeof req.body?.socialPlatform === 'string' ? req.body.socialPlatform.trim().slice(0, 40) : '';
  const socialHandle = typeof req.body?.socialHandle === 'string' ? req.body.socialHandle.trim().slice(0, 120) : '';
  const profileUrl = typeof req.body?.profileUrl === 'string' ? req.body.profileUrl.trim().slice(0, 500) : '';
  const followerCount = Number(req.body?.followerCount);
  if (!socialPlatform || !socialHandle || !Number.isSafeInteger(followerCount) || followerCount < 0 || followerCount > 100000000) {
    return res.status(400).json({ code: 'INVALID_PARTNER_APPLICATION', message: 'Add your platform, profile name, and a valid follower count.' });
  }
  if (profileUrl) {
    try {
      const parsed = new URL(profileUrl);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('Unsupported profile URL.');
    } catch {
      return res.status(400).json({ code: 'INVALID_PARTNER_PROFILE_URL', message: 'Use a valid public profile URL.' });
    }
  }
  try {
    const result = await applyForPartner({
      userId: req.user.id,
      socialPlatform,
      socialHandle,
      profileUrl,
      followerCount,
    });
    return res.status(result.alreadyApplied ? 200 : 201).json({ success: true, ...result });
  } catch (error) {
    console.error('[AFFILIATE_PARTNER_APPLICATION]', error);
    return res.status(500).json({ message: 'Could not submit your promoter application.' });
  }
});

router.get('/partner/me', authenticateUser, async (req, res) => {
  try {
    return res.json({ success: true, dashboard: await getPartnerDashboard(req.user.id) });
  } catch (error) {
    console.error('[AFFILIATE_PARTNER_DASHBOARD]', error);
    return res.status(500).json({ message: 'Could not load your promoter dashboard.' });
  }
});

router.get('/admin/program-config', authenticateAdmin, async (_req, res) => {
  try {
    return res.json({ success: true, config: await getProgramConfig() });
  } catch (error) {
    console.error('[AFFILIATE_PROGRAM_CONFIG]', error);
    return res.status(500).json({ message: 'Could not load promoter program settings.' });
  }
});

const saveProgramConfigHandler = async (req, res) => {
  const config = {};
  for (const key of Object.keys(defaultProgramConfig)) {
    config[key] = Number(req.body?.[key]);
  }
  const bounds = {
    default_customer_discount_percent: [0, 60],
    default_commission_share_percent: [0, 100],
    fulfillment_cost: [0, 100000],
    rto_reserve: [0, 100000],
    online_payment_fee_percent: [0, 20],
    minimum_retained_margin_percent: [0, 80],
    target_retained_margin_percent: [0, 100],
    minimum_order_amount: [0, 1000000],
  };
  const valid = Object.entries(bounds).every(([key, [minimum, maximum]]) =>
    Number.isFinite(config[key]) && config[key] >= minimum && config[key] <= maximum
  ) && config.target_retained_margin_percent >= config.minimum_retained_margin_percent;
  if (!valid) {
    return res.status(400).json({ code: 'INVALID_AFFILIATE_PROGRAM_CONFIG', message: 'Enter valid amounts and percentages. The target margin must not be below the hard minimum.' });
  }
  try {
    return res.json({ success: true, config: await saveProgramConfig(config) });
  } catch (error) {
    console.error('[AFFILIATE_PROGRAM_CONFIG_SAVE]', error);
    return res.status(500).json({ message: 'Could not save promoter program settings.' });
  }
};
router.put('/admin/program-config', authenticateAdmin, saveProgramConfigHandler);

router.get(['/admin/partners', '/partners'], authenticateAdmin, async (_req, res) => {
  try {
    return res.json({ success: true, partners: await listPartners() });
  } catch (error) {
    console.error('[AFFILIATE_ADMIN_PARTNERS]', error);
    return res.status(500).json({ message: 'Could not load promoter applications.' });
  }
});

router.patch(['/admin/partners/:id', '/partners/:id/status'], authenticateAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const status = req.body?.status;
  const discountPercent = Number(req.body?.discountPercent ?? req.body?.discount_percent);
  const commissionSharePercent = Number(req.body?.commissionSharePercent ?? req.body?.commission_share_percent);
  const adminNotes = typeof req.body?.adminNotes === 'string' ? req.body.adminNotes.trim().slice(0, 1000) : '';
  const referralCode = typeof req.body?.referralCode === 'string' ? req.body.referralCode.trim() : '';
  if (!Number.isSafeInteger(id) || id < 1 ||
      !['approved', 'rejected', 'paused'].includes(status) ||
      !Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 60 ||
      !Number.isFinite(commissionSharePercent) || commissionSharePercent < 0 || commissionSharePercent > 100 ||
      (referralCode && !/^[A-Z0-9_-]{4,32}$/i.test(referralCode))) {
    return res.status(400).json({ code: 'INVALID_PARTNER_UPDATE', message: 'Choose a valid status and discount/commission rates.' });
  }
  try {
    const partner = await updatePartner(id, {
      status,
      discountPercent,
      commissionSharePercent,
      referralCode: referralCode || null,
      adminNotes,
      adminId: req.user.id,
    });
    return res.json({ success: true, partner });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ code: 'PARTNER_UPDATE_FAILED', message: error.message });
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ code: 'PROMOTER_CODE_TAKEN', message: 'That promoter code is already in use.' });
    console.error('[AFFILIATE_PARTNER_UPDATE]', error);
    return res.status(500).json({ message: 'Could not update this promoter.' });
  }
});

router.get(['/admin/commissions', '/withdrawals'], authenticateAdmin, async (_req, res) => {
  try {
    const [commissions, payouts] = await Promise.all([listCommissions(), listPayouts()]);
    return res.json({ success: true, commissions, payouts });
  } catch (error) {
    console.error('[AFFILIATE_ADMIN_COMMISSIONS]', error);
    return res.status(500).json({ message: 'Could not load promoter commissions and payouts.' });
  }
});

router.post(['/admin/commissions/:id/payout', '/withdrawals/:id/approve'], authenticateAdmin, async (req, res) => {
  const commissionId = Number(req.params.id);
  const reference = typeof req.body?.reference === 'string' ? req.body.reference.trim().slice(0, 120) : '';
  if (!Number.isSafeInteger(commissionId) || commissionId < 1 || reference.length < 3) {
    return res.status(400).json({ code: 'INVALID_AFFILIATE_PAYOUT', message: 'Add a valid commission ID and payment reference.' });
  }
  try {
    const payout = await payCommission({ commissionId, reference, adminId: req.user.id });
    return res.json({ success: true, payout });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ code: 'AFFILIATE_PAYOUT_FAILED', message: error.message });
    console.error('[AFFILIATE_PAYOUT]', error);
    return res.status(500).json({ message: 'Could not record this promoter payout.' });
  }
});

router.get('/config', authenticateAdmin, async (_req, res) => {
  try {
    return res.json({ success: true, config: await getProgramConfig() });
  } catch (error) {
    console.error('[AFFILIATE_LEGACY_CONFIG]', error);
    return res.status(500).json({ message: 'Could not load promoter program settings.' });
  }
});

router.put('/config', authenticateAdmin, saveProgramConfigHandler);

module.exports = router;

