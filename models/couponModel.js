//Coupon
const pool = require('../config/db');

const createCouponTable = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coupons (
      id INT AUTO_INCREMENT PRIMARY KEY,
      code VARCHAR(50) NOT NULL UNIQUE,
      discount_type ENUM('percentage','fixed') NOT NULL DEFAULT 'percentage',
      discount_value DECIMAL(10,2) NOT NULL,
      min_order_amount DECIMAL(10,2) DEFAULT 0,
      max_discount DECIMAL(10,2) DEFAULT NULL,
      usage_limit INT DEFAULT NULL,
      used_count INT DEFAULT 0,
      is_active TINYINT(1) DEFAULT 1,
      expires_at DATETIME DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
};

const createCoupon = async (data) => {
  const { code, discount_type, discount_value, min_order_amount, max_discount, usage_limit, expires_at } = data;
  const [result] = await pool.query(
    'INSERT INTO coupons (code, discount_type, discount_value, min_order_amount, max_discount, usage_limit, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [code.toUpperCase(), discount_type, discount_value, min_order_amount || 0, max_discount || null, usage_limit || null, expires_at || null]
  );
  return result.insertId;
};

const getCouponByCode = async (code) => {
  const [rows] = await pool.query('SELECT * FROM coupons WHERE code = ?', [code.toUpperCase()]);
  return rows[0];
};

const getAllCoupons = async () => {
  const [rows] = await pool.query('SELECT * FROM coupons ORDER BY created_at DESC');
  return rows;
};

const updateCoupon = async (id, data) => {
  const keys = Object.keys(data);
  if (keys.length === 0) return;
  const fields = keys.map(k => `${k} = ?`).join(', ');
  const values = [...Object.values(data), id];
  await pool.query(`UPDATE coupons SET ${fields} WHERE id = ?`, values);
};

const deleteCoupon = async (id) => {
  await pool.query('DELETE FROM coupons WHERE id = ?', [id]);
};

const incrementCouponUsage = async (code) => {
  await pool.query('UPDATE coupons SET used_count = used_count + 1 WHERE code = ?', [code.toUpperCase()]);
};

const validateCoupon = async (code, orderTotal) => {
  const coupon = await getCouponByCode(code);
  if (!coupon) return { valid: false, message: 'Invalid coupon code' };
  if (!coupon.is_active) return { valid: false, message: 'Coupon is not active' };
  if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) return { valid: false, message: 'Coupon has expired' };
  if (coupon.usage_limit && coupon.used_count >= coupon.usage_limit) return { valid: false, message: 'Coupon usage limit reached' };
  if (orderTotal < coupon.min_order_amount) return { valid: false, message: `Minimum order amount is ${coupon.min_order_amount}` };
  let discount = coupon.discount_type === 'percentage'
    ? (orderTotal * coupon.discount_value) / 100
    : coupon.discount_value;
  if (coupon.max_discount) discount = Math.min(discount, coupon.max_discount);
  return { valid: true, discount: parseFloat(discount.toFixed(2)), coupon };
};

module.exports = { createCouponTable, createCoupon, getCouponByCode, getAllCoupons, updateCoupon, deleteCoupon, incrementCouponUsage, validateCoupon };
