const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 330 * 60 * 1000;
const DEFAULT_DAILY_CAP = 250;
const MAX_CONFIGURED_PRODUCTS = 300;

const hashString = value => {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

const getIstDayInfo = (now = new Date()) => {
  const shifted = new Date(now.getTime() + IST_OFFSET_MS);
  const dayKey = shifted.toISOString().slice(0, 10);
  const startUtc = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate()
  ) - IST_OFFSET_MS;
  return {
    dayKey,
    progress: Math.min(1, Math.max(0, (now.getTime() - startUtc) / DAY_MS)),
  };
};

const createDefaultProduct = productId => {
  const lifetimeSold = 16000 + (hashString(`lifetime:${productId}`) % 14001);
  return {
    enabled: true,
    paused: false,
    outOfStock: false,
    dailyCap: DEFAULT_DAILY_CAP,
    minDailySold: 200,
    maxDailySold: DEFAULT_DAILY_CAP,
    lifetimeSold,
  };
};

const createDefaultConfig = (now = new Date()) => ({
  enabled: true,
  sampleActivityEnabled: false,
  resetTime: '00:00',
  dayKey: getIstDayInfo(now).dayKey,
  products: {},
});

const getDailyTarget = (dayKey, productId, productConfig) => {
  const minimum = Math.min(productConfig.minDailySold, productConfig.dailyCap);
  const maximum = Math.min(productConfig.maxDailySold, productConfig.dailyCap);
  const range = Math.max(0, maximum - minimum) + 1;
  return minimum + (hashString(`${dayKey}:${productId}`) % range);
};

const getProductSnapshot = (config, productId, now = new Date(), actualUnitsToday = 0) => {
  const productConfig = config.products[String(productId)] || createDefaultProduct(productId);
  const { dayKey, progress } = getIstDayInfo(now);
  const dailyTarget = getDailyTarget(dayKey, productId, productConfig);
  const soldToday = config.enabled && productConfig.enabled && !productConfig.paused && !productConfig.outOfStock
    ? Math.min(
        productConfig.dailyCap,
        Math.round(dailyTarget * progress) + Math.max(0, Number(actualUnitsToday) || 0)
      )
    : 0;
  const remaining = productConfig.outOfStock
    ? 0
    : Math.max(0, productConfig.dailyCap - soldToday);

  return {
    enabled: Boolean(config.enabled && productConfig.enabled),
    paused: Boolean(productConfig.paused),
    outOfStock: Boolean(productConfig.outOfStock),
    dailyCap: productConfig.dailyCap,
    soldToday,
    remaining,
    lifetimeSold: productConfig.lifetimeSold + soldToday,
    label: 'Simulation — illustrative data, not live inventory or sales',
  };
};

const normalizeStoredConfig = (value, now = new Date()) => {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = null;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return createDefaultConfig(now);
  }

  const config = createDefaultConfig(now);
  config.enabled = parsed.enabled !== false;
  config.sampleActivityEnabled = parsed.sampleActivityEnabled === true;
  config.dayKey = /^\d{4}-\d{2}-\d{2}$/.test(parsed.dayKey || '')
    ? parsed.dayKey
    : config.dayKey;
  config.products = {};
  if (parsed.products && typeof parsed.products === 'object' && !Array.isArray(parsed.products)) {
    for (const [productId, item] of Object.entries(parsed.products)) {
      if (!/^[1-9]\d*$/.test(productId) || !item || typeof item !== 'object') continue;
      const defaults = createDefaultProduct(productId);
      const dailyCap = Number.isSafeInteger(item.dailyCap) && item.dailyCap >= 0 && item.dailyCap <= DEFAULT_DAILY_CAP
        ? item.dailyCap
        : defaults.dailyCap;
      const minDailySold = Number.isSafeInteger(item.minDailySold) && item.minDailySold >= 0
        ? Math.max(Math.min(200, dailyCap), Math.min(item.minDailySold, dailyCap))
        : Math.min(defaults.minDailySold, dailyCap);
      const maxDailySold = Number.isSafeInteger(item.maxDailySold) && item.maxDailySold >= minDailySold
        ? Math.min(item.maxDailySold, dailyCap)
        : Math.max(minDailySold, Math.min(defaults.maxDailySold, dailyCap));
      config.products[productId] = {
        enabled: item.enabled !== false,
        paused: item.paused === true,
        outOfStock: item.outOfStock === true,
        dailyCap,
        minDailySold,
        maxDailySold,
        lifetimeSold: Number.isSafeInteger(item.lifetimeSold) && item.lifetimeSold >= 0
          ? item.lifetimeSold
          : defaults.lifetimeSold,
      };
    }
  }
  return config;
};

const validateSimulatorConfig = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 'A simulator configuration object is required.';
  }
  if (typeof value.enabled !== 'boolean' || typeof value.sampleActivityEnabled !== 'boolean') {
    return 'Simulator and sample activity controls must be boolean values.';
  }
  if (!value.products || typeof value.products !== 'object' || Array.isArray(value.products)) {
    return 'Per-product simulator settings are required.';
  }
  const entries = Object.entries(value.products);
  if (entries.length > MAX_CONFIGURED_PRODUCTS) return `At most ${MAX_CONFIGURED_PRODUCTS} products can be configured.`;
  for (const [productId, product] of entries) {
    if (!/^[1-9]\d*$/.test(productId) || !product || typeof product !== 'object' || Array.isArray(product)) {
      return 'Each product configuration must use a positive numeric product ID.';
    }
    if (
      typeof product.enabled !== 'boolean' ||
      typeof product.paused !== 'boolean' ||
      typeof product.outOfStock !== 'boolean' ||
      !Number.isSafeInteger(product.dailyCap) ||
      product.dailyCap < 0 ||
      product.dailyCap > DEFAULT_DAILY_CAP ||
      !Number.isSafeInteger(product.minDailySold) ||
      !Number.isSafeInteger(product.maxDailySold) ||
      product.minDailySold < 0 ||
      product.minDailySold < Math.min(200, product.dailyCap) ||
      product.maxDailySold < product.minDailySold ||
      product.maxDailySold > product.dailyCap ||
      !Number.isSafeInteger(product.lifetimeSold) ||
      product.lifetimeSold < 0
    ) {
      return `Invalid simulator settings for product ${productId}.`;
    }
  }
  return null;
};

const rotateConfigDay = (config, now = new Date(), actualUnitsByProduct = {}) => {
  const currentDayKey = getIstDayInfo(now).dayKey;
  if (config.dayKey === currentDayKey) return false;
  for (const [productId, product] of Object.entries(config.products)) {
    if (config.enabled && product.enabled && !product.paused && !product.outOfStock) {
      const simulatedTarget = getDailyTarget(config.dayKey, productId, product);
      const combinedSold = Math.min(
        product.dailyCap,
        simulatedTarget + Math.max(0, Number(actualUnitsByProduct[productId]) || 0)
      );
      product.lifetimeSold += combinedSold;
    }
  }
  config.dayKey = currentDayKey;
  return true;
};

const getIstDayRangeForDayKey = dayKey => {
  const [year, month, day] = dayKey.split('-').map(Number);
  const start = Date.UTC(year, month - 1, day) - IST_OFFSET_MS;
  const formatSqlDateTime = timestamp => new Date(timestamp)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
  return {
    start: formatSqlDateTime(start),
    end: formatSqlDateTime(start + DAY_MS),
    startEpochSeconds: Math.floor(start / 1000),
    endEpochSeconds: Math.floor((start + DAY_MS) / 1000),
  };
};

const getIstDayRange = (now = new Date()) => getIstDayRangeForDayKey(getIstDayInfo(now).dayKey);

module.exports = {
  createDefaultConfig,
  createDefaultProduct,
  getDailyTarget,
  getIstDayInfo,
  getIstDayRange,
  getIstDayRangeForDayKey,
  getProductSnapshot,
  normalizeStoredConfig,
  rotateConfigDay,
  validateSimulatorConfig,
};
