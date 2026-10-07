const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const pool = require('../config/db');
const { getSetting } = require('../models/settingsModel');
const { initWarrantyTable } = require('../models/warrantyModel');
const { createCouponTable } = require('../models/couponModel');

const router = express.Router();
const spinLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many spin attempts. Please try again later.' },
});
let spinTableReady;

const ensureSpinTable = async () => {
  if (!spinTableReady) {
    spinTableReady = pool.query(`
      CREATE TABLE IF NOT EXISTS gamification_spin_claims (
        id INT AUTO_INCREMENT PRIMARY KEY,
        warranty_registration_id INT NOT NULL UNIQUE,
        coupon_code VARCHAR(50) NOT NULL UNIQUE,
        reward_label VARCHAR(120) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `).catch(error => {
      spinTableReady = null;
      throw error;
    });
  }
  return spinTableReady;
};

const REWARDS = [
  { label: '5% off, up to ₹200', type: 'percentage', value: 5, minimum: 500, maximum: 200, weight: 50 },
  { label: '10% off, up to ₹500', type: 'percentage', value: 10, minimum: 1500, maximum: 500, weight: 30 },
  { label: '₹250 off', type: 'fixed', value: 250, minimum: 2500, maximum: null, weight: 15 },
  { label: '₹500 off', type: 'fixed', value: 500, minimum: 5000, maximum: null, weight: 5 },
];

const chooseReward = () => {
  const roll = crypto.randomInt(100);
  let cursor = 0;
  return REWARDS.find(reward => {
    cursor += reward.weight;
    return roll < cursor;
  }) || REWARDS[0];
};

const responseForClaim = claim => ({
  success: true,
  reward: claim.reward_label,
  couponCode: claim.coupon_code,
  message: 'Your reward is ready to use at checkout.'
});

router.post('/spin', spinLimiter, async (req, res) => {
  const rawRegistrationId = String(req.body?.registrationId ?? '').trim();
  const registrationId = /^\d+$/.test(rawRegistrationId) ? Number(rawRegistrationId) : NaN;
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!Number.isInteger(registrationId) || registrationId < 1 || !email) {
    return res.status(400).json({ message: 'A valid warranty registration ID and email are required.' });
  }

  let connection;
  try {
    await initWarrantyTable();
    await createCouponTable();
    await ensureSpinTable();
    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [registrations] = await connection.query(
      'SELECT id, user_email, status FROM warranty_registrations WHERE id = ? FOR UPDATE',
      [registrationId]
    );
    const registration = registrations[0];
    if (!registration) {
      await connection.rollback();
      return res.status(404).json({ message: 'Warranty registration not found.' });
    }
    if (!registration.user_email || registration.user_email.trim().toLowerCase() !== email) {
      await connection.rollback();
      return res.status(403).json({ message: 'The email does not match this warranty registration.' });
    }
    if (registration.status !== 'accepted') {
      await connection.rollback();
      return res.status(409).json({ message: 'This warranty registration is not eligible for a spin reward.' });
    }

    const [existingClaims] = await connection.query(
      'SELECT reward_label, coupon_code FROM gamification_spin_claims WHERE warranty_registration_id = ?',
      [registrationId]
    );
    if (existingClaims.length) {
      await connection.commit();
      return res.json(responseForClaim(existingClaims[0]));
    }
    if ((await getSetting('gamification_spin_after_purchase_enabled')) !== '1') {
      await connection.rollback();
      return res.status(403).json({ message: 'Post-purchase spin is currently unavailable.' });
    }

    const reward = chooseReward();
    const couponCode = `SPIN-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
    await connection.query(
      `INSERT INTO coupons
        (code, description, discount_type, discount_value, min_order_amount, max_discount, usage_limit, used_count, is_active, valid_from, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, 0, 1, NOW(), DATE_ADD(NOW(), INTERVAL 30 DAY))`,
      [couponCode, `spin_reward:${registrationId}`, reward.type, reward.value, reward.minimum, reward.maximum]
    );
    await connection.query(
      'INSERT INTO gamification_spin_claims (warranty_registration_id, coupon_code, reward_label) VALUES (?, ?, ?)',
      [registrationId, couponCode, reward.label]
    );
    await connection.commit();
    return res.status(201).json(responseForClaim({ reward_label: reward.label, coupon_code: couponCode }));
  } catch (error) {
    if (connection) await connection.rollback().catch(() => {});
    console.error('[GAMIFICATION_SPIN]', error);
    return res.status(500).json({ message: 'Unable to issue the spin reward right now.' });
  } finally {
    connection?.release();
  }
});

module.exports = router;