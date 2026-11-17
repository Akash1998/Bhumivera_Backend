const crypto = require('node:crypto');
const pool = require('../config/db');

const defaultProgramConfig = Object.freeze({
  default_customer_discount_percent: 10,
  default_commission_share_percent: 20,
  fulfillment_cost: 110,
  rto_reserve: 40,
  online_payment_fee_percent: 2,
  minimum_retained_margin_percent: 15,
  target_retained_margin_percent: 25,
  minimum_order_amount: 599,
});

const CREATOR_MILESTONES = Object.freeze([
  { orders: 3, key: 'milestone_3_credited_at', rewardInr: 500, label: '₹500 Bhumivera Luxury Gift Card', shareBoost: null, tierBadge: 'Ritual Educator' },
  { orders: 10, key: 'milestone_10_credited_at', rewardInr: 1200, label: '₹1,200 Creator Bonus + Full-Range PR Box', shareBoost: null, tierBadge: 'Botanical Ambassador' },
  { orders: 25, key: 'milestone_25_upgraded_at', rewardInr: 2500, label: '₹2,500 VIP Gift Card + 25% Profit Share Tier', shareBoost: 25, tierBadge: 'Maison Partner' },
]);

const DEFAULT_CAMPAIGN_BRIEFS = Object.freeze([
  {
    id: 1,
    slug: 'seabuckthorn-radiance-ritual',
    title: 'Himalayan Sea Buckthorn Barrier & Radiance Ritual',
    product_name: 'Sea Buckthorn Face Wash (100ml)',
    product_slug: 'himalayan-seabuckthorn-luxury-face-wash',
    category: 'Skincare',
    hook_angle: 'Why pH 5.5 barrier balance + 4% Cold-Pressed Himalayan Sea Buckthorn changes how your skin feels after cleansing',
    key_talking_points: '4% Cold-Pressed Sea Buckthorn (Omega-7 & Vitamin C) · 5% Vegetable Glycerin · Hyaluronic Acid & Niacinamide · Sulfate-free & Paraben-free · No tight or stripped post-wash feeling',
    disclosure_rules: 'Clearly include #ad, #BhumiveraPartner, or #gifted in the first lines. Share genuine texture and routine experience; never make medical or overnight cure claims.',
    recommended_formats: 'Instagram Reels (30–45s), YouTube Shorts, AM/PM Sink-Side Routine',
    is_active: 1,
  },
  {
    id: 2,
    slug: 'royal-botanical-hair-ritual',
    title: 'Saponin-Rich Ayurvedic Hair & Scalp Wash Day',
    product_name: 'Botanical 2-in-1 Shampoo (200ml)',
    product_slug: 'luxury-2-in-1-botanical-shampoo-conditioner',
    category: 'Haircare',
    hook_angle: 'Switching from harsh sulfates to traditional Ayurvedic Reetha, Amla, Shikakai & Rosemary Oil in a single 2-in-1 step',
    key_talking_points: '25mg Reetha (natural saponins) · 20mg Amla & Bhringraj · 10mg Pure Rosemary Oil · Built-in botanical conditioning without heavy silicones',
    disclosure_rules: 'Clearly disclose creator code & commission relationship (#ad / #BhumiveraPartner). Focus on scalp comfort, wash-day ease, and natural shine rather than guaranteed hair regrowth claims.',
    recommended_formats: 'Wash-Day Reel, Ingredient Breakdown Carousel, YouTube Routine',
    is_active: 1,
  },
  {
    id: 3,
    slug: 'artisanal-charcoal-detox-ritual',
    title: 'Daily Pollution & Pore Detox Bathing Ritual',
    product_name: 'Artisanal Cleansing Bar (100g)',
    product_slug: 'artisanal-charcoal-handmade-soap',
    category: 'Skincare',
    hook_angle: 'How microporous Activated Charcoal + soothing Aloe Vera lift urban grime and sweat without drying out body or face skin',
    key_talking_points: 'Handcrafted small-batch Ayurvedic bar · Microporous Activated Charcoal · Soothing Aloe Vera base · Free from harsh synthetic detergents',
    disclosure_rules: 'Use #ad or #BhumiveraPartner disclosure. Highlight lather texture, post-bath skin softness, and humid-weather freshness.',
    recommended_formats: 'ASMR Lather & Texture Short, Gym/Commute Post-Bath Routine',
    is_active: 1,
  },
  {
    id: 4,
    slug: 'kalpvriksh-seven-tulsi-ritual',
    title: 'Inside-Out Botanical Vitality: 7-Tulsi Morning Ritual',
    product_name: 'Seven-Tulsi Drops (30ml)',
    product_slug: 'kalpvriksh-satva-tulsi-7-tulsi-extract',
    category: 'Wellness',
    hook_angle: '2 drops in warm water every morning: exploring 7 sacred varieties of Tulsi for daily botanical wellness',
    key_talking_points: '90% concentrated liquid distillate · 7 Tulsi varieties (Van, Sweet, Marua, Bisva, Kala, Rama & Lemon Tulsi) · Easy warm-water or tea morning ritual',
    disclosure_rules: 'Disclose partnership (#ad / #BhumiveraPartner). Present as a traditional Ayurvedic wellness ritual; never position as a drug or medical treatment.',
    recommended_formats: 'Morning Desk/Tea Ritual Reel, Wellness Habit Vlog, Family Routine Short',
    is_active: 1,
  },
]);

const creditCreatorReferralWallet = async (connection, { userId, amount, description, referenceId }) => {
  const credit = Math.round((Number(amount) || 0) * 100) / 100;
  if (!(credit > 0)) return 0;
  await connection.query(
    'INSERT IGNORE INTO referral_wallets (user_id, balance) VALUES (?, 0.00)',
    [userId]
  );
  await connection.query(
    'UPDATE referral_wallets SET balance = balance + ? WHERE user_id = ?',
    [credit, userId]
  );
  await connection.query(
    `INSERT INTO referral_wallet_transactions (user_id, amount, type, description, reference_id)
     VALUES (?, ?, 'credit', ?, ?)`,
    [userId, credit, description, referenceId]
  );
  return credit;
};

const configKeys = Object.keys(defaultProgramConfig);
const createReferralCode = () => `BV${crypto.randomBytes(5).toString('hex').toUpperCase()}`;

const getProgramConfig = async (connection = pool) => {
  const [rows] = await connection.query(
    "SELECT key_name, value FROM settings WHERE group_name = 'affiliate_program'"
  );
  const stored = Object.fromEntries(rows.map(row => [row.key_name, Number(row.value)]));
  return Object.fromEntries(configKeys.map(key => [
    key,
    Number.isFinite(stored[key]) ? stored[key] : defaultProgramConfig[key],
  ]));
};

const saveProgramConfig = async config => {
  for (const key of configKeys) {
    await pool.query(
      `INSERT INTO settings (group_name, key_name, value)
       VALUES ('affiliate_program', ?, ?)
       ON DUPLICATE KEY UPDATE value = VALUES(value)`,
      [key, String(config[key])]
    );
  }
  return getProgramConfig();
};

const applyForPartner = async ({
  userId,
  socialPlatform,
  socialHandle,
  profileUrl,
  followerCount,
  followerTier,
  contentNiche,
  collaborationType,
  partnershipIntent,
  preferredProducts,
  contentFormats,
  monthlyReachEstimate,
  sampleContentUrl,
  whatsappContact,
}) => {
  const [existing] = await pool.query('SELECT * FROM affiliate_partners WHERE user_id = ? LIMIT 1', [userId]);
  if (existing.length) {
    if (['pending', 'approved', 'paused'].includes(existing[0].status)) {
      if (existing[0].status === 'pending' && !existing[0].referral_code) {
        const referralCode = createReferralCode();
        const [updateResult] = await pool.query(
          'UPDATE affiliate_partners SET referral_code = ? WHERE id = ? AND status = \'pending\' AND referral_code IS NULL',
          [referralCode, existing[0].id]
        );
        if (updateResult.affectedRows > 0) {
          existing[0].referral_code = referralCode;
        } else {
          const [[currentPartner]] = await pool.query(
            'SELECT referral_code FROM affiliate_partners WHERE id = ?',
            [existing[0].id]
          );
          existing[0].referral_code = currentPartner?.referral_code || null;
        }
      }
      return { partner: existing[0], alreadyApplied: true };
    }
    await pool.query(
      `UPDATE affiliate_partners
       SET social_platform = ?, social_handle = ?, profile_url = ?, follower_count = ?,
           follower_tier = ?, content_niche = ?, collaboration_type = ?, partnership_intent = ?,
           status = 'pending', referral_code = COALESCE(referral_code, ?),
           applied_at = CURRENT_TIMESTAMP, admin_notes = NULL
       WHERE id = ?`,
      [socialPlatform, socialHandle, profileUrl || null, followerCount, followerTier, contentNiche, collaborationType, partnershipIntent || null, createReferralCode(), existing[0].id]
    );
  } else {
    const config = await getProgramConfig();
    await pool.query(
      `INSERT INTO affiliate_partners
       (user_id, social_platform, social_handle, profile_url, follower_count, follower_tier,
        content_niche, collaboration_type, partnership_intent, status, referral_code,
        discount_percent, commission_share_percent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      [
        userId,
        socialPlatform,
        socialHandle,
        profileUrl || null,
        followerCount,
        followerTier,
        contentNiche,
        collaborationType,
        partnershipIntent || null,
        createReferralCode(),
        config.default_customer_discount_percent,
        config.default_commission_share_percent,
      ]
    );
  }

  if (preferredProducts || contentFormats || monthlyReachEstimate || sampleContentUrl || whatsappContact) {
    await pool.query(
      `UPDATE affiliate_partners
       SET preferred_products = COALESCE(?, preferred_products),
           content_formats = COALESCE(?, content_formats),
           monthly_reach_estimate = COALESCE(?, monthly_reach_estimate),
           sample_content_url = COALESCE(?, sample_content_url),
           whatsapp_contact = COALESCE(?, whatsapp_contact)
       WHERE user_id = ?`,
      [
        preferredProducts ? String(preferredProducts).trim().slice(0, 500) : null,
        contentFormats ? String(contentFormats).trim().slice(0, 255) : null,
        monthlyReachEstimate ? String(monthlyReachEstimate).trim().slice(0, 64) : null,
        sampleContentUrl ? String(sampleContentUrl).trim().slice(0, 500) : null,
        whatsappContact ? String(whatsappContact).trim().slice(0, 40) : null,
        userId,
      ]
    ).catch(() => {});
  }

  const [[partner]] = await pool.query('SELECT * FROM affiliate_partners WHERE user_id = ?', [userId]);
  return { partner, alreadyApplied: false };
};

const getPartnerByUserId = async userId => {
  const [[partner]] = await pool.query('SELECT * FROM affiliate_partners WHERE user_id = ? LIMIT 1', [userId]);
  return partner || null;
};

const getPartnerByCode = async (code, connection = pool) => {
  const [[partner]] = await connection.query(
    `SELECT id, user_id, referral_code, discount_percent, commission_share_percent,
            promo_usage_limit, promo_per_user_limit, status
     FROM affiliate_partners
     WHERE referral_code = ? AND status = 'approved'
     LIMIT 1${connection === pool ? '' : ' FOR UPDATE'}`,
    [String(code || '').trim().toUpperCase()]
  );
  return partner || null;
};

const createAdminPartner = async ({
  email,
  socialPlatform,
  socialHandle,
  profileUrl,
  followerCount,
  discountPercent,
  commissionSharePercent,
  adminId,
}) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [[user]] = await connection.query(
      `SELECT id, name, email, role, is_active
       FROM users
       WHERE LOWER(email) = LOWER(?)
       LIMIT 1
       FOR UPDATE`,
      [email]
    );
    if (!user || user.role !== 'customer' || Number(user.is_active) !== 1) {
      const error = new Error('An active customer account with this email is required.');
      error.status = 404;
      throw error;
    }

    const [[existing]] = await connection.query(
      'SELECT id FROM affiliate_partners WHERE user_id = ? LIMIT 1 FOR UPDATE',
      [user.id]
    );
    if (existing) {
      const error = new Error('This customer already has a promoter record. Find it in the list and update it there.');
      error.status = 409;
      throw error;
    }

    await connection.query(
      `INSERT INTO affiliate_partners
       (user_id, social_platform, social_handle, profile_url, follower_count, status,
        referral_code, discount_percent, commission_share_percent, reviewed_by, approved_at)
       VALUES (?, ?, ?, ?, ?, 'approved', ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [
        user.id,
        socialPlatform,
        socialHandle,
        profileUrl || null,
        followerCount,
        createReferralCode(),
        discountPercent,
        commissionSharePercent,
        adminId,
      ]
    );
    const [[partner]] = await connection.query(
      `SELECT p.*, u.name AS user_name, u.email AS user_email
       FROM affiliate_partners p
       JOIN users u ON u.id = p.user_id
       WHERE p.user_id = ?`,
      [user.id]
    );
    await connection.commit();
    return partner;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
};

const updatePartner = async (id, {
  status,
  discountPercent,
  commissionSharePercent,
  referralCode,
  promoUsageLimit,
  promoPerUserLimit,
  adminNotes,
  adminId,
}) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [[partner]] = await connection.query('SELECT * FROM affiliate_partners WHERE id = ? FOR UPDATE', [id]);
    if (!partner) {
      const error = new Error('Promoter application not found.');
      error.status = 404;
      throw error;
    }
    const nextStatus = status || partner.status;
    const nextDiscountPercent = discountPercent ?? Number(partner.discount_percent);
    const nextCommissionSharePercent = commissionSharePercent ?? Number(partner.commission_share_percent);
    const nextPromoUsageLimit = promoUsageLimit === undefined ? partner.promo_usage_limit : promoUsageLimit;
    const nextPromoPerUserLimit = promoPerUserLimit === undefined ? partner.promo_per_user_limit : promoPerUserLimit;
    const requestedCode = typeof referralCode === 'string' ? referralCode.trim().toUpperCase() : '';
    const nextCode = nextStatus === 'approved'
      ? requestedCode || partner.referral_code || createReferralCode()
      : requestedCode || partner.referral_code;
    const nextAdminNotes = adminNotes === undefined ? partner.admin_notes : (adminNotes.trim() || null);
    await connection.query(
      `UPDATE affiliate_partners
       SET status = ?, discount_percent = ?, commission_share_percent = ?,
           referral_code = ?, promo_usage_limit = ?, promo_per_user_limit = ?,
           admin_notes = ?, reviewed_by = COALESCE(?, reviewed_by),
           approved_at = CASE WHEN ? = 'approved' THEN COALESCE(approved_at, CURRENT_TIMESTAMP) ELSE approved_at END
       WHERE id = ?`,
      [
        nextStatus,
        nextDiscountPercent,
        nextCommissionSharePercent,
        nextCode,
        nextPromoUsageLimit,
        nextPromoPerUserLimit,
        nextAdminNotes,
        status === undefined ? null : adminId,
        nextStatus,
        id,
      ]
    );
    await connection.commit();
    const [[updated]] = await pool.query('SELECT * FROM affiliate_partners WHERE id = ?', [id]);
    return updated;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
};

const bulkUpdatePartners = async ({
  partnerIds,
  status,
  discountPercent,
  commissionSharePercent,
  adminNotes,
  adminId,
}) => {
  const ids = Array.from(new Set((Array.isArray(partnerIds) ? partnerIds : []).map(Number).filter(id => Number.isSafeInteger(id) && id > 0)));
  if (!ids.length) {
    const error = new Error('Select at least one promoter record to update.');
    error.status = 400;
    throw error;
  }
  const results = [];
  for (const id of ids) {
    const updated = await updatePartner(id, {
      ...(status ? { status } : {}),
      ...(discountPercent !== undefined && discountPercent !== null && discountPercent !== '' ? { discountPercent: Number(discountPercent) } : {}),
      ...(commissionSharePercent !== undefined && commissionSharePercent !== null && commissionSharePercent !== '' ? { commissionSharePercent: Number(commissionSharePercent) } : {}),
      ...(adminNotes !== undefined ? { adminNotes } : {}),
      adminId,
    });
    results.push(updated);
  }
  return { updatedCount: results.length, partners: results };
};

const listPartners = async () => {
  const [partners] = await pool.query(
    `SELECT p.*, u.name AS user_name, u.email AS user_email,
       COALESCE(SUM(CASE WHEN c.status = 'pending' THEN 1 ELSE 0 END), 0) AS pending_orders,
       COALESCE(SUM(CASE WHEN c.status IN ('approved', 'paid') THEN 1 ELSE 0 END), 0) AS delivered_orders,
       COALESCE(SUM(CASE WHEN c.status = 'approved' THEN c.commission_amount ELSE 0 END), 0) AS payable_amount,
       0 AS balance_carryover,
       COALESCE((SELECT SUM(a.amount) FROM affiliate_payouts a WHERE a.partner_id = p.id), 0) AS paid_amount,
       (SELECT COUNT(*) FROM orders o WHERE o.affiliate_partner_id = p.id) AS promo_used_count
     FROM affiliate_partners p
     JOIN users u ON u.id = p.user_id
     LEFT JOIN affiliate_commissions c ON c.partner_id = p.id
     GROUP BY p.id
     ORDER BY (p.status = 'pending') DESC, p.created_at DESC`
  );
  return partners;
};

const listCampaignBriefs = async ({ activeOnly = false } = {}) => {
  try {
    const whereClause = activeOnly ? 'WHERE is_active = 1' : '';
    const [rows] = await pool.query(
      `SELECT * FROM affiliate_campaign_briefs ${whereClause} ORDER BY is_active DESC, id ASC`
    );
    if (Array.isArray(rows) && rows.length > 0) return rows;
  } catch {
    // Table may not exist yet or mock pool in unit tests; fall back to defaults
  }
  return activeOnly
    ? DEFAULT_CAMPAIGN_BRIEFS.filter(brief => Number(brief.is_active) === 1)
    : [...DEFAULT_CAMPAIGN_BRIEFS];
};

const saveCampaignBrief = async brief => {
  const slug = String(brief.slug || brief.title || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || `campaign-${Date.now()}`;
  const title = String(brief.title || '').trim().slice(0, 180);
  const productName = String(brief.product_name || brief.productName || '').trim().slice(0, 160);
  const productSlug = String(brief.product_slug || brief.productSlug || '').trim().slice(0, 160) || null;
  const category = String(brief.category || 'Skincare').trim().slice(0, 60);
  const hookAngle = String(brief.hook_angle || brief.hookAngle || '').trim().slice(0, 300);
  const keyTalkingPoints = String(brief.key_talking_points || brief.keyTalkingPoints || '').trim().slice(0, 2000);
  const disclosureRules = String(
    brief.disclosure_rules || brief.disclosureRules ||
    'Use #ad, #BhumiveraPartner, or #gifted clearly. Avoid medical or guaranteed-result claims.'
  ).trim().slice(0, 400);
  const recommendedFormats = String(
    brief.recommended_formats || brief.recommendedFormats ||
    'Instagram Reels, YouTube Shorts, Routine Walkthrough'
  ).trim().slice(0, 160);
  const isActive = brief.is_active === undefined ? 1 : (Number(brief.is_active) ? 1 : 0);

  if (!title || !productName || !hookAngle || !keyTalkingPoints) {
    const error = new Error('Enter a campaign title, product name, creator hook angle, and key talking points.');
    error.status = 400;
    throw error;
  }

  if (brief.id) {
    await pool.query(
      `UPDATE affiliate_campaign_briefs
       SET slug = ?, title = ?, product_name = ?, product_slug = ?, category = ?,
           hook_angle = ?, key_talking_points = ?, disclosure_rules = ?,
           recommended_formats = ?, is_active = ?
       WHERE id = ?`,
      [slug, title, productName, productSlug, category, hookAngle, keyTalkingPoints, disclosureRules, recommendedFormats, isActive, Number(brief.id)]
    );
  } else {
    await pool.query(
      `INSERT INTO affiliate_campaign_briefs
       (slug, title, product_name, product_slug, category, hook_angle, key_talking_points, disclosure_rules, recommended_formats, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         title = VALUES(title), product_name = VALUES(product_name), product_slug = VALUES(product_slug),
         category = VALUES(category), hook_angle = VALUES(hook_angle), key_talking_points = VALUES(key_talking_points),
         disclosure_rules = VALUES(disclosure_rules), recommended_formats = VALUES(recommended_formats), is_active = VALUES(is_active)`,
      [slug, title, productName, productSlug, category, hookAngle, keyTalkingPoints, disclosureRules, recommendedFormats, isActive]
    );
  }
  return listCampaignBriefs({ activeOnly: false });
};

const deleteCampaignBrief = async id => {
  await pool.query('DELETE FROM affiliate_campaign_briefs WHERE id = ?', [Number(id)]);
  return listCampaignBriefs({ activeOnly: false });
};

const getPublicPromotionsShowcase = async () => {
  const programConfig = await getProgramConfig().catch(() => defaultProgramConfig);
  const campaignBriefs = await listCampaignBriefs({ activeOnly: true });
  return {
    programConfig,
    milestones: CREATOR_MILESTONES.map(m => ({
      ordersRequired: m.orders,
      rewardInr: m.rewardInr,
      label: m.label,
      shareBoost: m.shareBoost,
      tierBadge: m.tierBadge,
    })),
    campaignBriefs,
    onboardingSteps: [
      {
        step: '01',
        title: 'Register at bhumivera.com/promotions',
        window: '2 minutes',
        detail: 'Sign in or create a verified Bhumivera account, share your social profile and long-term partnership intent, and reserve your creator code.',
      },
      {
        step: '02',
        title: '12–24h Human Team Verification',
        window: '12–24 hours',
        detail: 'Our curation team reviews your content voice, audience alignment, and botanical education fit—with no fixed follower minimum.',
      },
      {
        step: '03',
        title: 'Campaign Brief & Code Activation',
        window: 'Instant on approval',
        detail: 'Receive your active audience discount code, contribution profit-share rate, product campaign brief, and open-book earnings ledger.',
      },
    ],
  };
};

const getPartnerDashboard = async (userId, { commissionPage = 1, commissionPageSize = 20 } = {}) => {
  const partner = await getPartnerByUserId(userId);
  if (!partner) return null;
  const [[promoUsage]] = await pool.query(
    'SELECT COUNT(*) AS creator_promo_uses FROM orders WHERE affiliate_partner_id = ?',
    [partner.id]
  );
  partner.promo_used_count = Number(promoUsage?.creator_promo_uses) || 0;
  const [[summary]] = await pool.query(
    `SELECT COUNT(c.id) AS attributed_orders,
       COALESCE(SUM(CASE WHEN c.status IN ('approved', 'paid') THEN 1 ELSE 0 END), 0) AS delivered_orders,
       COALESCE(SUM(CASE WHEN c.status = 'pending' THEN c.commission_amount ELSE 0 END), 0) AS pending_commission,
       COALESCE(SUM(CASE WHEN c.status = 'approved' THEN c.commission_amount ELSE 0 END), 0) AS payable_commission,
       COALESCE(SUM(CASE WHEN c.status = 'reversed' THEN c.commission_amount ELSE 0 END), 0) AS reversed_commission,
       COUNT(ic.id) AS funded_impact_contributions,
       COALESCE(SUM(ic.amount), 0) AS impact_amount,
       (SELECT COALESCE(SUM(amount), 0) FROM affiliate_payouts WHERE partner_id = ?) AS paid_commission
     FROM affiliate_commissions c
     LEFT JOIN impact_contributions ic
       ON ic.order_id = c.order_id AND ic.status = 'collected'
     WHERE c.partner_id = ?`,
    [partner.id, partner.id]
  );
  summary.balance_carryover = 0;
  const [[commissionCount]] = await pool.query(
    'SELECT COUNT(*) AS total FROM affiliate_commissions WHERE partner_id = ?',
    [partner.id]
  );
  const commissionTotal = Number(commissionCount.total) || 0;
  const commissionPages = Math.max(1, Math.ceil(commissionTotal / commissionPageSize));
  const page = Math.min(commissionPage, commissionPages);
  const [commissions] = await pool.query(
    `SELECT c.id, c.order_id, c.order_subtotal, c.discount_amount, c.revenue_ex_tax,
            c.product_cost, c.fulfillment_cost, c.rto_reserve, c.payment_fee,
            c.contribution_profit, c.commission_share_percent, c.commission_amount,
            c.retained_profit, c.retained_margin_percent, c.status, c.created_at,
            c.paid_at, c.reversed_at
     FROM affiliate_commissions c
     WHERE c.partner_id = ?
     ORDER BY c.created_at DESC
     LIMIT ? OFFSET ?`,
    [partner.id, commissionPageSize, (page - 1) * commissionPageSize]
  );
  return {
    partner,
    summary,
    commissions,
    commissionPagination: {
      page,
      pageSize: commissionPageSize,
      total: commissionTotal,
      pages: commissionPages,
    },
    programConfig: await getProgramConfig(),
  };
};

const listCommissions = async () => {
  const [rows] = await pool.query(
    `SELECT c.*, p.referral_code, u.name AS promoter_name, u.email AS promoter_email
     FROM affiliate_commissions c
     JOIN affiliate_partners p ON p.id = c.partner_id
     JOIN users u ON u.id = p.user_id
     ORDER BY (c.status = 'approved') DESC, c.created_at DESC
     LIMIT 500`
  );
  return rows;
};

const listPayouts = async () => {
  const [rows] = await pool.query(
    `SELECT a.*, p.referral_code, u.name AS promoter_name, u.email AS promoter_email,
            admin.name AS paid_by_name
     FROM affiliate_payouts a
     JOIN affiliate_partners p ON p.id = a.partner_id
     JOIN users u ON u.id = p.user_id
     LEFT JOIN users admin ON admin.id = a.paid_by
     ORDER BY a.paid_at DESC
     LIMIT 500`
  );
  return rows;
};

const getPeriodFilter = (column, period) => {
  const thresholds = {
    '7d': 'DATE_SUB(NOW(), INTERVAL 7 DAY)',
    '30d': 'DATE_SUB(NOW(), INTERVAL 30 DAY)',
    '90d': 'DATE_SUB(NOW(), INTERVAL 90 DAY)',
    month: "DATE_FORMAT(NOW(), '%Y-%m-01')",
  };
  return thresholds[period] ? ` AND ${column} >= ${thresholds[period]}` : '';
};

const getAdminPromoterAnalytics = async (period = '30d') => {
  const commissionPeriod = getPeriodFilter('c.created_at', period);
  const payoutPeriod = getPeriodFilter('a.paid_at', period);
  const [[summary]] = await pool.query(
    `SELECT COUNT(DISTINCT c.order_id) AS attributed_orders,
       COUNT(DISTINCT o.user_id) AS referred_customers,
       COALESCE(SUM(c.order_subtotal), 0) AS gross_merchandise_sales,
       COALESCE(SUM(c.discount_amount), 0) AS discounts,
       COALESCE(SUM(GREATEST(0, c.order_subtotal - c.discount_amount)), 0) AS discounted_merchandise_sales,
       COALESCE(SUM(c.revenue_ex_tax), 0) AS revenue_ex_tax,
       COALESCE(SUM(CASE WHEN c.status = 'pending' THEN c.commission_amount ELSE 0 END), 0) AS pending_commission,
       COALESCE(SUM(CASE WHEN c.status = 'approved' THEN c.commission_amount ELSE 0 END), 0) AS approved_commission,
       COALESCE(SUM(CASE WHEN c.status = 'reversed' THEN c.commission_amount ELSE 0 END), 0) AS reversed_commission,
       COALESCE(SUM(CASE WHEN c.status <> 'reversed' THEN c.commission_amount ELSE 0 END), 0) AS commission_generated,
       CASE WHEN SUM(GREATEST(0, c.order_subtotal - c.discount_amount)) > 0
         THEN SUM(CASE WHEN c.status <> 'reversed' THEN c.commission_amount ELSE 0 END) /
           SUM(GREATEST(0, c.order_subtotal - c.discount_amount)) * 100 ELSE 0 END AS commission_percent_of_sales,
       COALESCE(SUM(c.retained_profit), 0) AS retained_profit,
       COALESCE(AVG(c.retained_margin_percent), 0) AS average_retained_margin
     FROM affiliate_commissions c
     JOIN orders o ON o.id = c.order_id
     WHERE 1 = 1${commissionPeriod}`
  );
  const [partners] = await pool.query(
    `SELECT p.id, p.user_id, p.social_platform, p.social_handle, p.profile_url, p.follower_count,
       p.follower_tier, p.content_niche, p.collaboration_type, p.partnership_intent,
       p.status, p.referral_code, p.discount_percent, p.commission_share_percent, p.applied_at,
       u.name AS user_name, u.email AS user_email,
       COALESCE(s.attributed_orders, 0) AS attributed_orders,
       COALESCE(s.referred_customers, 0) AS referred_customers,
       COALESCE(s.gross_merchandise_sales, 0) AS gross_merchandise_sales,
       COALESCE(s.discounted_merchandise_sales, 0) AS discounted_merchandise_sales,
       COALESCE(s.revenue_ex_tax, 0) AS revenue_ex_tax,
       COALESCE(s.pending_commission, 0) AS pending_commission,
       COALESCE(s.approved_commission, 0) AS approved_commission,
       COALESCE(s.reversed_commission, 0) AS reversed_commission,
       COALESCE(s.commission_generated, 0) AS commission_generated,
       COALESCE(s.commission_percent_of_sales, 0) AS commission_percent_of_sales,
       COALESCE(s.retained_profit, 0) AS retained_profit,
       COALESCE(s.average_retained_margin, 0) AS average_retained_margin,
       COALESCE(b.approved_balance, 0) AS payable_amount,
       0 AS balance_carryover,
       COALESCE(b.paid_amount, 0) AS lifetime_paid_amount
     FROM affiliate_partners p
     JOIN users u ON u.id = p.user_id
     LEFT JOIN (
       SELECT c.partner_id, COUNT(DISTINCT c.order_id) AS attributed_orders,
         COUNT(DISTINCT o.user_id) AS referred_customers,
         SUM(c.order_subtotal) AS gross_merchandise_sales,
         SUM(GREATEST(0, c.order_subtotal - c.discount_amount)) AS discounted_merchandise_sales,
         SUM(c.revenue_ex_tax) AS revenue_ex_tax,
         SUM(CASE WHEN c.status = 'pending' THEN c.commission_amount ELSE 0 END) AS pending_commission,
         SUM(CASE WHEN c.status = 'approved' THEN c.commission_amount ELSE 0 END) AS approved_commission,
         SUM(CASE WHEN c.status = 'reversed' THEN c.commission_amount ELSE 0 END) AS reversed_commission,
         SUM(CASE WHEN c.status <> 'reversed' THEN c.commission_amount ELSE 0 END) AS commission_generated,
         CASE WHEN SUM(GREATEST(0, c.order_subtotal - c.discount_amount)) > 0
           THEN SUM(CASE WHEN c.status <> 'reversed' THEN c.commission_amount ELSE 0 END) /
             SUM(GREATEST(0, c.order_subtotal - c.discount_amount)) * 100 ELSE 0 END AS commission_percent_of_sales,
         SUM(c.retained_profit) AS retained_profit,
         AVG(c.retained_margin_percent) AS average_retained_margin
       FROM affiliate_commissions c
       JOIN orders o ON o.id = c.order_id
       WHERE 1 = 1${commissionPeriod}
       GROUP BY c.partner_id
     ) s ON s.partner_id = p.id
     LEFT JOIN (
       SELECT c.partner_id,
         SUM(CASE WHEN c.status = 'approved' THEN c.commission_amount ELSE 0 END) AS approved_balance,
         COALESCE(paid.total_paid, 0) AS paid_amount
       FROM affiliate_commissions c
       LEFT JOIN (
         SELECT partner_id, SUM(amount) AS total_paid
         FROM affiliate_payouts
         GROUP BY partner_id
       ) paid ON paid.partner_id = c.partner_id
       GROUP BY c.partner_id, paid.total_paid
     ) b ON b.partner_id = p.id
     ORDER BY (p.status = 'pending') DESC, discounted_merchandise_sales DESC, p.created_at DESC`
  );
  const [[payoutSummary]] = await pool.query(
    `SELECT COUNT(*) AS payout_count, COALESCE(SUM(a.amount), 0) AS amount_paid
     FROM affiliate_payouts a
     WHERE 1 = 1${payoutPeriod}`
  );
  const [weeklyPayouts] = await pool.query(
    `SELECT YEARWEEK(a.paid_at, 3) AS period_key,
       DATE_FORMAT(MIN(a.paid_at), '%x-W%v') AS period_label,
       COUNT(*) AS payout_count, SUM(a.amount) AS amount_paid
     FROM affiliate_payouts a
     WHERE a.paid_at >= DATE_SUB(CURDATE(), INTERVAL 11 WEEK)
     GROUP BY YEARWEEK(a.paid_at, 3)
     ORDER BY period_key DESC`
  );
  const [monthlyPayouts] = await pool.query(
    `SELECT DATE_FORMAT(a.paid_at, '%Y-%m') AS period_label,
       COUNT(*) AS payout_count, SUM(a.amount) AS amount_paid
     FROM affiliate_payouts a
     WHERE a.paid_at >= DATE_SUB(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 11 MONTH)
     GROUP BY DATE_FORMAT(a.paid_at, '%Y-%m')
     ORDER BY period_label DESC`
  );
  const [weeklyEarnings] = await pool.query(
    `SELECT YEARWEEK(c.created_at, 3) AS period_key,
       DATE_FORMAT(MIN(c.created_at), '%x-W%v') AS period_label,
       COUNT(DISTINCT c.order_id) AS order_count,
       SUM(CASE WHEN c.status = 'pending' THEN c.commission_amount ELSE 0 END) AS pending_amount,
       SUM(CASE WHEN c.status = 'approved' THEN c.commission_amount ELSE 0 END) AS payable_amount,
       SUM(CASE WHEN c.status = 'paid' THEN c.commission_amount ELSE 0 END) AS paid_amount,
       SUM(CASE WHEN c.status = 'reversed' THEN c.commission_amount ELSE 0 END) AS reversed_amount
     FROM affiliate_commissions c
     WHERE c.created_at >= DATE_SUB(CURDATE(), INTERVAL 11 WEEK)
     GROUP BY YEARWEEK(c.created_at, 3)
     ORDER BY period_key DESC`
  );
  const [monthlyEarnings] = await pool.query(
    `SELECT DATE_FORMAT(c.created_at, '%Y-%m') AS period_label,
       COUNT(DISTINCT c.order_id) AS order_count,
       SUM(CASE WHEN c.status = 'pending' THEN c.commission_amount ELSE 0 END) AS pending_amount,
       SUM(CASE WHEN c.status = 'approved' THEN c.commission_amount ELSE 0 END) AS payable_amount,
       SUM(CASE WHEN c.status = 'paid' THEN c.commission_amount ELSE 0 END) AS paid_amount,
       SUM(CASE WHEN c.status = 'reversed' THEN c.commission_amount ELSE 0 END) AS reversed_amount
     FROM affiliate_commissions c
     WHERE c.created_at >= DATE_SUB(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 11 MONTH)
     GROUP BY DATE_FORMAT(c.created_at, '%Y-%m')
     ORDER BY period_label DESC`
  );
  const [[outstanding]] = await pool.query(
    `SELECT COALESCE(SUM(commission_amount), 0) AS net_outstanding
     FROM affiliate_commissions
     WHERE status = 'approved'`
  );

  return {
    period,
    summary: {
      ...summary,
      payable_commission: Math.max(0, Number(outstanding.net_outstanding) || 0),
      payout_count: Number(payoutSummary.payout_count) || 0,
      amount_paid: Number(payoutSummary.amount_paid) || 0,
    },
    partners,
    weeklyPayouts,
    monthlyPayouts,
    weeklyEarnings,
    monthlyEarnings,
  };
};

const getPartnerPerformance = async ({
  partnerId,
  period = '30d',
  orderPage = 1,
  customerPage = 1,
  limit = 20,
  search = '',
}) => {
  const [[partner]] = await pool.query(
    `SELECT p.*, u.name AS user_name, u.email AS user_email
     FROM affiliate_partners p
     JOIN users u ON u.id = p.user_id
     WHERE p.id = ?
     LIMIT 1`,
    [partnerId]
  );
  if (!partner) return null;

  const commissionPeriod = getPeriodFilter('c.created_at', period);
  const searchTerm = String(search || '').trim();
  const customerSearch = searchTerm ? ' AND (u.name LIKE ? OR u.email LIKE ?)' : '';
  const customerParams = [partnerId];
  if (searchTerm) customerParams.push(`%${searchTerm}%`, `%${searchTerm}%`);

  const [[summary]] = await pool.query(
    `SELECT COUNT(DISTINCT c.order_id) AS attributed_orders,
       COUNT(DISTINCT o.user_id) AS referred_customers,
       COALESCE(SUM(c.order_subtotal), 0) AS gross_merchandise_sales,
       COALESCE(SUM(c.discount_amount), 0) AS discounts,
       COALESCE(SUM(GREATEST(0, c.order_subtotal - c.discount_amount)), 0) AS discounted_merchandise_sales,
       COALESCE(SUM(c.revenue_ex_tax), 0) AS revenue_ex_tax,
       COALESCE(SUM(CASE WHEN c.status = 'pending' THEN c.commission_amount ELSE 0 END), 0) AS pending_commission,
       COALESCE(SUM(CASE WHEN c.status = 'approved' THEN c.commission_amount ELSE 0 END), 0) AS approved_commission,
       COALESCE(SUM(CASE WHEN c.status = 'reversed' THEN c.commission_amount ELSE 0 END), 0) AS reversed_commission,
       COALESCE(SUM(CASE WHEN c.status <> 'reversed' THEN c.commission_amount ELSE 0 END), 0) AS commission_generated,
       CASE WHEN SUM(GREATEST(0, c.order_subtotal - c.discount_amount)) > 0
         THEN SUM(CASE WHEN c.status <> 'reversed' THEN c.commission_amount ELSE 0 END) /
           SUM(GREATEST(0, c.order_subtotal - c.discount_amount)) * 100 ELSE 0 END AS commission_percent_of_sales,
       COALESCE(SUM(c.retained_profit), 0) AS retained_profit,
       COALESCE(AVG(c.retained_margin_percent), 0) AS average_retained_margin
     FROM affiliate_commissions c
     JOIN orders o ON o.id = c.order_id
     WHERE c.partner_id = ?${commissionPeriod}`,
    [partnerId]
  );
  const [[customerCount]] = await pool.query(
    `SELECT COUNT(DISTINCT o.user_id) AS total
     FROM affiliate_commissions c
     JOIN orders o ON o.id = c.order_id
     JOIN users u ON u.id = o.user_id
     WHERE c.partner_id = ?${commissionPeriod}${customerSearch}`,
    customerParams
  );
  const [customers] = await pool.query(
    `SELECT u.id AS customer_id, u.name AS customer_name, u.email AS customer_email,
       COUNT(DISTINCT c.order_id) AS order_count,
       SUM(GREATEST(0, c.order_subtotal - c.discount_amount)) AS discounted_merchandise_sales,
       SUM(c.revenue_ex_tax) AS revenue_ex_tax,
       SUM(CASE WHEN c.status <> 'reversed' THEN c.commission_amount ELSE 0 END) AS attributed_commission,
       CASE WHEN SUM(GREATEST(0, c.order_subtotal - c.discount_amount)) > 0
         THEN SUM(CASE WHEN c.status <> 'reversed' THEN c.commission_amount ELSE 0 END) /
           SUM(GREATEST(0, c.order_subtotal - c.discount_amount)) * 100 ELSE 0 END AS commission_percent_of_sales,
       MAX(o.created_at) AS last_order_at
     FROM affiliate_commissions c
     JOIN orders o ON o.id = c.order_id
     JOIN users u ON u.id = o.user_id
     WHERE c.partner_id = ?${commissionPeriod}${customerSearch}
     GROUP BY u.id
     ORDER BY last_order_at DESC
     LIMIT ? OFFSET ?`,
    [...customerParams, limit, (customerPage - 1) * limit]
  );

  const orderSearch = searchTerm
    ? ' AND (u.name LIKE ? OR u.email LIKE ? OR CAST(c.order_id AS CHAR) LIKE ?)'
    : '';
  const orderParams = [partnerId];
  if (searchTerm) orderParams.push(`%${searchTerm}%`, `%${searchTerm}%`, `%${searchTerm}%`);
  const [[orderCount]] = await pool.query(
    `SELECT COUNT(*) AS total
     FROM affiliate_commissions c
     JOIN orders o ON o.id = c.order_id
     JOIN users u ON u.id = o.user_id
     WHERE c.partner_id = ?${commissionPeriod}${orderSearch}`,
    orderParams
  );
  const [orders] = await pool.query(
    `SELECT c.id AS commission_id, c.order_id, c.referral_code, c.order_subtotal,
       c.discount_amount, c.revenue_ex_tax, c.product_cost, c.fulfillment_cost,
       c.rto_reserve, c.payment_fee, c.contribution_profit, c.commission_share_percent,
       c.commission_amount, c.retained_profit, c.retained_margin_percent,
       CASE WHEN GREATEST(0, c.order_subtotal - c.discount_amount) > 0
         THEN c.commission_amount / GREATEST(0, c.order_subtotal - c.discount_amount) * 100 ELSE 0 END AS commission_percent_of_sales,
       c.status AS commission_status, c.created_at AS attributed_at,
       o.user_id AS customer_id, o.status AS order_status, o.payment_mode,
       o.total AS customer_total, o.created_at AS order_created_at,
       u.name AS customer_name, u.email AS customer_email,
       (SELECT GROUP_CONCAT(CONCAT(oi.name, ' x ', oi.quantity) ORDER BY oi.id SEPARATOR ', ')
        FROM order_items oi WHERE oi.order_id = o.id) AS item_summary,
       ap.amount AS payout_amount, ap.reference AS payout_reference, ap.paid_at
     FROM affiliate_commissions c
     JOIN orders o ON o.id = c.order_id
     JOIN users u ON u.id = o.user_id
     LEFT JOIN affiliate_payouts ap ON ap.commission_id = c.id
     WHERE c.partner_id = ?${commissionPeriod}${orderSearch}
     ORDER BY o.created_at DESC, o.id DESC
     LIMIT ? OFFSET ?`,
    [...orderParams, limit, (orderPage - 1) * limit]
  );

  return {
    partner,
    period,
    summary,
    customers,
    customerCount: Number(customerCount.total) || 0,
    orders,
    orderCount: Number(orderCount.total) || 0,
    orderPage,
    customerPage,
    limit,
  };
};

const payCommission = async ({ commissionId, reference, adminId }) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [[commission]] = await connection.query(
      'SELECT * FROM affiliate_commissions WHERE id = ? FOR UPDATE',
      [commissionId]
    );
    if (!commission) {
      const error = new Error('Commission record not found.');
      error.status = 404;
      throw error;
    }
    if (commission.status !== 'approved') {
      const error = new Error('Only an approved, unpaid commission can be paid.');
      error.status = 409;
      throw error;
    }
    const [[balance]] = await connection.query(
      `SELECT COALESCE(SUM(commission_amount), 0) AS available_balance
       FROM affiliate_commissions
       WHERE partner_id = ? AND status = 'approved'`,
      [commission.partner_id]
    );
    if (Number(balance.available_balance) + 0.001 < Number(commission.commission_amount)) {
      const error = new Error('A previous returned order created a payout balance to offset. Wait until enough new approved commission is available.');
      error.status = 409;
      throw error;
    }
    await connection.query(
      `INSERT INTO affiliate_payouts (partner_id, commission_id, amount, reference, paid_by)
       VALUES (?, ?, ?, ?, ?)`,
      [commission.partner_id, commission.id, commission.commission_amount, reference, adminId]
    );
    await connection.query(
      `UPDATE affiliate_commissions
       SET status = 'paid', paid_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status = 'approved'`,
      [commissionId]
    );
    await connection.commit();
    return { commissionId, amount: Number(commission.commission_amount), reference };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
};

const bulkPayCommissions = async ({ commissionIds, reference, adminId }) => {
  const ids = Array.from(new Set((Array.isArray(commissionIds) ? commissionIds : []).map(Number).filter(id => Number.isSafeInteger(id) && id > 0)));
  if (!ids.length) {
    const error = new Error('Select at least one approved commission to settle.');
    error.status = 400;
    throw error;
  }
  const payouts = [];
  let totalPaid = 0;
  for (const commissionId of ids) {
    const result = await payCommission({ commissionId, reference, adminId });
    payouts.push(result);
    totalPaid = Math.round((totalPaid + Number(result.amount || 0)) * 100) / 100;
  }
  return { paidCount: payouts.length, totalPaid, reference, payouts };
};

const syncCommissionOrderStatus = async (orderId, orderStatus, connection = pool) => {
  if (orderStatus === 'delivered') {
    await connection.query(
      `UPDATE affiliate_commissions
       SET status = 'approved'
       WHERE order_id = ? AND status = 'pending'`,
      [orderId]
    );
    const [[comm]] = await connection.query(
      'SELECT partner_id FROM affiliate_commissions WHERE order_id = ? LIMIT 1',
      [orderId]
    ).catch(() => [[]]);
    if (comm?.partner_id) {
      const [[partner]] = await connection.query(
        'SELECT * FROM affiliate_partners WHERE id = ? FOR UPDATE',
        [comm.partner_id]
      ).catch(() => [[]]);
      const [[counts]] = await connection.query(
        `SELECT COUNT(*) AS delivered_count
         FROM affiliate_commissions
         WHERE partner_id = ? AND status IN ('approved', 'paid')`,
        [comm.partner_id]
      ).catch(() => [[{ delivered_count: 0 }]]);
      const delivered = Number(counts?.delivered_count) || 0;
      if (partner) {
        for (const m of CREATOR_MILESTONES) {
          if (delivered >= m.orders && !partner[m.key]) {
            await connection.query(
              `UPDATE affiliate_partners
               SET ${m.key} = CURRENT_TIMESTAMP,
                   commission_share_percent = CASE WHEN ? IS NOT NULL AND commission_share_percent < ? THEN ? ELSE commission_share_percent END
               WHERE id = ?`,
              [m.shareBoost, m.shareBoost || 0, m.shareBoost || 0, partner.id]
            );
            await creditCreatorReferralWallet(connection, {
              userId: partner.user_id,
              amount: m.rewardInr,
              description: `Creator Milestone Unlocked (${m.orders} Delivered Orders): ${m.label}`,
              referenceId: `creator-milestone-${partner.id}-${m.orders}`,
            });
          }
        }
      }
    }
  } else if (['cancelled', 'returned'].includes(orderStatus)) {
    await connection.query(
      `UPDATE affiliate_commissions
       SET status = 'reversed', reversed_at = CURRENT_TIMESTAMP
       WHERE order_id = ? AND status IN ('pending', 'approved', 'paid')`,
      [orderId]
    );
  }
};

const submitPartnerReelAndCode = async (userId, { customCode }) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [[partner]] = await connection.query(
      'SELECT * FROM affiliate_partners WHERE user_id = ? FOR UPDATE',
      [userId]
    );
    if (!partner) {
      const error = new Error('Promoter account not found.');
      error.status = 404;
      throw error;
    }
    if (partner.status !== 'approved') {
      const error = new Error('Your creator account must be approved before changing its promo code.');
      error.status = 403;
      throw error;
    }
    const nextCode = customCode
      ? String(customCode).trim().toUpperCase()
      : partner.referral_code;
    await connection.query(
      'UPDATE affiliate_partners SET referral_code = ? WHERE id = ?',
      [nextCode, partner.id]
    );
    await connection.commit();
    return getPartnerDashboard(userId);
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
};

const updatePartnerCreatorProfile = async (userId, {
  preferredProducts,
  contentFormats,
  monthlyReachEstimate,
  sampleContentUrl,
  payoutUpiId,
  whatsappContact,
  acknowledgeBrief,
}) => {
  const partner = await getPartnerByUserId(userId);
  if (!partner) {
    const error = new Error('Promoter account not found.');
    error.status = 404;
    throw error;
  }
  await pool.query(
    `UPDATE affiliate_partners
     SET preferred_products = COALESCE(?, preferred_products),
         content_formats = COALESCE(?, content_formats),
         monthly_reach_estimate = COALESCE(?, monthly_reach_estimate),
         sample_content_url = COALESCE(?, sample_content_url),
         payout_upi_id = COALESCE(?, payout_upi_id),
         whatsapp_contact = COALESCE(?, whatsapp_contact),
         campaign_brief_ack_at = CASE WHEN ? = 1 THEN COALESCE(campaign_brief_ack_at, CURRENT_TIMESTAMP) ELSE campaign_brief_ack_at END
     WHERE id = ?`,
    [
      preferredProducts !== undefined ? (String(preferredProducts).trim().slice(0, 500) || null) : null,
      contentFormats !== undefined ? (String(contentFormats).trim().slice(0, 255) || null) : null,
      monthlyReachEstimate !== undefined ? (String(monthlyReachEstimate).trim().slice(0, 64) || null) : null,
      sampleContentUrl !== undefined ? (String(sampleContentUrl).trim().slice(0, 500) || null) : null,
      payoutUpiId !== undefined ? (String(payoutUpiId).trim().slice(0, 120) || null) : null,
      whatsappContact !== undefined ? (String(whatsappContact).trim().slice(0, 40) || null) : null,
      acknowledgeBrief ? 1 : 0,
      partner.id,
    ]
  ).catch(() => {});
  return getPartnerDashboard(userId);
};

module.exports = {
  defaultProgramConfig,
  getProgramConfig,
  saveProgramConfig,
  applyForPartner,
  createAdminPartner,
  getPartnerByUserId,
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
  syncCommissionOrderStatus,
  submitPartnerReelAndCode,
  updatePartnerCreatorProfile,
  listCampaignBriefs,
  saveCampaignBrief,
  deleteCampaignBrief,
  getPublicPromotionsShowcase,
  CREATOR_MILESTONES,
  DEFAULT_CAMPAIGN_BRIEFS,
};
