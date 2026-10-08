// backend/routes/settingsRoutes
const express = require('express');
const router = express.Router();
const { authenticateAdmin } = require('../middleware/authMiddleware');
const { getAllSettings, getSettingsByGroup, getSetting, updateSetting, bulkUpdateSettings } = require('../models/settingsModel');
const {
  listCartRules,
  getCartRuleById,
  createCartRule,
  updateCartRule,
  deleteCartRule,
  toggleCartRule,
} = require('../models/cartRulesModel');
const { evaluateCartRules } = require('../utils/cartRulesEngine');
const { listLoyaltyTiers } = require('../models/loyaltyTierModel');

// GET /api/settings/public - public: get non-sensitive settings (store info, SEO, social)
router.get('/public', async (req, res) => {
  try {
    const groups = ['general', 'seo', 'social', 'policy', 'shipping', 'gamification'];
    const result = {};
    for (const g of groups) {
      const data = await getSettingsByGroup(g);
      // Remove sensitive keys
      delete data.smtp_pass;
      Object.assign(result, data);
    }
    const cartRules = await listCartRules({ activeOnly: true });
    result.cart_rules_flat = cartRules.map(rule => ({
      id: rule.id,
      name: rule.name,
      min_cart_value: Number(rule.min_cart_value) || 0,
      max_cart_value: rule.max_cart_value === null ? null : Number(rule.max_cart_value),
      badge_text: rule.badge_text,
      free_shipping_enabled: Number(rule.free_shipping_enabled) === 1,
      enforce_min_checkout: Number(rule.enforce_min_checkout) === 1,
    }));
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to get settings' });
  }
});

router.get('/cart-rules/list', authenticateAdmin, async (req, res) => {
  try {
    res.json({ data: await listCartRules() });
  } catch (err) {
    console.error('[CART_RULES_LIST]', err);
    res.status(500).json({ code: 'CART_RULES_LOAD_FAILED', message: 'Failed to load cart rules.' });
  }
});

router.get('/cart-rules/preview', async (req, res) => {
  const subtotal = Number(req.query.subtotal);
  if (!Number.isFinite(subtotal) || subtotal < 0) {
    return res.status(400).json({ code: 'INVALID_SUBTOTAL', message: 'subtotal must be a non-negative number.' });
  }
  try {
    const rules = await listCartRules({ activeOnly: true });
    const enforceMinimum = (await getSetting('enforce_cart_rule_minimum')) === '1';
    res.json(evaluateCartRules(subtotal, rules, { enforceMinimum }));
  } catch (err) {
    console.error('[CART_RULES_PREVIEW]', err);
    res.status(500).json({ code: 'CART_RULES_PREVIEW_FAILED', message: 'Failed to preview cart rules.' });
  }
});

router.get('/cart-rules/loyalty-tiers', authenticateAdmin, async (req, res) => {
  try {
    res.json({ data: await listLoyaltyTiers({ activeOnly: true }) });
  } catch (err) {
    console.error('[CART_RULES_LOYALTY_TIERS]', err);
    res.status(500).json({ code: 'CART_RULES_TIERS_LOAD_FAILED', message: 'Failed to load loyalty tiers.' });
  }
});

router.get('/cart-rules/:id', authenticateAdmin, async (req, res) => {
  try {
    const rule = await getCartRuleById(req.params.id);
    if (!rule) return res.status(404).json({ code: 'CART_RULE_NOT_FOUND', message: 'Cart rule not found.' });
    res.json(rule);
  } catch (err) {
    console.error('[CART_RULE_GET]', err);
    res.status(500).json({ code: 'CART_RULE_LOAD_FAILED', message: 'Failed to load cart rule.' });
  }
});

router.post('/cart-rules/create', authenticateAdmin, async (req, res) => {
  try {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const minimum = Number(req.body?.min_cart_value);
    if (!name || !Number.isFinite(minimum) || minimum < 0) {
      return res.status(400).json({ code: 'INVALID_CART_RULE', message: 'Rule name and a non-negative minimum cart value are required.' });
    }
    const rule = await createCartRule({ ...req.body, name, min_cart_value: minimum });
    res.status(201).json({ data: rule });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ code: 'CART_RULE_EXISTS', message: 'A cart rule with this name already exists.' });
    console.error('[CART_RULE_CREATE]', err);
    res.status(500).json({ code: 'CART_RULE_CREATE_FAILED', message: 'Failed to create cart rule.' });
  }
});

router.put('/cart-rules/:id', authenticateAdmin, async (req, res) => {
  try {
    const rule = await updateCartRule(req.params.id, req.body || {});
    if (!rule) return res.status(404).json({ code: 'CART_RULE_NOT_FOUND', message: 'Cart rule not found.' });
    res.json({ data: rule });
  } catch (err) {
    console.error('[CART_RULE_UPDATE]', err);
    res.status(500).json({ code: 'CART_RULE_UPDATE_FAILED', message: 'Failed to update cart rule.' });
  }
});

router.patch('/cart-rules/:id/toggle', authenticateAdmin, async (req, res) => {
  try {
    const status = req.body?.status;
    if (!['active', 'inactive'].includes(status)) {
      return res.status(400).json({ code: 'INVALID_CART_RULE_STATUS', message: 'Status must be active or inactive.' });
    }
    const rule = await toggleCartRule(req.params.id, status);
    if (!rule) return res.status(404).json({ code: 'CART_RULE_NOT_FOUND', message: 'Cart rule not found.' });
    res.json({ data: rule });
  } catch (err) {
    console.error('[CART_RULE_TOGGLE]', err);
    res.status(500).json({ code: 'CART_RULE_TOGGLE_FAILED', message: 'Failed to update cart rule status.' });
  }
});

router.delete('/cart-rules/:id', authenticateAdmin, async (req, res) => {
  try {
    const deleted = await deleteCartRule(req.params.id);
    if (!deleted) return res.status(404).json({ code: 'CART_RULE_NOT_FOUND', message: 'Cart rule not found.' });
    res.json({ success: true });
  } catch (err) {
    console.error('[CART_RULE_DELETE]', err);
    res.status(500).json({ code: 'CART_RULE_DELETE_FAILED', message: 'Failed to delete cart rule.' });
  }
});

// GET /api/settings - admin: get all settings grouped
router.get('/', authenticateAdmin, async (req, res) => {
  try {
    const { rows } = await getAllSettings();
    // Group by group_name
    const grouped = {};
    rows.forEach(r => {
      if (!grouped[r.group_name]) grouped[r.group_name] = {};
      grouped[r.group_name][r.key_name] = r.value;
    });
    res.json(grouped);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to get settings' });
  }
});

// GET /api/settings/:group - admin: get settings by group
router.get('/:group', authenticateAdmin, async (req, res) => {
  try {
    const data = await getSettingsByGroup(req.params.group);
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to get settings' });
  }
});

// PUT /api/settings - admin: bulk update settings
router.put('/', authenticateAdmin, async (req, res) => {
  try {
    const data = req.body;
    if (!data || typeof data !== 'object') return res.status(400).json({ message: 'Body must be key-value object' });
    await bulkUpdateSettings(data);
    res.json({ message: 'Settings updated successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to update settings' });
  }
});

// PUT /api/settings/:key - admin: update single setting
router.put('/:key', authenticateAdmin, async (req, res) => {
  try {
    const { value } = req.body;
    await updateSetting(req.params.key, value);
    res.json({ message: 'Setting updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to update setting' });
  }
});

module.exports = router;
