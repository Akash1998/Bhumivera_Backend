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
      return { partner: existing[0], alreadyApplied: true };
    }
    await pool.query(
      `UPDATE affiliate_partners
       SET social_platform = ?, social_handle = ?, profile_url = ?, follower_count = ?,
           status = 'pending', applied_at = CURRENT_TIMESTAMP, admin_notes = NULL
       WHERE id = ?`,
      [socialPlatform, socialHandle, profileUrl || null, followerCount, existing[0].id]
    );
  } else {
    const config = await getProgramConfig();
    await pool.query(
      `INSERT INTO affiliate_partners
       (user_id, social_platform, social_handle, profile_url, follower_count, status,
        discount_percent, commission_share_percent)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      [
        userId,
        socialPlatform,
        socialHandle,
        profileUrl || null,
        followerCount,
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

const createReferralCode = () => `BV${crypto.randomBytes(5).toString('hex').toUpperCase()}`;

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
       GREATEST(0, COALESCE(SUM(CASE WHEN c.status = 'approved' THEN c.commission_amount ELSE 0 END), 0) -
         COALESCE((SELECT SUM(a.amount) FROM affiliate_payouts a WHERE a.partner_id = p.id), 0)) AS payable_amount,
       GREATEST(0, COALESCE((SELECT SUM(a.amount) FROM affiliate_payouts a WHERE a.partner_id = p.id), 0) -
         COALESCE(SUM(CASE WHEN c.status = 'approved' THEN c.commission_amount ELSE 0 END), 0)) AS balance_carryover,
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
  const netPayable = Number(summary.payable_commission) - Number(summary.paid_commission);
  summary.balance_carryover = Math.max(0, -netPayable);
  summary.payable_commission = Math.max(0, netPayable);
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
      `SELECT
         COALESCE((SELECT SUM(commission_amount) FROM affiliate_commissions WHERE partner_id = ? AND status = 'approved'), 0) -
         COALESCE((SELECT SUM(amount) FROM affiliate_payouts WHERE partner_id = ?), 0) AS available_balance`,
      [commission.partner_id, commission.partner_id]
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
  getPartnerByUserId,
  getPartnerByCode,
  updatePartner,
  listPartners,
  getPartnerDashboard,
  listCommissions,
  listPayouts,
  payCommission,
  syncCommissionOrderStatus,
};
