// Cart: add, update, remove, clear, get - all require user aut
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { authenticateUser } = require('../middleware/authMiddleware');
const pool = require('../config/db');
const { 
  getCartByUser, 
  upsertCartItem, 
  updateCartItemQuantity,
  removeCartItem, 
  clearCart, 
  getCartTotal 
} = require('../models/cartModel');
const { listCartRules } = require('../models/cartRulesModel');
const { evaluateCartRules } = require('../utils/cartRulesEngine');
const { getSetting } = require('../models/settingsModel');
const { getUserLoyaltyTier } = require('../models/loyaltyTierModel');
const { createCouponTable } = require('../models/couponModel');

router.post('/abandoned-coupon', authenticateUser, async (req, res) => {
  let connection;
  try {
    const enabled = await getSetting('cart_abandonment_coupon_enabled');
    if (enabled === '0') return res.status(403).json({ message: 'Cart recovery offers are currently disabled.' });

    const items = await getCartByUser(req.user.id);
    if (!items.length) return res.status(400).json({ message: 'Add an item to your cart before requesting a recovery offer.' });
    const lastActivity = Math.max(...items.map(item => new Date(item.updated_at || item.created_at).getTime()).filter(Number.isFinite));
    if (!Number.isFinite(lastActivity)) {
      return res.status(500).json({ message: 'Cart activity could not be verified. Please refresh and try again.' });
    }
    const delayMinutes = Math.max(1, Math.min(10080, Number.parseInt(await getSetting('cart_abandonment_coupon_delay_minutes'), 10) || 30));
    const eligibleAt = lastActivity + delayMinutes * 60 * 1000;
    if (Date.now() < eligibleAt) {
      return res.status(409).json({
        code: 'CART_NOT_ABANDONED',
        message: 'This offer becomes available after your cart has been inactive for a while.',
        eligible_at: Number.isFinite(eligibleAt) ? new Date(eligibleAt).toISOString() : null,
      });
    }

    await createCouponTable();
    connection = await pool.getConnection();
    await connection.beginTransaction();
    await connection.query('SELECT id FROM users WHERE id = ? FOR UPDATE', [req.user.id]);
    const [existing] = await connection.query(
      `SELECT code, discount_value, expires_at FROM coupons
       WHERE restricted_user_id = ? AND description LIKE 'abandoned_cart:%'
         AND is_active = 1 AND used_count < usage_limit
         AND (expires_at IS NULL OR expires_at >= NOW())
       ORDER BY id DESC LIMIT 1`,
      [req.user.id]
    );
    if (existing.length) {
      await connection.commit();
      return res.json({
        code: existing[0].code,
        expires_at: existing[0].expires_at,
        discount_percent: Number(existing[0].discount_value),
        reused: true,
      });
    }

    const percent = Math.max(1, Math.min(50, Number(await getSetting('cart_abandonment_coupon_percent')) || 5));
    const validDays = Math.max(1, Math.min(30, Number.parseInt(await getSetting('cart_abandonment_coupon_valid_days'), 10) || 7));
    const maxDiscount = Math.max(1, Number(await getSetting('cart_abandonment_coupon_max_discount')) || 100);
    const code = `BHUMI5-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const expiresAt = new Date(Date.now() + validDays * 24 * 60 * 60 * 1000);
    await connection.query(
      `INSERT INTO coupons
        (code, description, discount_type, discount_value, min_order_amount, max_discount,
         usage_limit, used_count, restricted_user_id, is_active, valid_from, expires_at)
       VALUES (?, 'abandoned_cart: personal recovery offer', 'percentage', ?, 0, ?, 1, 0, ?, 1, NOW(), ?)`,
      [code, percent, maxDiscount, req.user.id, expiresAt]
    );
    await connection.commit();
    return res.status(201).json({ code, expires_at: expiresAt, discount_percent: percent });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error('[CART_ABANDONED_COUPON]', error);
    return res.status(500).json({ message: 'Could not create your cart recovery offer.' });
  } finally {
    if (connection) connection.release();
  }
});

// GET /api/cart - get current user's 
router.get('/', authenticateUser, async (req, res) => {
  try { 
    const { items, total } = await getCartTotal(req.user.id);
    const safeItems = Array.isArray(items) ? items : [];
    const rules = await listCartRules({ activeOnly: true });
    const enforceMinimum = (await getSetting('enforce_cart_rule_minimum')) === '1';
    const loyaltyTier = await getUserLoyaltyTier(req.user.id);
    const rulePreview = evaluateCartRules(Number(total) || 0, rules, {
      userId: req.user.id,
      enforceMinimum,
      loyaltyTierId: loyaltyTier?.id,
      loyaltyTierName: loyaltyTier?.name,
    });
    const couponStackPolicy = await getSetting('coupon_stack_policy') || 'rule_first';
    const abandonmentEnabled = (await getSetting('cart_abandonment_coupon_enabled')) !== '0';
    const delayMinutes = Math.max(1, Math.min(10080, Number.parseInt(await getSetting('cart_abandonment_coupon_delay_minutes'), 10) || 30));
    const lastActivity = safeItems.reduce((latest, item) => {
      const value = new Date(item.updated_at || item.created_at).getTime();
      return Number.isFinite(value) ? Math.max(latest, value) : latest;
    }, 0);
    return res.json({
      items: safeItems,
      total: total || 0,
      rulePreview,
      couponStackPolicy,
      abandonment: { enabled: abandonmentEnabled, delayMinutes, lastActivityAt: lastActivity ? new Date(lastActivity).toISOString() : null },
    });
  } catch (err) {
    console.error("GET /api/cart Error:", err);
    return res.status(500).json({ message: 'Failed to load cart' });
  }
});

// POST /api/cart - add/update item { productId, quantity }
router.post('/', authenticateUser, async (req, res) => {
  try {
    const { productId, quantity } = req.body;
    
    // SECURITY FIX: Prevent string/decimal quantity injections
    const parsedQuantity = parseInt(quantity, 10);
    
    if (!productId || isNaN(parsedQuantity) || parsedQuantity < 1) {
      return res.status(400).json({ message: 'productId and a valid quantity (>=1) are required' });
    }
    
    const items = await upsertCartItem(req.user.id, productId, parsedQuantity);
    
    if (!Array.isArray(items)) {
        throw new Error('Database returned invalid data');
    }

    const total = items.reduce((s, i) => s + (parseFloat(i.subtotal) || 0), 0);
    return res.json({ items, total: parseFloat(total.toFixed(2)) });
  } catch (err) {
    console.error("POST /api/cart Error:", err);
    const status = err.status || 500;
    return res.status(status).json({ 
        message: err.message || 'Failed to update cart',
        error: process.env.access_ENV === 'development' ? err : undefined
    });
  }
});

// PUT /api/cart/:productId - update quantity
router.put('/:productId', authenticateUser, async (req, res) => {
  try {
    const productId = req.params.productId;
    const parsedQuantity = parseInt(req.body.quantity, 10);

    if (!productId || Number.isNaN(parsedQuantity) || parsedQuantity < 1) {
      return res.status(400).json({ message: 'A valid quantity (>=1) is required' });
    }

    const items = await updateCartItemQuantity(req.user.id, productId, parsedQuantity);
    const total = (items || []).reduce((s, i) => s + (parseFloat(i.subtotal) || 0), 0);
    return res.json({ items: items || [], total: parseFloat(total.toFixed(2)) });
  } catch (err) {
    console.error("PUT /api/cart/:id Error:", err);
    const status = err.status || 500;
    return res.status(status).json({
      message: err.message || 'Failed to update quantity',
      error: process.env.access_ENV === 'development' ? err : undefined
    });
  }
});

// DELETE /api/cart/:productId - remove one item
router.delete('/:productId', authenticateUser, async (req, res) => {
  try {
    const items = await removeCartItem(req.user.id, req.params.productId);
    const total = (items || []).reduce((s, i) => s + (parseFloat(i.subtotal) || 0), 0);
    return res.json({ items: items || [], total: parseFloat(total.toFixed(2)) });
  } catch (err) {
    console.error("DELETE /api/cart/:id Error:", err);
    return res.status(500).json({ message: 'Failed to remove item' });
  }
});

// DELETE /api/cart - clear entire cart
router.delete('/', authenticateUser, async (req, res) => {
  try {
    await clearCart(req.user.id);
    return res.json({ items: [], total: 0 });
  } catch (err) {
    console.error("DELETE /api/cart Error:", err);
    return res.status(500).json({ message: 'Failed to clear cart' });
  }
});

module.exports = router;
