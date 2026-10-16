// backend/routes/couponRoutes.js
const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { authenticateAdmin, authenticateUser, optionalAuth } = require('../middleware/authMiddleware');
const {
  getAllCoupons,
  getCouponById,
  createCoupon,
  bulkCreateCoupons,
  updateCoupon,
  deleteCoupon,
  validateCoupon,
  getUserCouponUsageMap,
  getCouponRedemptions,
  getCouponAnalyticsSummary,
} = require('../models/couponModel');

// 1. PUBLIC: Fetch active storewide coupons (excluding already-redeemed coupons for logged-in customer)
router.get('/public/active', optionalAuth, async (req, res) => {
  try {
    const userId = req.user?.id || null;
    const usageMap = userId ? await getUserCouponUsageMap(userId) : {};

    let hasPriorOrders = false;
    if (userId) {
      try {
        const [ordRows] = await pool.query(
          "SELECT COUNT(*) AS cnt FROM orders WHERE user_id = ? AND status NOT IN ('cancelled')",
          [userId]
        );
        hasPriorOrders = Number(ordRows?.[0]?.cnt || 0) > 0;
      } catch {
        hasPriorOrders = false;
      }
    }

    const [rows] = await pool.query(
      `SELECT id, code, discount_type, discount_value,
              GREATEST(COALESCE(min_order_value, 0), COALESCE(min_order_amount, 0), COALESCE(minimum_order_amount, 0)) AS minimum_order_amount,
              GREATEST(COALESCE(min_order_value, 0), COALESCE(min_order_amount, 0), COALESCE(minimum_order_amount, 0)) AS min_order_value,
              max_discount, COALESCE(expiry_date, expires_at) AS expiry_date, reward_type,
              usage_limit, used_count, COALESCE(per_user_limit, 1) AS per_user_limit,
              COALESCE(first_order_only, 0) AS first_order_only,
              allowed_payment_modes, description, campaign_tag
       FROM coupons
       WHERE COALESCE(status, 'active') = 'active'
         AND COALESCE(is_active, 1) = 1
         AND restricted_user_id IS NULL
         AND (valid_from IS NULL OR valid_from <= NOW())
         AND (expiry_date IS NULL OR expiry_date > NOW())
         AND (expires_at IS NULL OR expires_at > NOW())
         AND (usage_limit IS NULL OR COALESCE(used_count, 0) < usage_limit)
       ORDER BY discount_value DESC`
    );

    const eligibleCoupons = rows
      .map((c) => {
        const codeUpper = String(c.code || '').toUpperCase();
        const usedByUser = Number(usageMap[codeUpper] || 0);
        const perUserLimit = c.per_user_limit !== null && c.per_user_limit !== undefined ? Number(c.per_user_limit) : 1;
        const reachedUserLimit = userId && perUserLimit > 0 && usedByUser >= perUserLimit;
        const blockedByFirstOrder = userId && Number(c.first_order_only) === 1 && hasPriorOrders;
        return {
          ...c,
          user_used_count: usedByUser,
          already_redeemed: Boolean(reachedUserLimit),
          ineligible_first_order: Boolean(blockedByFirstOrder),
          remaining_uses_for_user: perUserLimit > 0 ? Math.max(0, perUserLimit - usedByUser) : null,
        };
      })
      .filter((c) => !c.already_redeemed && !c.ineligible_first_order);

    res.json({ success: true, coupons: eligibleCoupons });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to load active coupons', error: error.message });
  }
});

// 2. CUSTOMER: Fetch personal coupons assigned to the logged-in user
router.get('/mine', authenticateUser, async (req, res) => {
  try {
    const usageMap = await getUserCouponUsageMap(req.user.id);
    const [rows] = await pool.query(
      `SELECT id, code, discount_type, discount_value,
              GREATEST(COALESCE(min_order_value, 0), COALESCE(min_order_amount, 0), COALESCE(minimum_order_amount, 0)) AS minimum_order_amount,
              GREATEST(COALESCE(min_order_value, 0), COALESCE(min_order_amount, 0), COALESCE(minimum_order_amount, 0)) AS min_order_value,
              max_discount, COALESCE(expiry_date, expires_at) AS expiry_date,
              COALESCE(status, 'active') AS status, reward_type,
              usage_limit, used_count, COALESCE(per_user_limit, 1) AS per_user_limit,
              wallet_per_order_limit, description, campaign_tag
       FROM coupons
       WHERE restricted_user_id = ?
         AND COALESCE(status, 'active') = 'active'
         AND COALESCE(is_active, 1) = 1
         AND (valid_from IS NULL OR valid_from <= NOW())
         AND (expiry_date IS NULL OR expiry_date > NOW())
         AND (expires_at IS NULL OR expires_at > NOW())
         AND (usage_limit IS NULL OR COALESCE(used_count, 0) < usage_limit)
       ORDER BY created_at DESC`,
      [req.user.id]
    );

    const personalCoupons = rows
      .map((c) => {
        const codeUpper = String(c.code || '').toUpperCase();
        const usedByUser = Number(usageMap[codeUpper] || 0);
        const perUserLimit = c.per_user_limit !== null && c.per_user_limit !== undefined ? Number(c.per_user_limit) : 1;
        const isRedeemed = perUserLimit > 0 && usedByUser >= perUserLimit;
        return {
          ...c,
          user_used_count: usedByUser,
          is_redeemed: isRedeemed,
        };
      })
      .filter((c) => !c.is_redeemed);

    res.json({ success: true, coupons: personalCoupons });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to load your coupons', error: error.message });
  }
});

// 3. CHECKOUT: Validate a coupon code (enforces per-user limit, global limit, min order, first-order, payment mode)
router.post('/validate', optionalAuth, async (req, res) => {
  try {
    const { code, orderTotal, subtotal, paymentMode, items } = req.body;
    const effectiveTotal = orderTotal !== undefined ? orderTotal : (subtotal !== undefined ? subtotal : 0);
    if (!code) {
      return res.status(400).json({
        success: false,
        code: 'COUPON_CODE_REQUIRED',
        message: 'Coupon code is required.',
      });
    }

    const validationResult = await validateCoupon(
      code,
      effectiveTotal,
      req.user?.id || null,
      { paymentMode, items }
    );
    if (validationResult && validationResult.valid === false) {
      return res.status(400).json({
        success: false,
        code: validationResult.code || 'COUPON_INVALID',
        message: validationResult.message || 'Invalid coupon code.',
      });
    }
    res.json({
      success: true,
      message: 'Coupon applied successfully!',
      data: validationResult,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      code: error.code || 'COUPON_INVALID',
      message: error.message,
    });
  }
});

// 4. ADMIN: Get Coupon Analytics & Redemption Ledger Summary
router.get('/admin/analytics', authenticateAdmin, async (req, res) => {
  try {
    const [summary, recentRedemptions] = await Promise.all([
      getCouponAnalyticsSummary(),
      getCouponRedemptions(null, 50),
    ]);
    res.json({
      success: true,
      summary,
      recentRedemptions,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to load coupon analytics', error: error.message });
  }
});

// 5. ADMIN: Get Redemption Audit Trail for a Specific Coupon
router.get('/:id/redemptions', authenticateAdmin, async (req, res) => {
  try {
    const coupon = await getCouponById(req.params.id);
    if (!coupon) {
      return res.status(404).json({ success: false, message: 'Coupon not found' });
    }
    const redemptions = await getCouponRedemptions(req.params.id, 100);
    res.json({
      success: true,
      coupon,
      redemptions,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to load coupon redemptions', error: error.message });
  }
});

// 6. ADMIN: Bulk Generate Campaign Coupons
router.post('/bulk-generate', authenticateAdmin, async (req, res) => {
  try {
    const {
      prefix = 'BHVM',
      count = 10,
      discount_type = 'percentage',
      discount_value = 10,
      min_order_value = 500,
      max_discount = 300,
      usage_limit = 1,
      per_user_limit = 1,
      first_order_only = false,
      expiry_date,
      reward_type = 'standard',
      campaign_tag = 'BULK_CAMPAIGN',
      description = null,
    } = req.body;

    if (!expiry_date) {
      return res.status(400).json({ success: false, message: 'Expiry date is required for bulk generation.' });
    }

    const generated = await bulkCreateCoupons({
      prefix,
      count,
      discount_type,
      discount_value,
      min_order_value,
      max_discount,
      usage_limit,
      per_user_limit,
      first_order_only,
      expiry_date,
      reward_type,
      campaign_tag,
      description,
    });

    res.status(201).json({
      success: true,
      message: `Generated ${generated.length} tamper-proof coupons.`,
      coupons: generated,
    });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message || 'Failed to bulk generate coupons' });
  }
});

// 7. ADMIN: Quick Toggle Coupon Status (active <-> disabled)
router.patch('/:id/status', authenticateAdmin, async (req, res) => {
  try {
    const coupon = await getCouponById(req.params.id);
    if (!coupon) {
      return res.status(404).json({ success: false, message: 'Coupon not found' });
    }
    const nextStatus = req.body?.status && ['active', 'disabled', 'expired'].includes(req.body.status)
      ? req.body.status
      : (coupon.status === 'active' && Number(coupon.is_active ?? 1) === 1 ? 'disabled' : 'active');
    const nextIsActive = nextStatus === 'active' ? 1 : 0;

    await pool.query('UPDATE coupons SET status = ?, is_active = ? WHERE id = ?', [nextStatus, nextIsActive, coupon.id]);
    res.json({
      success: true,
      status: nextStatus,
      message: `Coupon ${coupon.code} marked as ${nextStatus.toUpperCase()}.`,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to update coupon status', error: error.message });
  }
});

// 8. ADMIN: Get all coupons
router.get('/', authenticateAdmin, async (req, res) => {
  try {
    const [coupons, summary] = await Promise.all([
      getAllCoupons(),
      getCouponAnalyticsSummary(),
    ]);
    res.json({ success: true, count: coupons.length, data: coupons, summary });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error fetching coupons', error: error.message });
  }
});

// 9. ADMIN: Create a new coupon
router.post('/', authenticateAdmin, async (req, res) => {
  try {
    const { code, discount_type, discount_value, expiry_date, reward_type } = req.body;

    if (!code || !discount_type || !expiry_date) {
      return res.status(400).json({
        success: false,
        message: 'Please provide code, discount_type, and expiry_date.',
      });
    }
    if (discount_type !== 'free_shipping' && reward_type !== 'free_shipping' && (discount_value === undefined || discount_value === '')) {
      return res.status(400).json({
        success: false,
        message: 'Please provide a discount_value.',
      });
    }

    const couponId = await createCoupon({
      ...req.body,
      created_by_role: req.admin?.role || 'admin',
    });
    res.status(201).json({
      success: true,
      message: 'Coupon created successfully',
      couponId,
    });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ success: false, message: 'A coupon with this code already exists.' });
    }
    res.status(400).json({ success: false, message: error.message || 'Failed to create coupon' });
  }
});

// 10. ADMIN: Update an existing coupon
router.put('/:id', authenticateAdmin, async (req, res) => {
  try {
    const updated = await updateCoupon(req.params.id, req.body);
    if (!updated) {
      return res.status(404).json({ success: false, message: 'Coupon not found' });
    }
    res.json({ success: true, message: 'Coupon updated successfully' });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ success: false, message: 'A coupon with this code already exists.' });
    }
    res.status(400).json({ success: false, message: error.message || 'Failed to update coupon' });
  }
});

// 11. ADMIN: Delete a coupon
router.delete('/:id', authenticateAdmin, async (req, res) => {
  try {
    const deleted = await deleteCoupon(req.params.id);
    if (!deleted) {
      return res.status(404).json({ success: false, message: 'Coupon not found' });
    }
    res.json({ success: true, message: 'Coupon deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to delete coupon', error: error.message });
  }
});

module.exports = router;
