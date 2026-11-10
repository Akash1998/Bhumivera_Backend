const pool = require('../config/db');
const {
  createDefaultConfig,
  createDefaultProduct,
  getIstDayInfo,
  getIstDayRange,
  getProductSnapshot,
  normalizeStoredConfig,
  rotateConfigDay,
} = require('../utils/scarcitySimulator');

const SETTINGS_KEY = 'scarcity_simulator_config';
const SETTINGS_GROUP = 'scarcity_simulator';
const MAX_PUBLIC_PRODUCT_IDS = 100;
const RECENT_ACTIVITY_CACHE_MS = 30 * 60 * 1000;
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

// Public reads are served from memory so a sleeping/paused DB is not woken on every request.
const PUBLIC_CACHE_MS = 15 * 60 * 1000;
let configCache = null;
const activeIdsCache = new Map();

const rememberConfig = config => {
  configCache = { config: JSON.parse(JSON.stringify(config)), expiresAt: Date.now() + PUBLIC_CACHE_MS };
  return config;
};

const getCachedConfig = async () => {
  if (configCache && configCache.expiresAt > Date.now()) return configCache.config;
  try {
    return rememberConfig(await withConfig(() => false));
  } catch (error) {
    if (configCache) {
      // DB unreachable: keep serving last known config and retry in a minute.
      configCache.expiresAt = Date.now() + 60 * 1000;
      return configCache.config;
    }
    return createDefaultConfig();
  }
};

const getActiveIds = async requestedIds => {
  const now = Date.now();
  const unknown = requestedIds.filter(id => !(activeIdsCache.get(id)?.expiresAt > now));
  if (unknown.length) {
    try {
      const placeholders = unknown.map(() => '?').join(', ');
      const [rows] = await pool.query(
        `SELECT id FROM products WHERE status = 'active' AND id IN (${placeholders})`,
        unknown
      );
      const active = new Set(rows.map(row => String(row.id)));
      for (const id of unknown) {
        activeIdsCache.set(id, { active: active.has(id), expiresAt: now + PUBLIC_CACHE_MS });
      }
    } catch {
      for (const id of unknown) {
        if (!activeIdsCache.has(id)) activeIdsCache.set(id, { active: true, expiresAt: now + 60 * 1000 });
      }
    }
    if (activeIdsCache.size > 2000) activeIdsCache.clear();
  }
  return requestedIds.filter(id => activeIdsCache.get(id)?.active);
};

const getAdminConfig = async () => rememberConfig(await withConfig(() => false));

const saveAdminConfig = async nextConfig => rememberConfig(await withConfig(current => {
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
}));

const getPublicSnapshots = async productIds => {
  const requestedIds = parseProductIds(productIds);
  const ids = requestedIds.length ? await getActiveIds(requestedIds) : requestedIds;
  const config = await getCachedConfig();
  rotateConfigDay(config, new Date());
  let activityProfiles = {};
  try {
    activityProfiles = await getRecentActivityProfiles(ids);
  } catch {
    const stale = recentActivityCache.get(ids.slice().sort().join(','));
    activityProfiles = stale?.profiles || {};
  }
  return {
    enabled: config.enabled,
    sampleActivityEnabled: config.sampleActivityEnabled,
    dayKey: config.dayKey,
    label: 'Live batch allocation & dispatch status',
    products: Object.fromEntries(ids.map(id => [
      id,
      getProductSnapshot(config, id, new Date(), activityProfiles[id] || []),
    ])),
  };
};

let bestsellersCache = null;

const getTodaysBestsellers = async () => {
  if (bestsellersCache && bestsellersCache.expiresAt > Date.now()) return bestsellersCache.rows;
  try {
    const rows = await queryTodaysBestsellers();
    bestsellersCache = { rows, expiresAt: Date.now() + PUBLIC_CACHE_MS };
    return rows;
  } catch (error) {
    if (!bestsellersCache) throw error;
    bestsellersCache.expiresAt = Date.now() + 60 * 1000;
    return bestsellersCache.rows;
  }
};

const queryTodaysBestsellers = async () => {
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

const getTodayProductSales = async productIds => {
  const ids = parseProductIds(productIds);
  if (!ids.length) return { dayKey: getIstDayInfo().dayKey, products: {} };

  const range = getIstDayRange();
  const placeholders = ids.map(() => '?').join(', ');
  const [rows] = await pool.query(
    `SELECT p.id, COALESCE(SUM(CASE WHEN o.id IS NOT NULL THEN oi.quantity ELSE 0 END), 0) AS units_sold_today
     FROM products p
     LEFT JOIN order_items oi ON oi.product_id = p.id
     LEFT JOIN orders o ON o.id = oi.order_id
       AND o.created_at >= FROM_UNIXTIME(?) AND o.created_at < FROM_UNIXTIME(?)
       AND ${PURCHASE_STATUS_SQL}
     WHERE p.id IN (${placeholders}) AND p.status = 'active'
     GROUP BY p.id`,
    [range.startEpochSeconds, range.endEpochSeconds, ...ids]
  );
  const salesById = new Map(rows.map(row => [String(row.id), Number(row.units_sold_today) || 0]));

  return {
    dayKey: getIstDayInfo().dayKey,
    products: Object.fromEntries(ids.map(id => [
      id,
      { unitsOrdered: salesById.get(id) || 0 },
    ])),
  };
};

module.exports = {
  getAdminConfig,
  getPublicSnapshots,
  getTodayProductSales,
  getTodaysBestsellers,
  parseProductIds,
  saveAdminConfig,
};
