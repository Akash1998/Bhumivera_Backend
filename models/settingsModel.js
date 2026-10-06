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
    ['standard_charge', '50', 'shipping'],
    ['express_charge', '150', 'shipping'],
    ['coupon_stack_policy', 'rule_first', 'cart_rules'],
    ['cart_rules_schema_version', '1', 'cart_rules'],
    ['enforce_cart_rule_minimum', '0', 'cart_rules'],
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
  const gamificationHooks = [
    'exit_intent_coupon', 'social_viewers', 'first_order_badge', 'third_order_gift',
    'birthday_coupon', 'spin_after_purchase', 'refer_earn', 'buy_three_save',
    'navbar_tier_bar', 'coupon_scarcity', 'login_streak', 'price_match_badge',
    'category_buyers', 'wishlist_price_drop', 'review_scratch_card', 'platinum_early_access',
    'referral_leaderboard', 'complete_look', 'low_stock_badge', 'recently_viewed',
    'free_delivery_nudge', 'seasonal_countdown', 'cart_hold_timer', 'abandoned_cart_email',
    'social_proof_cart', 'personalized_upsell', 'savings_summary', 'delivery_slot_urgency',
    'vip_ribbon', 'wallet_express', 'post_purchase_bump', 'coupon_auto_apply',
  ];
  for (const hook of gamificationHooks) {
    defaults.push([`gamification_${hook}_enabled`, '0', 'gamification']);
    defaults.push([`gamification_${hook}_threshold`, '0', 'gamification']);
  }
  defaults.push(
    ['lifecycle_third_order_enabled', '0', 'lifecycle'],
    ['lifecycle_third_order_gift_product_id', '', 'lifecycle'],
    ['lifecycle_winback_enabled', '0', 'lifecycle'],
    ['lifecycle_winback_days', '7', 'lifecycle'],
    ['lifecycle_churn_days', '90', 'lifecycle'],
    ['lifecycle_birthday_enabled', '0', 'lifecycle'],
    ['lifecycle_birthday_coupon_code', '', 'lifecycle'],
    ['loyalty_points_per_rupee', '10', 'loyalty'],
    ['personalization_related_weight', '50', 'personalization'],
    ['personalization_popular_weight', '30', 'personalization'],
    ['personalization_recent_weight', '20', 'personalization'],
    ['personalization_welcome_name_enabled', '1', 'personalization'],
    ['personalization_recently_viewed_limit', '8', 'personalization'],
    ['experiment_registry', '[]', 'experiments'],
  );
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
