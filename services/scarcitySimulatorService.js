const pool = require('../config/db');
const {
  createDefaultConfig,
  createDefaultProduct,
  getIstDayRange,
  getProductSnapshot,
  normalizeStoredConfig,
  rotateConfigDay,
} = require('../utils/scarcitySimulator');

const SETTINGS_KEY = 'scarcity_simulator_config';
const SETTINGS_GROUP = 'scarcity_simulator';
const MAX_PUBLIC_PRODUCT_IDS = 100;
const RECENT_ACTIVITY_CACHE_MS = 5 * 60 * 1000;
const PURCHASE_STATUS_SQL = `o.status NOT IN ('cancelled', 'returned', 'archived')
  AND (o.payment_status = 'paid' OR o.payment_mode = 'COD')`;
const recentActivityCache = new Map();

const parseProductIds = value => {
  if (!Array.isArray(value)) return [];
  const ids = [...new Set(value.map(item => String(item)))];
  if (
    ids.length > MAX_PUBLIC_PRODUCT_IDS ||
    ids.some(id => !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)))
  ) {
    const error = new Error(`Request up to ${MAX_PUBLIC_PRODUCT_IDS} valid product IDs.`);
    error.status = 400;
    throw error;
  }
  return ids;
};

const getRecentActivityProfiles = async productIds => {
  if (!productIds.length) return {};
  const key = productIds.slice().sort().join(',');
  const cached = recentActivityCache.get(key);
  if (cached?.expiresAt > Date.now()) return cached.profiles;

  const placeholders = productIds.map(() => '?').join(', ');
  const [rows] = await pool.query(
    `SELECT oi.product_id,
            HOUR(CONVERT_TZ(o.created_at, @@session.time_zone, '+05:30')) AS order_hour,
            SUM(oi.quantity) AS units_ordered
     FROM orders o
     JOIN order_items oi ON oi.order_id = o.id
     WHERE oi.product_id IN (${placeholders})
       AND o.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
       AND ${PURCHASE_STATUS_SQL}
     GROUP BY oi.product_id, order_hour`,
    productIds
  );
  const profiles = {};
  for (const row of rows) {
    const id = String(row.product_id);
    const hour = Number(row.order_hour);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) continue;
    if (!profiles[id]) profiles[id] = Array(24).fill(0);
    profiles[id][hour] = Number(row.units_ordered) || 0;
  }
  const now = Date.now();
  for (const [cachedKey, entry] of recentActivityCache) {
    if (entry.expiresAt <= now) recentActivityCache.delete(cachedKey);
  }
  recentActivityCache.set(key, { expiresAt: now + RECENT_ACTIVITY_CACHE_MS, profiles });
  if (recentActivityCache.size > 50) {
    recentActivityCache.delete(recentActivityCache.keys().next().value);
  }
  return profiles;
};

const withConfig = async mutate => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query(
      `INSERT IGNORE INTO settings (key_name, value, group_name)
       VALUES (?, ?, ?)`,
      [SETTINGS_KEY, JSON.stringify(createDefaultConfig()), SETTINGS_GROUP]
    );
    const [[row]] = await connection.query(
      'SELECT value FROM settings WHERE key_name = ? FOR UPDATE',
      [SETTINGS_KEY]
    );
    const config = normalizeStoredConfig(row?.value);
    const dayChanged = rotateConfigDay(config, new Date());
    const configChanged = mutate(config) === true;
    const changed = dayChanged || configChanged;
    if (changed) {
      await connection.query(
        'UPDATE settings SET value = ?, group_name = ? WHERE key_name = ?',
        [JSON.stringify(config), SETTINGS_GROUP, SETTINGS_KEY]
      );
    }
    await connection.commit();
    return config;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
};

const getAdminConfig = () => withConfig(() => false);

const saveAdminConfig = nextConfig => withConfig(current => {
  const products = {};
  for (const [productId, item] of Object.entries(nextConfig.products)) {
    const currentProduct = current.products[productId] || createDefaultProduct(productId);
    products[productId] = {
      ...currentProduct,
      ...item,
    };
  }
  current.enabled = nextConfig.enabled;
  current.sampleActivityEnabled = nextConfig.sampleActivityEnabled;
  current.products = products;
  return true;
});

const getPublicSnapshots = async productIds => {
  const requestedIds = parseProductIds(productIds);
  let ids = requestedIds;
  if (requestedIds.length) {
    const placeholders = requestedIds.map(() => '?').join(', ');
    const [rows] = await pool.query(
      `SELECT id FROM products WHERE status = 'active' AND id IN (${placeholders})`,
      requestedIds
    );
    ids = rows.map(row => String(row.id));
  }
  const config = await withConfig(current => {
    let changed = false;
    for (const productId of ids) {
      if (!current.products[productId]) {
        current.products[productId] = createDefaultProduct(productId);
        changed = true;
      }
    }
    return changed;
  });
  const activityProfiles = await getRecentActivityProfiles(ids);
  return {
    enabled: config.enabled,
    sampleActivityEnabled: config.sampleActivityEnabled,
    dayKey: config.dayKey,
    label: 'Simulation — Live data, not live inventory or sales',
    products: Object.fromEntries(ids.map(id => [
      id,
      getProductSnapshot(config, id, new Date(), activityProfiles[id] || []),
    ])),
  };
};

const getTodaysBestsellers = async () => {
  const range = getIstDayRange();
  const [rows] = await pool.query(
    `SELECT p.id, p.name, p.slug, SUM(oi.quantity) AS units_ordered
     FROM orders o
     JOIN order_items oi ON oi.order_id = o.id
     JOIN products p ON p.id = oi.product_id
     WHERE o.created_at >= FROM_UNIXTIME(?) AND o.created_at < FROM_UNIXTIME(?)
       AND p.status = 'active'
       AND ${PURCHASE_STATUS_SQL}
     GROUP BY p.id, p.name, p.slug
     HAVING SUM(oi.quantity) > 0
     ORDER BY units_ordered DESC, p.name ASC
     LIMIT 6`,
    [range.startEpochSeconds, range.endEpochSeconds]
  );
  return rows.map(row => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    unitsOrdered: Number(row.units_ordered) || 0,
  }));
};

module.exports = {
  getAdminConfig,
  getPublicSnapshots,
  getTodaysBestsellers,
  parseProductIds,
  saveAdminConfig,
};
