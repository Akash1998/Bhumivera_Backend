const pool = require('../config/db');

let tablePromise;

const createCartRulesTable = async () => {
  if (!tablePromise) tablePromise = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cart_rules (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(120) NOT NULL,
        description VARCHAR(500) DEFAULT NULL,
        priority INT NOT NULL DEFAULT 0,
        min_cart_value DECIMAL(12,2) NOT NULL DEFAULT 0,
        max_cart_value DECIMAL(12,2) DEFAULT NULL,
        discount_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
        discount_percent DECIMAL(5,2) NOT NULL DEFAULT 0,
        free_shipping_enabled TINYINT(1) NOT NULL DEFAULT 0,
        gift_product_id INT DEFAULT NULL,
        gift_quantity INT NOT NULL DEFAULT 1,
        loyalty_bonus_points INT NOT NULL DEFAULT 0,
        auto_coupon_code VARCHAR(50) DEFAULT NULL,
        enforce_min_checkout TINYINT(1) NOT NULL DEFAULT 0,
        badge_text VARCHAR(255) DEFAULT NULL,
        start_time DATETIME DEFAULT NULL,
        end_time DATETIME DEFAULT NULL,
        status ENUM('active','inactive') NOT NULL DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_cart_rules_name (name),
        INDEX idx_cart_rules_active_priority (status, priority),
        CONSTRAINT fk_cart_rules_gift_product FOREIGN KEY (gift_product_id) REFERENCES products(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await pool.query(`
      INSERT IGNORE INTO cart_rules
        (name, description, priority, min_cart_value, free_shipping_enabled, gift_product_id, gift_quantity, loyalty_bonus_points, enforce_min_checkout, badge_text, status)
      VALUES
        ('Silver Tier', 'Free shipping and 100 loyalty points on qualifying carts.', 10, 799, 1, NULL, 1, 100, 0, 'Silver Tier', 'active')
    `);
  })().catch(error => {
    tablePromise = null;
    throw error;
  });
  return tablePromise;
};

const listCartRules = async ({ activeOnly = false } = {}) => {
  await createCartRulesTable();
  const [rows] = await pool.query(
    `SELECT cr.*, p.name AS gift_product_name, p.sku AS gift_product_sku, p.quantity AS gift_product_stock
     FROM cart_rules cr LEFT JOIN products p ON p.id = cr.gift_product_id
     ${activeOnly ? "WHERE cr.status = 'active'" : ''}
     ORDER BY cr.priority DESC, cr.id ASC`
  );
  return Array.isArray(rows) ? rows : [];
};

const getCartRuleById = async id => {
  await createCartRulesTable();
  const [rows] = await pool.query('SELECT * FROM cart_rules WHERE id = ?', [id]);
  return rows?.[0] || null;
};

const RULE_FIELDS = new Set([
  'name', 'description', 'priority', 'min_cart_value', 'max_cart_value',
  'discount_amount', 'discount_percent', 'free_shipping_enabled', 'gift_product_id',
  'gift_quantity', 'loyalty_bonus_points', 'auto_coupon_code', 'enforce_min_checkout',
  'badge_text', 'start_time', 'end_time', 'status',
]);

const createCartRule = async data => {
  await createCartRulesTable();
  const entries = Object.entries(data).filter(([key]) => RULE_FIELDS.has(key));
  if (!entries.some(([key]) => key === 'name')) throw new Error('Rule name is required.');
  const fields = entries.map(([key]) => key);
  const values = entries.map(([, value]) => value === '' ? null : value);
  const [result] = await pool.query(
    `INSERT INTO cart_rules (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`,
    values
  );
  return getCartRuleById(result.insertId);
};

const updateCartRule = async (id, data) => {
  await createCartRulesTable();
  const entries = Object.entries(data).filter(([key]) => RULE_FIELDS.has(key) && key !== 'id');
  if (!entries.length) return getCartRuleById(id);
  const fields = entries.map(([key]) => key);
  const values = entries.map(([, value]) => value === '' ? null : value);
  await pool.query(
    `UPDATE cart_rules SET ${fields.map(field => `${field} = ?`).join(', ')} WHERE id = ?`,
    [...values, id]
  );
  return getCartRuleById(id);
};

const deleteCartRule = async id => {
  await createCartRulesTable();
  const [result] = await pool.query('DELETE FROM cart_rules WHERE id = ?', [id]);
  return result.affectedRows > 0;
};

const toggleCartRule = async (id, status) => updateCartRule(id, { status });

module.exports = {
  createCartRulesTable,
  listCartRules,
  getCartRuleById,
  createCartRule,
  updateCartRule,
  deleteCartRule,
  toggleCartRule,
};
