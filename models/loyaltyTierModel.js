const pool = require('../config/db');

let tablePromise;
const DEFAULT_TIERS = [
  ['Bronze', 0, 'Starter rewards'],
  ['Silver', 500, 'Free delivery offers'],
  ['Gold', 1000, 'Early access and bonus points'],
  ['Platinum', 5000, 'Priority access and premium rewards'],
];

const createLoyaltyTierTable = async () => {
  if (!tablePromise) tablePromise = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS loyalty_tiers (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(80) NOT NULL UNIQUE,
        min_points INT UNSIGNED NOT NULL DEFAULT 0,
        benefits TEXT DEFAULT NULL,
        color VARCHAR(30) DEFAULT NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_loyalty_tier_points (min_points)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    for (const [name, minPoints, benefits] of DEFAULT_TIERS) {
      await pool.query('INSERT IGNORE INTO loyalty_tiers (name, min_points, benefits) VALUES (?, ?, ?)', [name, minPoints, benefits]);
    }
  })().catch(error => { tablePromise = null; throw error; });
  return tablePromise;
};

const listLoyaltyTiers = async ({ activeOnly = false } = {}) => {
  await createLoyaltyTierTable();
  const [rows] = await pool.query(`SELECT * FROM loyalty_tiers ${activeOnly ? 'WHERE is_active = 1' : ''} ORDER BY min_points ASC, id ASC`);
  return Array.isArray(rows) ? rows : [];
};

const getUserLoyaltyTier = async userId => {
  await createLoyaltyTierTable();
  const [[user]] = await pool.query('SELECT loyalty_points FROM users WHERE id = ?', [userId]);
  const points = Math.max(0, Number(user?.loyalty_points) || 0);
  const tiers = await listLoyaltyTiers({ activeOnly: true });
  return tiers.filter(tier => Number(tier.min_points) <= points).pop() || null;
};

const createLoyaltyTier = async data => {
  await createLoyaltyTierTable();
  const [result] = await pool.query(
    'INSERT INTO loyalty_tiers (name, min_points, benefits, color, is_active) VALUES (?, ?, ?, ?, ?)',
    [String(data.name).trim(), Math.max(0, Math.trunc(Number(data.min_points) || 0)), data.benefits || null, data.color || null, data.is_active === false ? 0 : 1]
  );
  const [rows] = await pool.query('SELECT * FROM loyalty_tiers WHERE id = ?', [result.insertId]);
  return rows[0] || null;
};

const updateLoyaltyTier = async (id, data) => {
  await createLoyaltyTierTable();
  const allowed = ['name', 'min_points', 'benefits', 'color', 'is_active'];
  const entries = Object.entries(data).filter(([key]) => allowed.includes(key));
  if (entries.length) {
    const fields = entries.map(([key]) => `${key} = ?`).join(', ');
    const values = entries.map(([key, value]) => key === 'min_points' ? Math.max(0, Math.trunc(Number(value) || 0)) : key === 'is_active' ? (value ? 1 : 0) : value);
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

module.exports = { createLoyaltyTierTable, listLoyaltyTiers, getUserLoyaltyTier, createLoyaltyTier, updateLoyaltyTier, deleteLoyaltyTier };
