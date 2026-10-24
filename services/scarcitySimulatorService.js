const pool = require('../config/db');
const {
  createDefaultConfig,
  createDefaultProduct,
  getIstDayInfo,
  getIstDayRangeForDayKey,
  getIstDayRange,
  getProductSnapshot,
  normalizeStoredConfig,
  rotateConfigDay,
} = require('../utils/scarcitySimulator');

const SETTINGS_KEY = 'scarcity_simulator_config';
const SETTINGS_GROUP = 'scarcity_simulator';
const MAX_PUBLIC_PRODUCT_IDS = 100;
const PURCHASE_STATUS_SQL = `o.status NOT IN ('cancelled', 'returned', 'archived')
  AND (o.payment_status = 'paid' OR o.payment_mode = 'COD')`;

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

const getActualUnitsByProduct = async (productIds, range, queryConnection = pool) => {
  if (!productIds.length) return {};
  const placeholders = productIds.map(() => '?').join(', ');
  const [rows] = await queryConnection.query(
    `SELECT oi.product_id, SUM(oi.quantity) AS units_ordered
     FROM orders o
     JOIN order_items oi ON oi.order_id = o.id
     WHERE oi.product_id IN (${placeholders})
       AND o.created_at >= FROM_UNIXTIME(?) AND o.created_at < FROM_UNIXTIME(?)
       AND ${PURCHASE_STATUS_SQL}
     GROUP BY oi.product_id`,
    [...productIds, range.startEpochSeconds, range.endEpochSeconds]
  );
  return Object.fromEntries(rows.map(row => [
    String(row.product_id),
    Number(row.units_ordered) || 0,
  ]));
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
    const previousDay = config.dayKey;
    const currentDay = getIstDayInfo().dayKey;
    const previousActualUnits = previousDay !== currentDay
      ? await getActualUnitsByProduct(
          Object.keys(config.products),
          getIstDayRangeForDayKey(previousDay),
          connection
        )
      : {};
    const dayChanged = rotateConfigDay(config, new Date(), previousActualUnits);
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
  const actualUnits = await getActualUnitsByProduct(
    ids,
    getIstDayRange()
  );
  return {
    enabled: config.enabled,
    sampleActivityEnabled: config.sampleActivityEnabled,
    dayKey: config.dayKey,
    label: 'Simulation —Live Sales, not live inventory or sales',
    products: Object.fromEntries(ids.map(id => [
      id,
      getProductSnapshot(config, id, new Date(), actualUnits[id] || 0),
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
