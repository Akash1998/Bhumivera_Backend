const express = require('express');
const pool = require('../config/db');
const { authenticateAdmin, authenticateUser } = require('../middleware/authMiddleware');
const { referralPreviewLimiter } = require('../middleware/rateLimiter');
const { calculateAffiliateProfit } = require('../services/affiliateProfitPolicy');
const {
  defaultConfig,
  getReferralConfig,
  getReferralSummary,
  previewReferral,
  saveReferralConfig,
  decideReferralClaim,
  bulkDecideReferralClaims,
  getAdminReferralStats,
  issueManualReferralGrant,
  reissueReferralCoupon,
  approveDueReferralClaims,
} = require('../models/referralModel');
const {
  defaultProgramConfig,
  getProgramConfig,
  saveProgramConfig,
  applyForPartner,
  createAdminPartner,
  getPartnerByCode,
  updatePartner,
  bulkUpdatePartners,
  listPartners,
  getPartnerDashboard,
  listCommissions,
  listPayouts,
  getAdminPromoterAnalytics,
  getPartnerPerformance,
  payCommission,
  bulkPayCommissions,
  submitPartnerReelAndCode,
  updatePartnerCreatorProfile,
  listCampaignBriefs,
  saveCampaignBrief,
  deleteCampaignBrief,
  getPublicPromotionsShowcase,
} = require('../models/affiliatePartnerModel');

const router = express.Router();
const analyticsPeriods = new Set(['7d', '30d', '90d', 'month', 'all']);

router.get('/promotions-showcase', async (_req, res) => {
  try {
    const showcase = await getPublicPromotionsShowcase();
    return res.json({ success: true, ...showcase });
  } catch (error) {
    console.error('[AFFILIATE_PROMOTIONS_SHOWCASE]', error);
    return res.status(500).json({ message: 'Could not load creator partnership showcase.' });
  }
});

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

router.get('/admin/referrals/stats', authenticateAdmin, async (_req, res) => {
  try {
    const stats = await getAdminReferralStats();
    return res.json({ success: true, ...stats });
  } catch (error) {
    console.error('[REFERRAL_ADMIN_STATS]', error);
    return res.status(500).json({ message: 'Could not load referral engine statistics.' });
  }
});

router.post('/admin/referrals/bulk-decision', authenticateAdmin, async (req, res) => {
  const claimIds = Array.isArray(req.body?.claimIds) ? req.body.claimIds : [];
  const decision = req.body?.decision;
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 255) : '';
  if (!claimIds.length || claimIds.length > 100 || !['approved', 'rejected'].includes(decision) || (decision === 'rejected' && reason.length < 5)) {
    return res.status(400).json({
      code: 'INVALID_BULK_REFERRAL_DECISION',
      message: 'Select 1 to 100 pending referrals and choose approve or reject (with a reason of at least 5 characters for rejections).',
    });
  }
  try {
    const result = await bulkDecideReferralClaims({
      claimIds,
      decision,
      adminId: req.user.id,
      reason: reason || null,
    });
    return res.json({ success: true, ...result });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ code: 'BULK_REFERRAL_DECISION_FAILED', message: error.message });
    console.error('[REFERRAL_ADMIN_BULK_DECISION]', error);
    return res.status(500).json({ message: 'Could not process bulk referral decisions.' });
  }
});

router.post('/admin/referrals/manual-grant', authenticateAdmin, async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
  const amount = Number(req.body?.amount);
  const bucket = req.body?.bucket === 'cash' ? 'cash' : 'referral';
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  if (!email || !Number.isFinite(amount) || amount <= 0 || amount > 100000 || reason.length < 5) {
    return res.status(400).json({
      code: 'INVALID_MANUAL_REFERRAL_GRANT',
      message: 'Enter a valid customer email, positive reward amount (up to ₹1,00,000), and a reason of at least 5 characters.',
    });
  }
  try {
    const grant = await issueManualReferralGrant({
      email,
      amount,
      bucket,
      reason,
      adminId: req.user.id,
    });
    return res.status(201).json({ success: true, grant });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ code: 'MANUAL_REFERRAL_GRANT_FAILED', message: error.message });
    console.error('[REFERRAL_MANUAL_GRANT]', error);
    return res.status(500).json({ message: 'Could not issue manual referral grant.' });
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
  const submittedHandle = typeof req.body?.socialHandle === 'string' ? req.body.socialHandle.trim().slice(0, 120) : '';
  const profileUrl = typeof req.body?.profileUrl === 'string' ? req.body.profileUrl.trim().slice(0, 500) : '';
  const followerCount = Number(req.body?.followerCount ?? 0);
  const followerTier = typeof req.body?.followerTier === 'string' ? req.body.followerTier.trim() : '';
  const contentNiche = typeof req.body?.contentNiche === 'string' ? req.body.contentNiche.trim() : '';
  const collaborationType = typeof req.body?.collaborationType === 'string' ? req.body.collaborationType.trim() : '';
  const partnershipIntent = typeof req.body?.partnershipIntent === 'string'
    ? req.body.partnershipIntent.trim()
    : '';
  const preferredProducts = typeof req.body?.preferredProducts === 'string' ? req.body.preferredProducts.trim().slice(0, 500) : undefined;
  const contentFormats = typeof req.body?.contentFormats === 'string' ? req.body.contentFormats.trim().slice(0, 255) : undefined;
  const monthlyReachEstimate = typeof req.body?.monthlyReachEstimate === 'string' ? req.body.monthlyReachEstimate.trim().slice(0, 64) : undefined;
  const sampleContentUrl = typeof req.body?.sampleContentUrl === 'string' ? req.body.sampleContentUrl.trim().slice(0, 500) : undefined;
  const whatsappContact = typeof req.body?.whatsappContact === 'string' ? req.body.whatsappContact.trim().slice(0, 40) : undefined;

  const allowedProfileHosts = {
    Facebook: ['facebook.com', 'fb.com'],
    Instagram: ['instagram.com'],
    YouTube: ['youtube.com'],
  };
  const allowedFollowerTiers = new Set(['under_1k', '1k_10k', '10k_50k', '50k_plus']);
  const allowedContentNiches = new Set(['Skincare', 'Haircare', 'Lifestyle', 'Wellness', 'Unboxing']);
  const allowedCollaborations = new Set(['both']);
  if (!Object.hasOwn(allowedProfileHosts, socialPlatform) ||
      !submittedHandle ||
      !allowedFollowerTiers.has(followerTier) ||
      !allowedContentNiches.has(contentNiche) ||
      !allowedCollaborations.has(collaborationType) ||
      partnershipIntent.length < 30 ||
      partnershipIntent.length > 800 ||
      !Number.isSafeInteger(followerCount) ||
      followerCount < 0 ||
      followerCount > 100000000) {
    return res.status(400).json({ code: 'INVALID_PARTNER_APPLICATION', message: 'Complete your profile details and tell us in 30–800 characters how you want to build a genuine, nature-minded partnership.' });
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(profileUrl);
  } catch {
    return res.status(400).json({ code: 'INVALID_PARTNER_PROFILE_URL', message: 'Enter a valid public profile URL.' });
  }
  const isAllowedProfileHost = allowedProfileHosts[socialPlatform].some(host =>
    parsedUrl.hostname === host || parsedUrl.hostname.endsWith(`.${host}`)
  );
  if (parsedUrl.protocol !== 'https:' || !isAllowedProfileHost) {
    return res.status(400).json({
      code: 'INVALID_PARTNER_PROFILE_URL',
      message: 'Use an HTTPS profile URL from the selected social platform.',
    });
  }
  try {
    const applicationPayload = {
      userId: req.user.id,
      socialPlatform,
      socialHandle: submittedHandle,
      profileUrl,
      followerCount,
      followerTier,
      contentNiche,
      collaborationType,
      partnershipIntent,
      ...(preferredProducts ? { preferredProducts } : {}),
      ...(contentFormats ? { contentFormats } : {}),
      ...(monthlyReachEstimate ? { monthlyReachEstimate } : {}),
      ...(sampleContentUrl ? { sampleContentUrl } : {}),
      ...(whatsappContact ? { whatsappContact } : {}),
    };
    const result = await applyForPartner(applicationPayload);
    return res.status(result.alreadyApplied ? 200 : 201).json({ success: true, ...result });
  } catch (error) {
    console.error('[AFFILIATE_PARTNER_APPLICATION]', error);
    return res.status(500).json({ message: 'Could not submit your promoter application.' });
  }
});

router.get('/partner/me', authenticateUser, async (req, res) => {
  const commissionPage = Number(req.query?.commissionPage ?? 1);
  if (!Number.isSafeInteger(commissionPage) || commissionPage < 1) {
    return res.status(400).json({ code: 'INVALID_COMMISSION_PAGE', message: 'Choose a valid commission-ledger page.' });
  }
  try {
    return res.json({
      success: true,
      dashboard: await getPartnerDashboard(req.user.id, { commissionPage }),
    });
  } catch (error) {
    console.error('[AFFILIATE_PARTNER_DASHBOARD]', error);
    return res.status(500).json({ message: 'Could not load your promoter dashboard.' });
  }
});

router.patch('/partner/me/perks', authenticateUser, async (req, res) => {
  const customCode = typeof req.body?.customCode === 'string' ? req.body.customCode.trim().toUpperCase() : '';
  const reelUrl = typeof req.body?.reelUrl === 'string' ? req.body.reelUrl.trim() : '';
  const trialOrderId = req.body?.trialOrderId ? Number(req.body.trialOrderId) : null;
  const hasTrialOrderSubmission = req.body?.trialOrderId !== undefined &&
    req.body?.trialOrderId !== null &&
    req.body?.trialOrderId !== '';

  if (reelUrl || hasTrialOrderSubmission) {
    return res.status(409).json({
      code: 'CREATOR_PAID_COLLABORATION_COMING_SOON',
      message: 'Paid creator collaborations and trial reimbursements are coming soon. The current program is product gifting/barter with affiliate profit sharing.',
    });
  }

  if (customCode && !/^[A-Z0-9_-]{4,20}$/.test(customCode)) {
    return res.status(400).json({
      code: 'INVALID_CUSTOM_CODE',
      message: 'Custom promo code must be 4–20 letters or numbers (e.g., AYEESHA10).',
    });
  }
  if (reelUrl) {
    try {
      const parsed = new URL(reelUrl);
      if (parsed.protocol !== 'https:') throw new Error('HTTPS required');
    } catch {
      return res.status(400).json({
        code: 'INVALID_REEL_URL',
        message: 'Enter a valid HTTPS link to your published Instagram Reel or YouTube Short.',
      });
    }
  }
  try {
    const dashboard = await submitPartnerReelAndCode(req.user.id, { customCode, reelUrl, trialOrderId });
    return res.json({ success: true, dashboard });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ code: 'PROMOTER_CODE_TAKEN', message: 'That custom code is already taken. Try adding 10 or 15 at the end.' });
    }
    if (error.status) return res.status(error.status).json({ message: error.message });
    console.error('[AFFILIATE_PARTNER_PERKS_UPDATE]', error);
    return res.status(500).json({ message: 'Could not update your creator perks.' });
  }
});

router.patch('/partner/me/profile', authenticateUser, async (req, res) => {
  const body = req.body || {};
  const sampleContentUrl = typeof body.sampleContentUrl === 'string' ? body.sampleContentUrl.trim() : '';
  if (sampleContentUrl) {
    try {
      const parsed = new URL(sampleContentUrl);
      if (parsed.protocol !== 'https:') throw new Error('HTTPS required');
    } catch {
      return res.status(400).json({
        code: 'INVALID_SAMPLE_CONTENT_URL',
        message: 'Enter a valid HTTPS URL for your sample content link.',
      });
    }
  }
  try {
    const dashboard = await updatePartnerCreatorProfile(req.user.id, {
      preferredProducts: body.preferredProducts,
      contentFormats: body.contentFormats,
      monthlyReachEstimate: body.monthlyReachEstimate,
      sampleContentUrl: sampleContentUrl || undefined,
      payoutUpiId: body.payoutUpiId,
      whatsappContact: body.whatsappContact,
      acknowledgeBrief: Boolean(body.acknowledgeBrief),
    });
    return res.json({ success: true, dashboard });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    console.error('[AFFILIATE_PARTNER_PROFILE_UPDATE]', error);
    return res.status(500).json({ message: 'Could not update your creator profile preferences.' });
  }
});

router.get('/admin/campaign-briefs', authenticateAdmin, async (_req, res) => {
  try {
    return res.json({ success: true, briefs: await listCampaignBriefs({ activeOnly: false }) });
  } catch (error) {
    console.error('[AFFILIATE_ADMIN_CAMPAIGN_BRIEFS]', error);
    return res.status(500).json({ message: 'Could not load creator campaign briefs.' });
  }
});

router.post('/admin/campaign-briefs', authenticateAdmin, async (req, res) => {
  try {
    const briefs = await saveCampaignBrief(req.body || {});
    return res.status(201).json({ success: true, briefs });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ code: 'INVALID_CAMPAIGN_BRIEF', message: error.message });
    console.error('[AFFILIATE_ADMIN_CAMPAIGN_BRIEF_SAVE]', error);
    return res.status(500).json({ message: 'Could not save this creator campaign brief.' });
  }
});

router.delete('/admin/campaign-briefs/:id', authenticateAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) {
    return res.status(400).json({ code: 'INVALID_CAMPAIGN_BRIEF_ID', message: 'Choose a valid campaign brief ID.' });
  }
  try {
    const briefs = await deleteCampaignBrief(id);
    return res.json({ success: true, briefs });
  } catch (error) {
    console.error('[AFFILIATE_ADMIN_CAMPAIGN_BRIEF_DELETE]', error);
    return res.status(500).json({ message: 'Could not delete this campaign brief.' });
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

router.get('/admin/analytics', authenticateAdmin, async (req, res) => {
  const period = typeof req.query.period === 'string' ? req.query.period : '30d';
  if (!analyticsPeriods.has(period)) {
    return res.status(400).json({ code: 'INVALID_ANALYTICS_PERIOD', message: 'Choose a valid reporting period.' });
  }
  try {
    return res.json({ success: true, ...(await getAdminPromoterAnalytics(period)) });
  } catch (error) {
    console.error('[AFFILIATE_ADMIN_ANALYTICS]', error);
    return res.status(500).json({ message: 'Could not load promoter performance analytics.' });
  }
});

router.get('/admin/partners/:id/performance', authenticateAdmin, async (req, res) => {
  const partnerId = Number(req.params.id);
  const period = typeof req.query.period === 'string' ? req.query.period : '30d';
  const orderPage = Math.max(1, Math.min(100000, Number.parseInt(req.query.orderPage, 10) || 1));
  const customerPage = Math.max(1, Math.min(100000, Number.parseInt(req.query.customerPage, 10) || 1));
  const limit = Math.max(1, Math.min(100, Number.parseInt(req.query.limit, 10) || 20));
  const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 120) : '';
  if (!Number.isSafeInteger(partnerId) || partnerId < 1 || !analyticsPeriods.has(period)) {
    return res.status(400).json({ code: 'INVALID_PARTNER_PERFORMANCE_QUERY', message: 'Choose a valid promoter and reporting period.' });
  }
  try {
    const performance = await getPartnerPerformance({
      partnerId,
      period,
      orderPage,
      customerPage,
      limit,
      search,
    });
    if (!performance) return res.status(404).json({ message: 'Promoter not found.' });
    return res.json({ success: true, ...performance });
  } catch (error) {
    console.error('[AFFILIATE_PARTNER_PERFORMANCE]', error);
    return res.status(500).json({ message: 'Could not load this promoter’s customer and order details.' });
  }
});

router.get('/admin/eligible-products', authenticateAdmin, async (_req, res) => {
  try {
    const [products] = await pool.query(
      `SELECT p.id, p.name, p.price,
         COALESCE(NULLIF(p.discount_price, 0), p.price) AS selling_price,
         COALESCE(p.gst_rate, m.gst_rate, 18) AS gst_rate,
         m.cost_price
       FROM products p
       JOIN inventory_product_meta m ON m.product_id = p.id
       WHERE p.status = 'active' AND m.cost_price > 0
       ORDER BY p.name ASC
       LIMIT 500`
    );
    return res.json({ success: true, products });
  } catch (error) {
    console.error('[AFFILIATE_ADMIN_ELIGIBLE_PRODUCTS]', error);
    return res.status(500).json({ message: 'Could not load active products with inventory costs.' });
  }
});

router.post('/admin/simulate', authenticateAdmin, async (req, res) => {
  const scenarioMode = req.body?.scenarioMode;
  const referredPeople = Number(req.body?.referredPeople);
  const conversionPercent = Number(req.body?.conversionPercent);
  const salesTarget = Number(req.body?.salesTarget);
  const paymentMode = req.body?.paymentMode;
  const partnerId = req.body?.partnerId === '' || req.body?.partnerId == null ? null : Number(req.body.partnerId);
  const basket = Array.isArray(req.body?.basket) ? req.body.basket : [];
  const basketIsValid = basket.length > 0 && basket.length <= 20 &&
    basket.every(item => Number.isSafeInteger(Number(item?.productId)) && Number(item.productId) > 0 &&
      Number.isSafeInteger(Number(item?.quantity)) && Number(item.quantity) > 0 && Number(item.quantity) <= 100) &&
    new Set(basket.map(item => Number(item.productId))).size === basket.length;
  if (!['conversion', 'sales_target'].includes(scenarioMode) ||
      !Number.isSafeInteger(referredPeople) || referredPeople < 1 || referredPeople > 10000000 ||
      (scenarioMode === 'conversion' && (!Number.isFinite(conversionPercent) || conversionPercent < 0 || conversionPercent > 100)) ||
      (scenarioMode === 'sales_target' && (!Number.isFinite(salesTarget) || salesTarget < 0 || salesTarget > 1000000000)) ||
      !['online', 'COD', 'WALLET'].includes(paymentMode) || !basketIsValid ||
      (partnerId !== null && (!Number.isSafeInteger(partnerId) || partnerId < 1))) {
    return res.status(400).json({
      code: 'INVALID_PROMOTER_SCENARIO',
      message: 'Enter a referral count, valid conversion or sales target, payment mode, promoter, and one to twenty inventory-priced products.',
    });
  }
  try {
    const config = await getProgramConfig();
    let discountPercent = config.default_customer_discount_percent;
    let commissionSharePercent = config.default_commission_share_percent;
    if (partnerId !== null) {
      const [[partner]] = await pool.query(
        'SELECT id, discount_percent, commission_share_percent FROM affiliate_partners WHERE id = ? LIMIT 1',
        [partnerId]
      );
      if (!partner) return res.status(404).json({ message: 'Promoter not found.' });
      discountPercent = Number(partner.discount_percent);
      commissionSharePercent = Number(partner.commission_share_percent);
    }

    const productIds = basket.map(item => Number(item.productId));
    const placeholders = productIds.map(() => '?').join(',');
    const [productRows] = await pool.query(
      `SELECT p.id, p.name, COALESCE(NULLIF(p.discount_price, 0), p.price) AS selling_price,
         COALESCE(p.gst_rate, m.gst_rate, 18) AS gst_rate, m.cost_price
       FROM products p
       JOIN inventory_product_meta m ON m.product_id = p.id
       WHERE p.status = 'active' AND m.cost_price > 0 AND p.id IN (${placeholders})`,
      productIds
    );
    if (productRows.length !== productIds.length) {
      return res.status(400).json({
        code: 'PROMOTER_SCENARIO_PRODUCT_UNAVAILABLE',
        message: 'One or more selected products are inactive or do not have a positive inventory cost.',
      });
    }

    const productById = new Map(productRows.map(product => [Number(product.id), product]));
    const scenarioBasket = basket.map(item => {
      const product = productById.get(Number(item.productId));
      return {
        productId: Number(product.id),
        name: product.name,
        quantity: Number(item.quantity),
        unitPrice: Number(product.selling_price),
        unitCost: Number(product.cost_price),
        gstRate: Number(product.gst_rate),
      };
    });
    const basketSubtotal = scenarioBasket.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
    const discountRate = discountPercent / 100;
    const basketDiscount = basketSubtotal * discountRate;
    const discountedBasketValue = basketSubtotal - basketDiscount;
    if (!(discountedBasketValue > 0)) {
      return res.status(400).json({ code: 'INVALID_PROMOTER_SCENARIO_BASKET', message: 'The selected product basket must have a positive discounted value.' });
    }

    const expectedOrders = scenarioMode === 'sales_target'
      ? salesTarget / discountedBasketValue
      : referredPeople * conversionPercent / 100;
    const totalMerchandiseSales = scenarioMode === 'sales_target'
      ? salesTarget
      : discountedBasketValue * expectedOrders;
    const merchandiseSubtotal = basketSubtotal * expectedOrders;
    const totalDiscount = basketDiscount * expectedOrders;
    const impliedConversionPercent = expectedOrders / referredPeople * 100;
    const belowMinimum = expectedOrders > 0 && discountedBasketValue < config.minimum_order_amount;
    const profit = calculateAffiliateProfit({
      items: scenarioBasket.map(item => ({
        unitPrice: item.unitPrice,
        quantity: item.quantity * expectedOrders,
        gstRate: item.gstRate,
        unitCost: item.unitCost,
      })),
      merchandiseSubtotal,
      totalMerchandiseDiscount: totalDiscount,
      paymentTotal: totalMerchandiseSales,
      paymentMode,
      commissionSharePercent,
      fulfillmentCost: config.fulfillment_cost * expectedOrders,
      rtoReserve: config.rto_reserve * expectedOrders,
      onlinePaymentFeePercent: config.online_payment_fee_percent,
      minimumRetainedMarginPercent: config.minimum_retained_margin_percent,
    });
    const result = belowMinimum
      ? {
          ...profit,
          commission: 0,
          retainedProfit: profit.contributionProfit,
          retainedMarginPercent: profit.revenueExcludingTax > 0
            ? Math.round(profit.contributionProfit / profit.revenueExcludingTax * 10000) / 100
            : 0,
          marginFloorMet: false,
          eligible: false,
        }
      : profit;
    return res.json({
      success: true,
      assumptions: {
        scenarioMode,
        referredPeople,
        conversionPercent: scenarioMode === 'conversion' ? conversionPercent : impliedConversionPercent,
        expectedOrders,
        impliedConversionPercent,
        salesTarget: scenarioMode === 'sales_target' ? salesTarget : totalMerchandiseSales,
        totalMerchandiseSales,
        averageOrderValue: discountedBasketValue,
        merchandiseSubtotal,
        totalDiscount,
        paymentMode,
        discountPercent,
        commissionSharePercent,
        basket: scenarioBasket,
      },
      belowMinimum,
      minimumOrderAmount: config.minimum_order_amount,
      result,
    });
  } catch (error) {
    console.error('[AFFILIATE_ADMIN_SIMULATE]', error);
    return res.status(500).json({ message: 'Could not calculate the promoter scenario.' });
  }
});

router.get(['/admin/partners', '/partners'], authenticateAdmin, async (_req, res) => {
  try {
    return res.json({ success: true, partners: await listPartners() });
  } catch (error) {
    console.error('[AFFILIATE_ADMIN_PARTNERS]', error);
    return res.status(500).json({ message: 'Could not load promoter applications.' });
  }
});

router.post('/admin/partners/bulk-update', authenticateAdmin, async (req, res) => {
  const body = req.body || {};
  const partnerIds = Array.isArray(body.partnerIds) ? body.partnerIds : [];
  const status = body.status;
  const hasDiscount = body.discountPercent !== undefined && body.discountPercent !== null && body.discountPercent !== '';
  const hasShare = body.commissionSharePercent !== undefined && body.commissionSharePercent !== null && body.commissionSharePercent !== '';
  const discountPercent = hasDiscount ? Number(body.discountPercent) : undefined;
  const commissionSharePercent = hasShare ? Number(body.commissionSharePercent) : undefined;
  const adminNotes = typeof body.adminNotes === 'string' ? body.adminNotes.trim().slice(0, 1000) : undefined;

  if (!partnerIds.length || partnerIds.length > 100 ||
      (!status && !hasDiscount && !hasShare && adminNotes === undefined) ||
      (status && !['approved', 'rejected', 'paused'].includes(status)) ||
      (hasDiscount && (!Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 60)) ||
      (hasShare && (!Number.isFinite(commissionSharePercent) || commissionSharePercent < 0 || commissionSharePercent > 100))) {
    return res.status(400).json({
      code: 'INVALID_BULK_PARTNER_UPDATE',
      message: 'Select 1 to 100 promoters and provide a valid status, discount rate (0–60%), or profit-share rate (0–100%).',
    });
  }
  try {
    const result = await bulkUpdatePartners({
      partnerIds,
      status,
      discountPercent,
      commissionSharePercent,
      adminNotes,
      adminId: req.user.id,
    });
    return res.json({ success: true, ...result });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ code: 'BULK_PARTNER_UPDATE_FAILED', message: error.message });
    console.error('[AFFILIATE_ADMIN_BULK_PARTNER_UPDATE]', error);
    return res.status(500).json({ message: 'Could not complete bulk promoter update.' });
  }
});

router.post('/admin/partners', authenticateAdmin, async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const socialPlatform = typeof req.body?.socialPlatform === 'string' ? req.body.socialPlatform.trim().slice(0, 40) : '';
  const socialHandle = typeof req.body?.socialHandle === 'string' ? req.body.socialHandle.trim().slice(0, 120) : '';
  const profileUrl = typeof req.body?.profileUrl === 'string' ? req.body.profileUrl.trim().slice(0, 500) : '';
  const followerCount = Number(req.body?.followerCount ?? 0);
  const discountPercent = Number(req.body?.discountPercent);
  const commissionSharePercent = Number(req.body?.commissionSharePercent);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 ||
      !socialPlatform || !socialHandle ||
      !Number.isSafeInteger(followerCount) || followerCount < 0 || followerCount > 100000000 ||
      !Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 60 ||
      !Number.isFinite(commissionSharePercent) || commissionSharePercent < 0 || commissionSharePercent > 100) {
    return res.status(400).json({
      code: 'INVALID_ADMIN_PARTNER',
      message: 'Enter an existing customer email, social profile, follower count, and valid discount and contribution-share rates.',
    });
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
    const partner = await createAdminPartner({
      email,
      socialPlatform,
      socialHandle,
      profileUrl,
      followerCount,
      discountPercent,
      commissionSharePercent,
      adminId: req.user.id,
    });
    return res.status(201).json({ success: true, partner });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ code: 'ADMIN_PARTNER_CREATE_FAILED', message: error.message });
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        code: 'ADMIN_PARTNER_ALREADY_EXISTS',
        message: 'This customer already has a promoter record. Find it in the list and update it there.',
      });
    }
    console.error('[AFFILIATE_ADMIN_PARTNER_CREATE]', error);
    return res.status(500).json({ message: 'Could not add this promoter.' });
  }
});

router.patch(['/admin/partners/:id', '/partners/:id/status'], authenticateAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const hasField = (...fields) => fields.some(field => Object.prototype.hasOwnProperty.call(body, field));
  const hasStatus = hasField('status');
  const hasDiscount = hasField('discountPercent', 'discount_percent');
  const hasCommissionShare = hasField('commissionSharePercent', 'commission_share_percent');
  const hasAdminNotes = hasField('adminNotes');
  const hasReferralCode = hasField('referralCode');
  const status = hasStatus ? body.status : undefined;
  const discountValue = body.discountPercent ?? body.discount_percent;
  const commissionShareValue = body.commissionSharePercent ?? body.commission_share_percent;
  const discountPercent = hasDiscount ? Number(discountValue) : undefined;
  const commissionSharePercent = hasCommissionShare ? Number(commissionShareValue) : undefined;
  const isValidPercentInput = value => (
    (typeof value === 'number' || typeof value === 'string') &&
    String(value).trim() !== '' &&
    Number.isFinite(Number(value))
  );
  const adminNotes = hasAdminNotes && typeof body.adminNotes === 'string'
    ? body.adminNotes.trim().slice(0, 1000)
    : hasAdminNotes && body.adminNotes === null ? '' : undefined;
  const referralCode = hasReferralCode && typeof body.referralCode === 'string'
    ? body.referralCode.trim()
    : hasReferralCode && body.referralCode === null ? ''
    : undefined;
  if (!Number.isSafeInteger(id) || id < 1 ||
      (!hasStatus && !hasDiscount && !hasCommissionShare && !hasAdminNotes && !hasReferralCode) ||
      (hasStatus && !['approved', 'rejected', 'paused'].includes(status)) ||
      (hasDiscount && (!isValidPercentInput(discountValue) || discountPercent < 0 || discountPercent > 60)) ||
      (hasCommissionShare && (!isValidPercentInput(commissionShareValue) || commissionSharePercent < 0 || commissionSharePercent > 100)) ||
      (hasAdminNotes && typeof body.adminNotes !== 'string' && body.adminNotes !== null) ||
      (hasReferralCode && typeof body.referralCode !== 'string' && body.referralCode !== null) ||
      (referralCode && !/^[A-Z0-9_-]{4,32}$/i.test(referralCode))) {
    return res.status(400).json({ code: 'INVALID_PARTNER_UPDATE', message: 'Provide valid promoter settings or a valid status change.' });
  }
  try {
    const partner = await updatePartner(id, {
      ...(hasStatus ? { status } : {}),
      discountPercent,
      commissionSharePercent,
      ...(hasReferralCode ? { referralCode } : {}),
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

router.post('/admin/commissions/bulk-payout', authenticateAdmin, async (req, res) => {
  const commissionIds = Array.isArray(req.body?.commissionIds) ? req.body.commissionIds : [];
  const reference = typeof req.body?.reference === 'string' ? req.body.reference.trim().slice(0, 120) : '';
  if (!commissionIds.length || commissionIds.length > 100 || reference.length < 3) {
    return res.status(400).json({
      code: 'INVALID_BULK_AFFILIATE_PAYOUT',
      message: 'Select 1 to 100 approved commissions and enter a valid transfer reference (at least 3 characters).',
    });
  }
  try {
    const result = await bulkPayCommissions({
      commissionIds,
      reference,
      adminId: req.user.id,
    });
    return res.json({ success: true, ...result });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ code: 'BULK_AFFILIATE_PAYOUT_FAILED', message: error.message });
    console.error('[AFFILIATE_BULK_PAYOUT]', error);
    return res.status(500).json({ message: 'Could not record batch promoter payouts.' });
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
