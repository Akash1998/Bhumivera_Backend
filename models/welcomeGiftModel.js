const crypto = require('crypto');
const pool = require('../config/db');
const { createCouponTable } = require('./couponModel');

const MAX_CARDS_PER_CAMPAIGN = 1000;
const CODE_PATTERN = /^WC-[A-Z0-9]{10}$/;

const fail = (message, status = 400, code) => Object.assign(new Error(message), { status, code });

let tablesReady;
const ensureTables = () => {
  if (!tablesReady) {
    tablesReady = (async () => {
      await createCouponTable();
      await pool.query(`
        CREATE TABLE IF NOT EXISTS welcome_gift_campaigns (
          id INT AUTO_INCREMENT PRIMARY KEY,
          label VARCHAR(120) NOT NULL,
          total_value DECIMAL(10,2) NOT NULL,
          per_order_value DECIMAL(10,2) NOT NULL,
          min_order_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
          validity_days INT NOT NULL DEFAULT 365,
          card_count INT NOT NULL DEFAULT 0,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS welcome_gift_cards (
          id INT AUTO_INCREMENT PRIMARY KEY,
          campaign_id INT NOT NULL,
          code VARCHAR(20) NOT NULL UNIQUE,
          status ENUM('unclaimed','claimed','void') NOT NULL DEFAULT 'unclaimed',
          claimed_by_user_id INT DEFAULT NULL,
          claimed_at DATETIME DEFAULT NULL,
          coupon_code VARCHAR(50) DEFAULT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_welcome_gift_cards_campaign (campaign_id, status),
          INDEX idx_welcome_gift_cards_user (claimed_by_user_id),
          FOREIGN KEY (campaign_id) REFERENCES welcome_gift_campaigns(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
    })().catch(error => {
      tablesReady = null;
      throw error;
    });
  }
  return tablesReady;
};

const money = value => Math.round(Number(value) * 100) / 100;

const normalizeTerms = ({ totalValue, perOrderValue, minOrderAmount, validityDays }) => {
  const total = money(totalValue);
  const perOrder = money(perOrderValue);
  const minimum = money(minOrderAmount ?? 0);
  const validity = Number(validityDays ?? 365);
  if (!Number.isFinite(total) || total <= 0 || total > 100000) throw fail('Gift value must be between ₹1 and ₹100000.');
  if (!Number.isFinite(perOrder) || perOrder <= 0 || perOrder > total) throw fail('Per-order value must be greater than 0 and not above the total gift value.');
  if (!Number.isFinite(minimum) || minimum < 0) throw fail('Minimum order amount cannot be negative.');
  if (!Number.isInteger(validity) || validity < 1 || validity > 3650) throw fail('Validity must be between 1 and 3650 days.');
  return { total, perOrder, minimum, validity };
};

const generateCode = () => `WC-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;

const createCampaign = async ({ label, count, totalValue = 200, perOrderValue = 100, minOrderAmount = 0, validityDays = 365 }) => {
  await ensureTables();
  const cardCount = Number(count);
  if (!Number.isInteger(cardCount) || cardCount < 1 || cardCount > MAX_CARDS_PER_CAMPAIGN) {
    throw fail(`Card quantity must be between 1 and ${MAX_CARDS_PER_CAMPAIGN}.`);
  }
  const cleanLabel = String(label || '').trim().slice(0, 120) || 'Welcome card gift';
  const terms = normalizeTerms({ totalValue, perOrderValue, minOrderAmount, validityDays });

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [campaign] = await connection.query(
      `INSERT INTO welcome_gift_campaigns
         (label, total_value, per_order_value, min_order_amount, validity_days, card_count)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [cleanLabel, terms.total, terms.perOrder, terms.minimum, terms.validity, cardCount]
    );
    const codes = new Set();
    while (codes.size < cardCount) codes.add(generateCode());
    const rows = [...codes].map(code => [campaign.insertId, code]);
    for (let offset = 0; offset < rows.length; offset += 500) {
      await connection.query(
        'INSERT INTO welcome_gift_cards (campaign_id, code) VALUES ?',
        [rows.slice(offset, offset + 500)]
      );
    }
    await connection.commit();
    return {
      id: campaign.insertId,
      label: cleanLabel,
      totalValue: terms.total,
      perOrderValue: terms.perOrder,
      minOrderAmount: terms.minimum,
      validityDays: terms.validity,
      cardCount,
      codes: [...codes],
    };
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
};

const listCampaigns = async () => {
  await ensureTables();
  const [rows] = await pool.query(`
    SELECT c.id, c.label, c.total_value, c.per_order_value, c.min_order_amount, c.validity_days,
           c.card_count, c.created_at,
           SUM(g.status = 'claimed') AS claimed_count,
           SUM(g.status = 'void') AS void_count
    FROM welcome_gift_campaigns c
    LEFT JOIN welcome_gift_cards g ON g.campaign_id = c.id
    GROUP BY c.id
    ORDER BY c.created_at DESC, c.id DESC
  `);
  return rows.map(row => ({
    ...row,
    claimed_count: Number(row.claimed_count || 0),
    void_count: Number(row.void_count || 0),
  }));
};

const getCampaign = async campaignId => {
  await ensureTables();
  const [campaigns] = await pool.query('SELECT * FROM welcome_gift_campaigns WHERE id = ?', [campaignId]);
  if (!campaigns.length) return null;
  const [cards] = await pool.query(
    `SELECT g.id, g.code, g.status, g.claimed_at, g.coupon_code, u.name AS claimed_by_name, u.email AS claimed_by_email
     FROM welcome_gift_cards g
     LEFT JOIN users u ON u.id = g.claimed_by_user_id
     WHERE g.campaign_id = ?
     ORDER BY g.id`,
    [campaignId]
  );
  return { ...campaigns[0], cards };
};

const updateCampaignTerms = async (campaignId, { minOrderAmount, label }) => {
  await ensureTables();
  const [existing] = await pool.query('SELECT * FROM welcome_gift_campaigns WHERE id = ?', [campaignId]);
  if (!existing.length) throw fail('Campaign not found.', 404);
  const current = existing[0];
  const minimum = minOrderAmount === undefined || minOrderAmount === '' ? Number(current.min_order_amount) : money(minOrderAmount);
  if (!Number.isFinite(minimum) || minimum < 0) throw fail('Minimum order amount cannot be negative.');
  const cleanLabel = label === undefined ? current.label : (String(label).trim().slice(0, 120) || current.label);

  await pool.query(
    'UPDATE welcome_gift_campaigns SET min_order_amount = ?, label = ? WHERE id = ?',
    [minimum, cleanLabel, campaignId]
  );
  // Already-issued coupons follow the new minimum so admin changes apply to every unused gift.
  await pool.query(
    `UPDATE coupons
     SET min_order_value = ?, min_order_amount = ?, minimum_order_amount = ?
     WHERE campaign_tag = ? AND used_count < COALESCE(usage_limit, used_count + 1)`,
    [minimum, minimum, minimum, `welcome_gift:${campaignId}`]
  );
  return { id: Number(campaignId), minOrderAmount: minimum, label: cleanLabel };
};

const voidCard = async cardId => {
  await ensureTables();
  const [result] = await pool.query(
    "UPDATE welcome_gift_cards SET status = 'void' WHERE id = ? AND status = 'unclaimed'",
    [cardId]
  );
  if (!result.affectedRows) throw fail('Only unclaimed cards can be voided.', 409);
  return { id: Number(cardId), status: 'void' };
};

const publicTerms = campaign => ({
  totalValue: Number(campaign.total_value),
  perOrderValue: Number(campaign.per_order_value),
  minOrderAmount: Number(campaign.min_order_amount),
  validityDays: Number(campaign.validity_days),
  uses: Math.ceil(Number(campaign.total_value) / Number(campaign.per_order_value)),
});

const normalizeCode = raw => String(raw || '').trim().toUpperCase();

const getCardStatus = async (rawCode, userId = null) => {
  await ensureTables();
  const code = normalizeCode(rawCode);
  if (!CODE_PATTERN.test(code)) return { valid: false, code: 'INVALID_GIFT_CODE', message: 'This welcome card code is not valid.' };

  const [rows] = await pool.query(
    `SELECT g.status, g.claimed_by_user_id, g.coupon_code, c.*
     FROM welcome_gift_cards g
     JOIN welcome_gift_campaigns c ON c.id = g.campaign_id
     WHERE g.code = ?`,
    [code]
  );
  if (!rows.length) return { valid: false, code: 'INVALID_GIFT_CODE', message: 'This welcome card code is not valid.' };

  const row = rows[0];
  const terms = publicTerms(row);
  if (row.status === 'void') {
    return { valid: false, code: 'GIFT_VOID', terms, message: 'This welcome card has been cancelled.' };
  }
  if (row.status === 'claimed') {
    const mine = userId && Number(row.claimed_by_user_id) === Number(userId);
    return {
      valid: true,
      canClaim: false,
      alreadyClaimed: true,
      claimedByYou: Boolean(mine),
      couponCode: mine ? row.coupon_code : undefined,
      terms,
      message: mine
        ? 'You have already claimed this gift. Use your coupon code at checkout.'
        : 'This welcome card has already been claimed.',
    };
  }
  return { valid: true, canClaim: true, alreadyClaimed: false, terms, message: 'This welcome card is genuine and ready to claim.' };
};

const claimCard = async (rawCode, userId) => {
  await ensureTables();
  const code = normalizeCode(rawCode);
  if (!CODE_PATTERN.test(code)) throw fail('This welcome card code is not valid.', 400, 'INVALID_GIFT_CODE');

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [cards] = await connection.query(
      `SELECT g.id, g.status, g.claimed_by_user_id, g.coupon_code, g.campaign_id,
              c.total_value, c.per_order_value, c.min_order_amount, c.validity_days
       FROM welcome_gift_cards g
       JOIN welcome_gift_campaigns c ON c.id = g.campaign_id
       WHERE g.code = ? FOR UPDATE`,
      [code]
    );
    if (!cards.length) throw fail('This welcome card code is not valid.', 404, 'INVALID_GIFT_CODE');
    const card = cards[0];
    const terms = publicTerms(card);

    if (card.status === 'void') throw fail('This welcome card has been cancelled.', 409, 'GIFT_VOID');
    if (card.status === 'claimed') {
      if (Number(card.claimed_by_user_id) === Number(userId)) {
        await connection.commit();
        return { couponCode: card.coupon_code, terms, alreadyClaimed: true };
      }
      throw fail('This welcome card has already been claimed.', 409, 'GIFT_ALREADY_CLAIMED');
    }

    const [priorClaims] = await connection.query(
      "SELECT id FROM welcome_gift_cards WHERE claimed_by_user_id = ? AND status = 'claimed' LIMIT 1 FOR UPDATE",
      [userId]
    );
    if (priorClaims.length) {
      throw fail('A welcome card gift has already been claimed on your account.', 409, 'USER_ALREADY_CLAIMED');
    }

    let couponCode;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      couponCode = `WELCOME-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
      try {
        await connection.query(
          `INSERT INTO coupons
             (code, description, discount_type, discount_value, min_order_value, min_order_amount, minimum_order_amount,
              usage_limit, per_user_limit, used_count, is_active, status, restricted_user_id, campaign_tag,
              valid_from, expiry_date, expires_at)
           VALUES (?, ?, 'fixed', ?, ?, ?, ?, ?, ?, 0, 1, 'active', ?, ?, NOW(),
                   DATE_ADD(NOW(), INTERVAL ? DAY), DATE_ADD(NOW(), INTERVAL ? DAY))`,
          [
            couponCode,
            `Welcome card gift ${code}`,
            terms.perOrderValue,
            terms.minOrderAmount,
            terms.minOrderAmount,
            terms.minOrderAmount,
            terms.uses,
            terms.uses,
            userId,
            `welcome_gift:${card.campaign_id}`,
            terms.validityDays,
            terms.validityDays,
          ]
        );
        break;
      } catch (error) {
        if (error.code !== 'ER_DUP_ENTRY' || attempt === 4) throw error;
      }
    }

    await connection.query(
      "UPDATE welcome_gift_cards SET status = 'claimed', claimed_by_user_id = ?, claimed_at = NOW(), coupon_code = ? WHERE id = ?",
      [userId, couponCode, card.id]
    );
    await connection.commit();
    return { couponCode, terms, alreadyClaimed: false };
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
};

module.exports = {
  MAX_CARDS_PER_CAMPAIGN,
  createCampaign,
  listCampaigns,
  getCampaign,
  updateCampaignTerms,
  voidCard,
  getCardStatus,
  claimCard,
};
