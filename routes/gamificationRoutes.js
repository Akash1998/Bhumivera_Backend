const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const pool = require('../config/db');
const { authenticateUser } = require('../middleware/authMiddleware');
const { getSetting } = require('../models/settingsModel');
const { initWarrantyTable } = require('../models/warrantyModel');
const { createCouponTable } = require('../models/couponModel');
const { createNotification } = require('../models/notificationModel');
const { validateOrderSpinRewards, chooseOrderSpinReward } = require('../services/orderSpinPolicy');

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

router.get('/order-spin/:orderId', authenticateUser, async (req, res) => {
  const orderId = Number(req.params.orderId);
  if (!Number.isSafeInteger(orderId) || orderId < 1) {
    return res.status(400).json({ code: 'INVALID_ORDER_ID', message: 'A valid order is required.' });
  }
  try {
    const [[order]] = await pool.query(
      `SELECT id, status, payment_status, payment_mode
       FROM orders WHERE id = ? AND user_id = ?`,
      [orderId, req.user.id]
    );
    if (!order) return res.status(404).json({ code: 'ORDER_NOT_FOUND', message: 'This order could not be found.' });
    const [claims] = await pool.query(
      `SELECT claim.reward_label, claim.coupon_code, claim.reward_index, claim.reward_type, claim.points_awarded,
              coupon.description, coupon.terms_and_conditions,
              GREATEST(COALESCE(coupon.min_order_value, 0), COALESCE(coupon.min_order_amount, 0), COALESCE(coupon.minimum_order_amount, 0)) AS minimum_order_amount
       FROM order_spin_claims claim
       LEFT JOIN coupons coupon ON coupon.code = claim.coupon_code
       WHERE claim.order_id = ? AND claim.user_id = ?`,
      [orderId, req.user.id]
    );
    const eligible = !['cancelled', 'returned'].includes(order.status) &&
      order.payment_status !== 'failed' &&
      (order.payment_mode === 'COD' || order.payment_status === 'paid');
    const enabled = (await getSetting('gamification_spin_after_purchase_enabled')) === '1';
    const spinSettings = enabled && eligible && !claims[0]
      ? validateOrderSpinRewards(await getSetting('gamification_order_spin_rewards'))
      : null;
    if (spinSettings && !spinSettings.valid) {
      console.error('[ORDER_SPIN_CONFIGURATION_INVALID]', spinSettings.message);
      return res.status(503).json({
        code: 'ORDER_SPIN_CONFIGURATION_INVALID',
        message: 'Reward spins are temporarily unavailable. Please contact support.',
      });
    }
    return res.json({
      enabled,
      eligible,
      rewards: spinSettings?.rewards.map(reward => ({
        label: reward.label,
        description: reward.description,
        rewardType: reward.rewardType,
        minimumOrderAmount: reward.minimumOrderAmount || 0,
      })) || [],
      claim: claims[0] ? {
        reward: claims[0].reward_label,
        couponCode: claims[0].coupon_code,
        rewardIndex: Number(claims[0].reward_index),
        rewardType: claims[0].reward_type,
        pointsAwarded: Number(claims[0].points_awarded) || 0,
        rewardDescription: claims[0].description,
        termsAndConditions: claims[0].terms_and_conditions,
        minimumOrderAmount: Number(claims[0].minimum_order_amount) || 0,
      } : null,
    });
  } catch (error) {
    console.error('[ORDER_SPIN_STATUS]', error);
    return res.status(500).json({ code: 'ORDER_SPIN_STATUS_FAILED', message: 'Could not check reward spin availability.' });
  }
});

router.post('/order-spin/:orderId', spinLimiter, authenticateUser, async (req, res) => {
  const orderId = Number(req.params.orderId);
  if (!Number.isSafeInteger(orderId) || orderId < 1) {
    return res.status(400).json({ code: 'INVALID_ORDER_ID', message: 'A valid order is required to spin.' });
  }

  let connection;
  try {
    await createCouponTable();
    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [orders] = await connection.query(
      `SELECT id, status, payment_status, payment_mode
       FROM orders WHERE id = ? AND user_id = ? FOR UPDATE`,
      [orderId, req.user.id]
    );
    const order = orders[0];
    if (!order) {
      await connection.rollback();
      return res.status(404).json({ code: 'ORDER_NOT_FOUND', message: 'This order could not be found.' });
    }
    if (['cancelled', 'returned'].includes(order.status) ||
        order.payment_status === 'failed' ||
        order.payment_mode !== 'COD' && order.payment_status !== 'paid') {
      await connection.rollback();
      return res.status(409).json({ code: 'ORDER_NOT_ELIGIBLE_FOR_SPIN', message: 'This order is not eligible for a reward spin.' });
    }

    const [existingClaims] = await connection.query(
      `SELECT claim.reward_label, claim.coupon_code, claim.reward_index, claim.reward_type, claim.points_awarded,
              coupon.description, coupon.terms_and_conditions,
              GREATEST(COALESCE(coupon.min_order_value, 0), COALESCE(coupon.min_order_amount, 0), COALESCE(coupon.minimum_order_amount, 0)) AS minimum_order_amount
       FROM order_spin_claims claim
       LEFT JOIN coupons coupon ON coupon.code = claim.coupon_code
       WHERE claim.order_id = ?`,
      [orderId]
    );
    if (existingClaims.length) {
      await connection.commit();
      const claim = existingClaims[0];
      return res.json({
        success: true,
        reward: claim.reward_label,
        couponCode: claim.coupon_code,
        rewardIndex: Number(claim.reward_index),
        rewardType: claim.reward_type,
        pointsAwarded: Number(claim.points_awarded) || 0,
        rewardDescription: claim.description,
        termsAndConditions: claim.terms_and_conditions,
        minimumOrderAmount: Number(claim.minimum_order_amount) || 0,
        alreadyClaimed: true,
      });
    }

    if ((await getSetting('gamification_spin_after_purchase_enabled')) !== '1') {
      await connection.rollback();
      return res.status(403).json({ code: 'ORDER_SPIN_DISABLED', message: 'Post-order rewards are not available right now.' });
    }
    const spinSettings = validateOrderSpinRewards(await getSetting('gamification_order_spin_rewards'));
    if (!spinSettings.valid) {
      await connection.rollback();
      console.error('[ORDER_SPIN_CONFIGURATION_INVALID]', spinSettings.message);
      return res.status(503).json({ code: 'ORDER_SPIN_CONFIGURATION_INVALID', message: 'Reward spins are temporarily unavailable.' });
    }

    const reward = chooseOrderSpinReward(spinSettings.rewards);
    let couponCode = null;
    let pointsAwarded = 0;
    if (reward.rewardType === 'points') {
      pointsAwarded = reward.points;
      const [[user]] = await connection.query(
        'SELECT loyalty_points, loyalty_lifetime_points FROM users WHERE id = ? FOR UPDATE',
        [req.user.id]
      );
      if (!user) {
        await connection.rollback();
        return res.status(404).json({ code: 'CUSTOMER_NOT_FOUND', message: 'Customer account not found.' });
      }
      const balance = Number(user.loyalty_points) + pointsAwarded;
      await connection.query(
        'UPDATE users SET loyalty_points = ?, loyalty_lifetime_points = loyalty_lifetime_points + ? WHERE id = ?',
        [balance, pointsAwarded, req.user.id]
      );
      await connection.query(
        `INSERT INTO loyalty_point_transactions
          (user_id, points_delta, balance_after, type, description, reference_id, order_id)
         VALUES (?, ?, ?, 'earn', ?, ?, ?)`,
        [req.user.id, pointsAwarded, balance, `Post-order spin reward: ${reward.label}`, `order-spin-${orderId}`, orderId]
      );
    } else {
      couponCode = `SPIN-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
      const isFreeShipping = reward.rewardType === 'free_shipping';
      await connection.query(
        `INSERT INTO coupons
          (code, description, terms_and_conditions, discount_type, discount_value, min_order_amount, max_discount,
           usage_limit, used_count, restricted_user_id, is_active, valid_from, expires_at, reward_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?, 1, NOW(), DATE_ADD(NOW(), INTERVAL ? DAY), ?)`,
        [
          couponCode,
          reward.description || null,
          reward.termsAndConditions || null,
          isFreeShipping ? 'fixed' : reward.discountType,
          isFreeShipping ? 0 : reward.discountValue,
          reward.minimumOrderAmount,
          isFreeShipping ? null : reward.maxDiscount,
          req.user.id,
          reward.expiryDays,
          isFreeShipping ? 'free_shipping' : 'standard',
        ]
      );
    }
    await connection.query(
      `INSERT INTO order_spin_claims
        (order_id, user_id, reward_label, coupon_code, reward_index, reward_type, points_awarded)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [orderId, req.user.id, reward.label, couponCode, reward.index, reward.rewardType, pointsAwarded]
    );
    await connection.commit();

    const notificationData = [
      {
        user_id: req.user.id,
        title: 'Your order spin reward is ready',
        message: reward.rewardType === 'points'
          ? `${reward.label} has been added to your loyalty points balance.`
          : `${reward.label} has been added to your coupons. Code: ${couponCode}`,
        type: 'reward',
        is_global: false,
      },
      {
        user_id: null,
        title: 'Customer won an order spin reward',
        message: `Order #${orderId} won ${reward.label}${couponCode ? ` (${couponCode})` : ''}.`,
        type: 'order_reward',
        is_global: false,
      },
    ];
    for (const notification of notificationData) {
      try {
        await createNotification(notification);
      } catch (error) {
        console.error('[ORDER_SPIN_NOTIFICATION_FAILED]', { orderId, userId: notification.user_id, error });
      }
    }

    return res.status(201).json({
      success: true,
      reward: reward.label,
      couponCode,
      rewardIndex: reward.index,
      rewardType: reward.rewardType,
      pointsAwarded,
      rewardDescription: reward.description,
      termsAndConditions: reward.termsAndConditions,
      minimumOrderAmount: reward.minimumOrderAmount || 0,
      alreadyClaimed: false,
    });
  } catch (error) {
    if (connection) await connection.rollback().catch(() => {});
    console.error('[ORDER_SPIN_CLAIM]', error);
    return res.status(500).json({ code: 'ORDER_SPIN_FAILED', message: 'Could not issue your spin reward. Please try again.' });
  } finally {
    connection?.release();
  }
});

module.exports = router;