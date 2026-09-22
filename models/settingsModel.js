// backend/models/settingsMode
const pool = require('../config/db');

const createSettingsTable = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      id INT AUTO_INCREMENT PRIMARY KEY,
      key_name VARCHAR(100) NOT NULL UNIQUE,
      value TEXT DEFAULT NULL,
      group_name VARCHAR(50) DEFAULT 'general',
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);
  // Seed default settings if not exist
  const defaults = [
    ['store_name', 'Bhumivera', 'general'],
    ['store_email', '', 'general'],
    ['store_phone', '', 'general'],
    ['store_address', '', 'general'],
    ['store_currency', 'INR', 'general'],
    ['store_currency_symbol', '₹', 'general'],
    ['store_logo', '', 'general'],
    ['store_favicon', '', 'general'],
    ['meta_title', 'Bhumivera - Electronics Store', 'seo'],
    ['meta_description', 'Best electronics at best prices', 'seo'],
    ['meta_keywords', 'electronics, gadgets, Bhumivera', 'seo'],
    ['free_shipping_threshold', '500', 'shipping'],
    ['default_shipping_charge', '50', 'shipping'],
    ['tax_rate', '0', 'tax'],
    ['order_prefix', 'ANR', 'orders'],
    ['return_policy_days', '7', 'policy'],
    ['refund_policy', 'Refunds processed within 7 business days.', 'policy'],
    ['privacy_policy', '', 'policy'],
    ['terms_conditions', '', 'policy'],
    ['maintenance_mode', '0', 'system'],
    ['social_facebook', '', 'social'],
    ['social_instagram', '', 'social'],
    ['social_twitter', '', 'social'],
    ['social_youtube', '', 'social'],
    ['smtp_host', '', 'email'],
    ['smtp_port', '587', 'email'],
    ['smtp_user', '', 'email'],
    ['smtp_pass', '', 'email'],
    ['smtp_from_name', 'Bhumivera', 'email'],
  ];
  for (const [key_name, value, group_name] of defaults) {
    await pool.query(
      'INSERT IGNORE INTO settings (key_name, value, group_name) VALUES (?, ?, ?)',
      [key_name, value, group_name]
    );
  }
};

const getAllSettings = async () => {
  const [rows] = await pool.query('SELECT * FROM settings ORDER BY group_name, key_name');
  // Convert to object map
  const map = {};
  rows.forEach(r => { map[r.key_name] = r.value; });
  return { map, rows };
};

const getSettingsByGroup = async (group) => {
  const [rows] = await pool.query('SELECT key_name, value FROM settings WHERE group_name = ?', [group]);
  const map = {};
  rows.forEach(r => { map[r.key_name] = r.value; });
  return map;
};

const getSetting = async (key) => {
  const [rows] = await pool.query('SELECT value FROM settings WHERE key_name = ?', [key]);
  return rows[0] ? rows[0].value : null;
};

const updateSetting = async (key, value) => {
  await pool.query(
    'INSERT INTO settings (key_name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)',
    [key, value]
  );
};

const bulkUpdateSettings = async (data) => {
  for (const [key, value] of Object.entries(data)) {
    await updateSetting(key, value);
  }
};

module.exports = { createSettingsTable, getAllSettings, getSettingsByGroup, getSetting, updateSetting, bulkUpdateSettings };
