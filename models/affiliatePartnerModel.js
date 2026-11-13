const crypto = require('node:crypto');
const pool = require('../config/db');

const defaultProgramConfig = Object.freeze({
  default_customer_discount_percent: 15,
  default_commission_share_percent: 25,
  fulfillment_cost: 220,
  rto_reserve: 100,
  online_payment_fee_percent: 2,
  minimum_retained_margin_percent: 12,
  target_retained_margin_percent: 20,
  minimum_order_amount: 599,
});

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

const applyForPartner = async ({ userId, socialPlatform, socialHandle, profileUrl, followerCount }) => {
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
           status = 'pending', referral_code = COALESCE(referral_code, ?),
           applied_at = CURRENT_TIMESTAMP, admin_notes = NULL
       WHERE id = ?`,
      [socialPlatform, socialHandle, profileUrl || null, followerCount, createReferralCode(), existing[0].id]
    );
  } else {
    const config = await getProgramConfig();
    await pool.query(
      `INSERT INTO affiliate_partners
       (user_id, social_platform, social_handle, profile_url, follower_count, status, referral_code,
        discount_percent, commission_share_percent)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      [
        userId,
        socialPlatform,
        socialHandle,
        profileUrl || null,
        followerCount,
        createReferralCode(),
        config.default_customer_discount_percent,
        config.default_commission_share_percent,
      ]
    );
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
    `SELECT id, user_id, referral_code, discount_percent, commission_share_percent, status
     FROM affiliate_partners
     WHERE referral_code = ? AND status = 'approved'
     LIMIT 1`,
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

const updatePartner = async (id, { status, discountPercent, commissionSharePercent, referralCode, adminNotes, adminId }) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [[partner]] = await connection.query('SELECT * FROM affiliate_partners WHERE id = ? FOR UPDATE', [id]);
    if (!partner) {
      const error = new Error('Promoter application not found.');
      error.status = 404;
      throw error;
    }
    const nextCode = status === 'approved'
      ? String(referralCode || partner.referral_code || createReferralCode()).trim().toUpperCase()
      : partner.referral_code;
    await connection.query(
      `UPDATE affiliate_partners
       SET status = ?, discount_percent = ?, commission_share_percent = ?,
           referral_code = ?, admin_notes = ?, reviewed_by = ?,
           approved_at = CASE WHEN ? = 'approved' THEN COALESCE(approved_at, CURRENT_TIMESTAMP) ELSE approved_at END
       WHERE id = ?`,
      [status, discountPercent, commissionSharePercent, nextCode, adminNotes || null, adminId, status, id]
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

const listPartners = async () => {
  const [partners] = await pool.query(
    `SELECT p.*, u.name AS user_name, u.email AS user_email,
       COALESCE(SUM(CASE WHEN c.status = 'pending' THEN 1 ELSE 0 END), 0) AS pending_orders,
       COALESCE(SUM(CASE WHEN c.status = 'approved' THEN c.commission_amount ELSE 0 END), 0) AS payable_amount,
       0 AS balance_carryover,
       COALESCE((SELECT SUM(a.amount) FROM affiliate_payouts a WHERE a.partner_id = p.id), 0) AS paid_amount
     FROM affiliate_partners p
     JOIN users u ON u.id = p.user_id
     LEFT JOIN affiliate_commissions c ON c.partner_id = p.id
     GROUP BY p.id
     ORDER BY (p.status = 'pending') DESC, p.created_at DESC`
  );
  return partners;
};

const getPartnerDashboard = async userId => {
  const partner = await getPartnerByUserId(userId);
  if (!partner) return null;
  const [[summary]] = await pool.query(
    `SELECT COUNT(*) AS attributed_orders,
       COALESCE(SUM(CASE WHEN status = 'pending' THEN commission_amount ELSE 0 END), 0) AS pending_commission,
       COALESCE(SUM(CASE WHEN status = 'approved' THEN commission_amount ELSE 0 END), 0) AS payable_commission,
       COALESCE(SUM(CASE WHEN status = 'reversed' THEN commission_amount ELSE 0 END), 0) AS reversed_commission,
       (SELECT COALESCE(SUM(amount), 0) FROM affiliate_payouts WHERE partner_id = ?) AS paid_commission
     FROM affiliate_commissions WHERE partner_id = ?`,
    [partner.id, partner.id]
  );
  summary.balance_carryover = 0;
  const [commissions] = await pool.query(
    `SELECT c.id, c.order_id, c.order_subtotal, c.commission_amount, c.retained_margin_percent,
            c.status, c.created_at, c.paid_at, c.reversed_at
     FROM affiliate_commissions c
     WHERE c.partner_id = ?
     ORDER BY c.created_at DESC
     LIMIT 50`,
    [partner.id]
  );
  return { partner, summary, commissions, programConfig: await getProgramConfig() };
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

const syncCommissionOrderStatus = async (orderId, orderStatus, connection = pool) => {
  if (orderStatus === 'delivered') {
    await connection.query(
      `UPDATE affiliate_commissions
       SET status = 'approved'
       WHERE order_id = ? AND status = 'pending'`,
      [orderId]
    );
  } else if (['cancelled', 'returned'].includes(orderStatus)) {
    await connection.query(
      `UPDATE affiliate_commissions
       SET status = 'reversed', reversed_at = CURRENT_TIMESTAMP
       WHERE order_id = ? AND status IN ('pending', 'approved', 'paid')`,
      [orderId]
    );
  }
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
  listPartners,
  getPartnerDashboard,
  listCommissions,
  listPayouts,
  getAdminPromoterAnalytics,
  getPartnerPerformance,
  payCommission,
  syncCommissionOrderStatus,
};
