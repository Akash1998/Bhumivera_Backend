const pool = require('../config/db');

let tablePromise;
const DEFAULT_TIERS = [
  ['Bronze', 0, 'Starter rewards'],
  ['Silver', 500, 'Free delivery and enhanced points'],
  ['Gold', 1000, 'Order discount, loyalty cashback points, and free delivery'],
  ['Platinum', 5000, 'Premium order discount, cashback points, and free delivery'],
];
const DEFAULT_LOYALTY_CONFIG = {
  enabled: 1,
  points_per_rupee: 0.1,
  redemption_points_per_rupee: 10,
  max_redemption_percent: 45,
  minimum_redemption_points: 100,
};

const createLoyaltyTierTable = async () => {
  if (!tablePromise) tablePromise = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS loyalty_tiers (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(80) NOT NULL UNIQUE,
        min_points INT UNSIGNED NOT NULL DEFAULT 0,
        benefits TEXT DEFAULT NULL,
        points_multiplier DECIMAL(6,2) NOT NULL DEFAULT 1.00,
        tier_discount_percent DECIMAL(5,2) NOT NULL DEFAULT 0.00,
        cashback_percent DECIMAL(5,2) NOT NULL DEFAULT 0.00,
        free_shipping TINYINT(1) NOT NULL DEFAULT 0,
        bonus_points INT UNSIGNED NOT NULL DEFAULT 0,
        color VARCHAR(30) DEFAULT NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_loyalty_tier_points (min_points)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    for (const [column, definition] of [
      ['points_multiplier', 'DECIMAL(6,2) NOT NULL DEFAULT 1.00'],
      ['tier_discount_percent', 'DECIMAL(5,2) NOT NULL DEFAULT 0.00'],
      ['cashback_percent', 'DECIMAL(5,2) NOT NULL DEFAULT 0.00'],
      ['free_shipping', 'TINYINT(1) NOT NULL DEFAULT 0'],
      ['bonus_points', 'INT UNSIGNED NOT NULL DEFAULT 0'],
    ]) {
      const [columns] = await pool.query('SHOW COLUMNS FROM loyalty_tiers LIKE ?', [column]);
      if (!columns.length) await pool.query(`ALTER TABLE loyalty_tiers ADD COLUMN ${column} ${definition}`);
    }
    for (const [name, minPoints, benefits] of DEFAULT_TIERS) {
      await pool.query('INSERT IGNORE INTO loyalty_tiers (name, min_points, benefits) VALUES (?, ?, ?)', [name, minPoints, benefits]);
    }
  })().catch(error => { tablePromise = null; throw error; });
  return tablePromise;
};

const listLoyaltyTiers = async ({ activeOnly = false, connection = pool } = {}) => {
  await createLoyaltyTierTable();
  const [rows] = await connection.query(`SELECT * FROM loyalty_tiers ${activeOnly ? 'WHERE is_active = 1' : ''} ORDER BY min_points ASC, id ASC`);
  return Array.isArray(rows) ? rows : [];
};

const getLoyaltyTierForPoints = (points, tiers = []) => {
  const eligibleTiers = (Array.isArray(tiers) ? tiers : [])
    .filter(tier => Number(tier.min_points) <= Math.max(0, Number(points) || 0))
    .sort((first, second) => Number(first.min_points) - Number(second.min_points) || Number(first.id) - Number(second.id));
  return eligibleTiers[eligibleTiers.length - 1] || null;
};

const getLoyaltyConfig = async (connection = pool) => {
  const [rows] = await connection.query(
    `SELECT key_name, value FROM settings
     WHERE key_name IN ('loyalty_program_enabled', 'loyalty_points_per_rupee',
       'loyalty_redemption_points_per_rupee', 'loyalty_max_redemption_percent',
       'loyalty_minimum_redemption_points')`
  );
  const values = Object.fromEntries(rows.map(row => [row.key_name, row.value]));
  return {
    enabled: values.loyalty_program_enabled === undefined ? DEFAULT_LOYALTY_CONFIG.enabled : Number(values.loyalty_program_enabled) === 1 ? 1 : 0,
    points_per_rupee: Math.max(0, Math.min(100, Number(values.loyalty_points_per_rupee ?? DEFAULT_LOYALTY_CONFIG.points_per_rupee) || 0)),
    redemption_points_per_rupee: Math.max(1, Math.min(100000, Number(values.loyalty_redemption_points_per_rupee ?? DEFAULT_LOYALTY_CONFIG.redemption_points_per_rupee) || DEFAULT_LOYALTY_CONFIG.redemption_points_per_rupee)),
    max_redemption_percent: Math.max(0, Math.min(100, Number(values.loyalty_max_redemption_percent ?? DEFAULT_LOYALTY_CONFIG.max_redemption_percent) || 0)),
    minimum_redemption_points: Math.max(0, Math.trunc(Number(values.loyalty_minimum_redemption_points ?? DEFAULT_LOYALTY_CONFIG.minimum_redemption_points) || 0)),
  };
};

const saveLoyaltyConfig = async config => {
  const values = {
    loyalty_program_enabled: config.enabled ? '1' : '0',
    loyalty_points_per_rupee: String(Number(config.points_per_rupee)),
    loyalty_redemption_points_per_rupee: String(Number(config.redemption_points_per_rupee)),
    loyalty_max_redemption_percent: String(Number(config.max_redemption_percent)),
    loyalty_minimum_redemption_points: String(Math.trunc(Number(config.minimum_redemption_points))),
  };
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    for (const [key, value] of Object.entries(values)) {
      await connection.query(
        `INSERT INTO settings (key_name, value, group_name) VALUES (?, ?, 'loyalty')
         ON DUPLICATE KEY UPDATE value = VALUES(value), group_name = 'loyalty'`,
        [key, value]
      );
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  return getLoyaltyConfig();
};

const getUserLoyaltyTier = async (userId, connection = pool) => {
  await createLoyaltyTierTable();
  const [[user]] = await connection.query('SELECT loyalty_lifetime_points FROM users WHERE id = ?', [userId]);
  const tiers = await listLoyaltyTiers({ activeOnly: true, connection });
  return getLoyaltyTierForPoints(user?.loyalty_lifetime_points, tiers);
};

const createLoyaltyTier = async data => {
  await createLoyaltyTierTable();
  const [result] = await pool.query(
    `INSERT INTO loyalty_tiers
      (name, min_points, benefits, points_multiplier, tier_discount_percent, cashback_percent, free_shipping, bonus_points, color, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [String(data.name).trim(), Math.max(0, Math.trunc(Number(data.min_points) || 0)), data.benefits || null,
      Number(data.points_multiplier) || 1, Number(data.tier_discount_percent) || 0,
      Number(data.cashback_percent) || 0, data.free_shipping ? 1 : 0,
      Math.max(0, Math.trunc(Number(data.bonus_points) || 0)), data.color || null,
      data.is_active === false || data.is_active === 0 ? 0 : 1]
  );
  const [rows] = await pool.query('SELECT * FROM loyalty_tiers WHERE id = ?', [result.insertId]);
  return rows[0] || null;
};

const updateLoyaltyTier = async (id, data) => {
  await createLoyaltyTierTable();
  const allowed = ['name', 'min_points', 'benefits', 'points_multiplier', 'tier_discount_percent', 'cashback_percent', 'free_shipping', 'bonus_points', 'color', 'is_active'];
  const entries = Object.entries(data).filter(([key]) => allowed.includes(key));
  if (entries.length) {
    const fields = entries.map(([key]) => `${key} = ?`).join(', ');
    const values = entries.map(([key, value]) => {
      if (key === 'min_points' || key === 'bonus_points') return Math.max(0, Math.trunc(Number(value) || 0));
      if (key === 'points_multiplier' || key === 'tier_discount_percent' || key === 'cashback_percent') return Math.max(0, Number(value) || 0);
      if (key === 'free_shipping' || key === 'is_active') return value === true || value === 1 || value === '1' ? 1 : 0;
      return value;
    });
    await pool.query(`UPDATE loyalty_tiers SET ${fields} WHERE id = ?`, [...values, id]);
  }
  const [rows] = await pool.query('SELECT * FROM loyalty_tiers WHERE id = ?', [id]);
  return rows[0] || null;
};

const deleteLoyaltyTier = async id => {
  await createLoyaltyTierTable();
  const [result] = await pool.query('DELETE FROM loyalty_tiers WHERE id = ?', [id]);
  return result.affectedRows > 0;
};

module.exports = {
  DEFAULT_LOYALTY_CONFIG,
  createLoyaltyTierTable,
  listLoyaltyTiers,
  getLoyaltyConfig,
  saveLoyaltyConfig,
  getUserLoyaltyTier,
  getLoyaltyTierForPoints,
  createLoyaltyTier,
  updateLoyaltyTier,
  deleteLoyaltyTier,
};
