const { couponValidateLimiter } = require('../middleware/rateLimiter');
// backend/routes/couponRoutes.js
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');

const optionalAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return next();
  try {
    const payload = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET || 'fallback_secret');
    req.user = payload;
  } catch (err) {}
  next();
};

const pool = require('../config/db');
const { authenticateUser, authenticateAdmin } = require('../middleware/authMiddleware');
const { createCouponTable, createCoupon, getAllCoupons, getCouponByCode, updateCoupon, deleteCoupon, validateCoupon } = require('../models/couponModel');
const { reconcileReferralRewards } = require('../models/referralModel');
const { validateDateRange } = require('../utils/dateValidation');

const sendInvalidDate = (res, result) => res.status(400).json({
  code: 'INVALID_DATE',
  field: result.field,
  message: result.message,
  userAction: 'Enter a valid start and end date.',
});

router.use(async (req, res, next) => {
  try {
    await createCouponTable();
    return next();
  } catch (error) {
    console.error(`[COUPON_SCHEMA_UNAVAILABLE] code=${error.code || 'UNKNOWN'} message=${error.message}`);
    return res.status(503).json({
      code: 'COUPON_SCHEMA_UNAVAILABLE',
      message: 'Coupon services are temporarily unavailable. Please try again shortly.',
    });
  }
});

// POST /api/coupons/validate - validate coupon (public)
router.post('/validate', couponValidateLimiter, optionalAuth, async (req, res) => {
  try {
    const { code, orderTotal } = req.body;
    if (typeof code !== 'string' || !code.trim()) {
      return res.status(400).json({ code: 'COUPON_CODE_REQUIRED', message: 'Coupon code is required.' });
    }
    const parsedOrderTotal = orderTotal === undefined ? 0 : Number(orderTotal);
    if (!Number.isFinite(parsedOrderTotal) || parsedOrderTotal < 0) {
      return res.status(400).json({ code: 'INVALID_ORDER_TOTAL', message: 'Enter a valid order total.' });
    }
    const result = await validateCoupon(code.trim(), parsedOrderTotal, req.user?.id || null);
    if (!result.valid) return res.status(400).json({ code: 'INVALID_COUPON', message: result.message });
    res.json({
      valid: true,
      discount: result.discount,
      referralWalletAmount: result.referralWalletAmount || 0,
      rewardType: result.coupon.reward_type || 'standard',
      coupon: {
        code: result.coupon.code,
        discount_type: result.coupon.discount_type,
        discount_value: result.coupon.discount_value,
        wallet_per_order_limit: result.coupon.wallet_per_order_limit || null,
      },
    });
  } catch (err) {
    console.error(`[COUPON_VALIDATE] code=${err.code || 'UNKNOWN'} table=${err.table || 'unknown'} message=${err.sqlMessage || err.message}`);
    res.status(500).json({
      code: 'COUPON_VALIDATION_FAILED',
      message: 'Could not validate this coupon right now. Please try again shortly.',
    });
  }
});

router.get('/mine', authenticateUser, async (req, res) => {
  try {
    await reconcileReferralRewards(req.user?.id || null);
    const [coupons] = await pool.query(
      `SELECT id, code, description, discount_type, discount_value, min_order_amount,
              max_discount, usage_limit, used_count, valid_from, expires_at,
              reward_type, wallet_per_order_limit,
              1 AS is_personal
       FROM coupons
       WHERE restricted_user_id = ? AND is_active = 1
         AND (valid_from IS NULL OR valid_from <= NOW())
         AND (expires_at IS NULL OR expires_at >= NOW())
         AND (usage_limit IS NULL OR used_count < usage_limit)
       ORDER BY created_at DESC`,
      [req.user?.id || null]
    );
    return res.json({ success: true, coupons });
  } catch (error) {
    console.error('[CUSTOMER_COUPONS]', error);
    return res.status(500).json({ success: false, message: 'Could not load your assigned coupons.' });
  }
});

// GET /api/coupons/public/active - list of currently active coupons (for customers)
router.get('/public/active', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT code,
              discount_type AS type,
              discount_value AS value,
              min_order_amount AS min_order_value,
              max_discount,
              valid_from,
              expires_at AS valid_until,
              usage_limit,
              used_count,
              discount_type,
              discount_value,
              min_order_amount,
              expires_at
       FROM coupons
       WHERE is_active = 1
         AND restricted_user_id IS NULL
         AND (description IS NULL OR description NOT LIKE 'spin_reward:%')
         AND (valid_from IS NULL OR valid_from <= NOW())
         AND (expires_at IS NULL OR expires_at >= NOW())
         AND (usage_limit IS NULL OR used_count < usage_limit)
       ORDER BY created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to load coupons' });
  }
});

// GET /api/coupons - admin: get all coupons
router.get('/', authenticateAdmin, async (req, res) => {
  try {
    const coupons = await getAllCoupons();
    res.json(coupons);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to get coupons' });
  }
});

// POST /api/coupons - admin: create coupon
router.post('/', authenticateAdmin, async (req, res) => {
  try {
    const dateRange = validateDateRange(req.body, 'valid_from', 'valid_until', { minDurationMs: 60 * 60 * 1000 });
    if (!dateRange.valid) return sendInvalidDate(res, dateRange);
    const { code, discount_type, discount_value } = req.body;
    if (!code || !discount_type || !discount_value) return res.status(400).json({ message: 'code, discount_type, discount_value are required' });
    const id = await createCoupon({ ...req.body, valid_from: dateRange.startDate, expires_at: dateRange.endDate });
    res.status(201).json({ message: 'Coupon created', id });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'Coupon code already exists' });
    console.error(err);
    res.status(500).json({ message: 'Failed to create coupon' });
  }
});

// PUT /api/coupons/:id - admin: update coupon
router.put('/:id', authenticateAdmin, async (req, res) => {
  try {
    const dateRange = validateDateRange(req.body, 'valid_from', 'valid_until', { minDurationMs: 60 * 60 * 1000 });
    if (!dateRange.valid) return sendInvalidDate(res, dateRange);
    const update = { ...req.body };
    if (Object.hasOwn(req.body, 'valid_from')) update.valid_from = dateRange.startDate;
    if (Object.hasOwn(req.body, 'valid_until')) update.valid_until = dateRange.endDate;
    await updateCoupon(req.params.id, update);
    res.json({ message: 'Coupon updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to update coupon' });
  }
});

// DELETE /api/coupons/:id - admin: delete coupon
router.delete('/:id', authenticateAdmin, async (req, res) => {
  try {
    await deleteCoupon(req.params.id);
    res.json({ message: 'Coupon deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to delete coupon' });
  }
});

module.exports = router;
