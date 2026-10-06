//Coupon
const pool = require('../config/db');

let couponTablePromise;

const createCouponTable = async () => {
  if (!couponTablePromise) couponTablePromise = (async () => {
    await pool.query(`
    CREATE TABLE IF NOT EXISTS coupons (
      id INT AUTO_INCREMENT PRIMARY KEY,
      code VARCHAR(50) NOT NULL UNIQUE,
      description VARCHAR(255) DEFAULT NULL,
      discount_type ENUM('percentage','fixed') NOT NULL DEFAULT 'percentage',
      discount_value DECIMAL(10,2) NOT NULL,
      min_order_amount DECIMAL(10,2) DEFAULT 0,
      max_discount DECIMAL(10,2) DEFAULT NULL,
      usage_limit INT DEFAULT NULL,
      used_count INT DEFAULT 0,
      is_active TINYINT(1) DEFAULT 1,
      valid_from DATETIME DEFAULT NULL,
      expires_at DATETIME DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
    `);

    for (const [column, definition] of [
      ['description', 'VARCHAR(255) DEFAULT NULL'],
      ['valid_from', 'DATETIME DEFAULT NULL'],
    ]) {
      const [rows] = await pool.query(
        'SELECT COUNT(*) AS column_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        ['coupons', column]
      );
      if (!rows[0]?.column_exists) await pool.query(`ALTER TABLE coupons ADD COLUMN ${column} ${definition}`);
    }
  })().catch(error => {
    couponTablePromise = null;
    throw error;
  });

  return couponTablePromise;
};

const createCoupon = async (data) => {
  const {
    code,
    description,
    discount_type,
    discount_value,
    min_order_amount,
    min_purchase,
    max_discount,
    usage_limit,
    valid_from,
    expires_at,
    valid_until,
    status,
    is_active,
  } = data;
  const active = is_active ?? (status === undefined ? 1 : status === 'active' ? 1 : 0);
  const [result] = await pool.query(
    'INSERT INTO coupons (code, description, discount_type, discount_value, min_order_amount, max_discount, usage_limit, is_active, valid_from, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [code.toUpperCase(), description || null, discount_type, discount_value, min_order_amount ?? min_purchase ?? 0, max_discount || null, usage_limit || null, active, valid_from || null, expires_at || valid_until || null]
  );
  return result.insertId;
};

const getCouponByCode = async (code) => {
  const [rows] = await pool.query('SELECT * FROM coupons WHERE code = ?', [code.toUpperCase()]);
  return rows[0];
};

const getAllCoupons = async () => {
  const [rows] = await pool.query(`
    SELECT id, code, description, discount_type, discount_value,
           min_order_amount, min_order_amount AS min_purchase, max_discount,
           usage_limit, used_count, is_active, IF(is_active = 1, 'active', 'inactive') AS status,
           valid_from, expires_at, expires_at AS valid_until, created_at
    FROM coupons
    ORDER BY created_at DESC
  `);
  return rows;
};

const updateCoupon = async (id, data) => {
  const allowedFields = {
    code: 'code',
    description: 'description',
    discount_type: 'discount_type',
    discount_value: 'discount_value',
    min_order_amount: 'min_order_amount',
    min_purchase: 'min_order_amount',
    max_discount: 'max_discount',
    usage_limit: 'usage_limit',
    used_count: 'used_count',
    is_active: 'is_active',
    status: 'is_active',
    valid_from: 'valid_from',
    valid_until: 'expires_at',
    expires_at: 'expires_at',
  };
  const updates = Object.entries(data)
    .filter(([key]) => allowedFields[key])
    .map(([key, value]) => [allowedFields[key], key === 'status' ? (value === 'active' ? 1 : 0) : value]);
  const fields = [...new Set(updates.map(([field]) => field))];
  if (fields.length === 0) return;
  const values = fields.map(field => {
    const update = updates.find(([candidate]) => candidate === field);
    return field === 'code' && update[1] ? String(update[1]).toUpperCase() : update[1];
  });
  const assignments = fields.map(field => `${field} = ?`).join(', ');
  await pool.query(`UPDATE coupons SET ${assignments} WHERE id = ?`, [...values, id]);
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
  if (coupon.valid_from && new Date(coupon.valid_from) > new Date()) return { valid: false, message: 'Coupon is not active yet' };
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
