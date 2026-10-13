const pool = require('../config/db');

const MODULES = Object.freeze([
  { id: 'products', name: 'Products', description: 'Product browsing and administration.', impact: 'Customers cannot browse products.' },
  { id: 'categories', name: 'Categories', description: 'Category and subcategory endpoints.', impact: 'Category navigation and management are unavailable.' },
  { id: 'search', name: 'Search', description: 'Product search endpoints.', impact: 'Customers cannot search the catalog.' },
  { id: 'recommendations', name: 'Recommendations', description: 'Personalized product recommendations.', impact: 'Recommendation widgets and endpoints are unavailable.' },
  { id: 'ai', name: 'AI services', description: 'AI assistant and generation endpoints.', impact: 'AI-powered features are unavailable.' },
  { id: 'cart', name: 'Cart', description: 'Cart read and update endpoints.', impact: 'Customers cannot view or modify carts.' },
  { id: 'orders', name: 'Orders', description: 'Order creation, history, and administration.', impact: 'Customers cannot place or view orders.' },
  { id: 'payments', name: 'Payments', description: 'Payment order creation and verification.', impact: 'Online payment flows are unavailable.' },
  { id: 'warehouse', name: 'Warehouse', description: 'Warehouse stock and fulfillment endpoints.', impact: 'Warehouse operations are unavailable.' },
  { id: 'inventory', name: 'Inventory', description: 'Inventory management endpoints.', impact: 'Inventory management is unavailable.' },
  { id: 'support', name: 'Support', description: 'Customer support tickets and replies.', impact: 'Customers and staff cannot access support tickets.' },
  { id: 'returns', name: 'Returns', description: 'Return request endpoints.', impact: 'Customers and staff cannot access return requests.' },
  { id: 'shipping', name: 'Shipping', description: 'Shipping configuration and carrier endpoints.', impact: 'Shipping rates and staff shipping tools are unavailable.' },
  { id: 'wallet', name: 'Wallet', description: 'Customer wallet endpoints.', impact: 'Wallet balances and transactions are unavailable.' },
  { id: 'coupons', name: 'Coupons', description: 'Coupon validation and administration.', impact: 'Customers cannot use coupons.' },
  { id: 'addresses', name: 'Addresses', description: 'Customer address book endpoints.', impact: 'Customers cannot add or update delivery addresses.' },
  { id: 'wishlist', name: 'Wishlist', description: 'Customer wishlist endpoints.', impact: 'Customers cannot access saved products.' },
  { id: 'reviews', name: 'Reviews', description: 'Product review endpoints.', impact: 'Customers cannot submit or browse reviews.' },
  { id: 'notifications', name: 'Notifications', description: 'Customer and admin notification endpoints.', impact: 'Notifications cannot be read or managed.' },
  { id: 'analytics', name: 'Analytics', description: 'Admin analytics endpoints.', impact: 'Analytics data is unavailable to staff.' },
  { id: 'affiliate', name: 'Affiliate', description: 'Affiliate and referral endpoints.', impact: 'Affiliate and referral features are unavailable.' },
  { id: 'flash_sales', name: 'Flash sales', description: 'Flash sale endpoints.', impact: 'Flash sale features are unavailable.' },
  { id: 'newsletter', name: 'Newsletter', description: 'Newsletter subscription endpoints.', impact: 'Newsletter subscriptions are unavailable.' },
  { id: 'gamification', name: 'Gamification', description: 'Gamification endpoints.', impact: 'Gamification features are unavailable.' },
  { id: 'tax', name: 'Tax', description: 'Tax management endpoints.', impact: 'Tax configuration is unavailable to staff.' },
  { id: 'gst', name: 'GST & books', description: 'GST accounting endpoints.', impact: 'GST accounting tools are unavailable to staff.' },
  { id: 'impact', name: 'Impact', description: 'Impact program endpoints.', impact: 'Impact program content is unavailable.' },
  { id: 'warranty', name: 'Warranty', description: 'Warranty endpoints.', impact: 'Warranty requests are unavailable.' },
  { id: 'serials', name: 'Serials', description: 'Product serial endpoints.', impact: 'Serial validation and management are unavailable.' },
]);

const isKnownModule = moduleId => MODULES.some(module => module.id === moduleId);

const getModuleStates = async () => {
  const [rows] = await pool.query(
    "SELECT key_name, value FROM settings WHERE group_name = 'system_modules'"
  );
  const enabledById = new Map(rows.map(row => [
    row.key_name.replace(/^module_/, '').replace(/_enabled$/, ''),
    row.value !== '0',
  ]));
  return MODULES.map(module => ({
    ...module,
    enabled: enabledById.get(module.id) ?? true,
    status: enabledById.get(module.id) === false ? 'paused' : 'enabled',
  }));
};

const setModuleEnabled = async (moduleId, enabled) => {
  if (!isKnownModule(moduleId)) return false;
  await pool.query(
    `INSERT INTO settings (key_name, value, group_name)
     VALUES (?, ?, 'system_modules')
     ON DUPLICATE KEY UPDATE value = VALUES(value), group_name = VALUES(group_name)`,
    [`module_${moduleId}_enabled`, enabled ? '1' : '0']
  );
  console.info(JSON.stringify({
    event: 'system.module_availability_changed',
    module: moduleId,
    enabled,
    occurredAt: new Date().toISOString(),
  }));
  return true;
};

const createModuleAvailabilityMiddleware = (moduleId, shouldCheck = () => true) =>
  async (req, res, next) => {
    if (!shouldCheck(req)) return next();
    try {
      const [rows] = await pool.query(
        'SELECT value FROM settings WHERE key_name = ? LIMIT 1',
        [`module_${moduleId}_enabled`]
      );
      if (rows[0]?.value === '0') {
        res.setHeader('Retry-After', '60');
        return res.status(503).json({
          success: false,
          code: 'MODULE_PAUSED',
          module: moduleId,
          message: 'This feature is temporarily unavailable while maintenance is in progress.',
        });
      }
      return next();
    } catch (error) {
      console.error(`[MODULE_AVAILABILITY_READ] module=${moduleId}`, error);
      return res.status(503).json({
        success: false,
        code: 'MODULE_STATUS_UNAVAILABLE',
        module: moduleId,
        message: 'Feature availability could not be verified. Please retry shortly.',
      });
    }
  };

module.exports = {
  MODULES,
  createModuleAvailabilityMiddleware,
  getModuleStates,
  isKnownModule,
  setModuleEnabled,
};
