const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 330 * 60 * 1000;
const WINDOW_START_MINUTES = 60; // 01:00 AM Asia/Kolkata
const WINDOW_END_MINUTES = 23 * 60 + 45; // 23:45 PM Asia/Kolkata (1425 minutes)
const WINDOW_DURATION_MINUTES = WINDOW_END_MINUTES - WINDOW_START_MINUTES; // 1365 minutes (22 hours 45 mins)
const WINDOW_START_MS = WINDOW_START_MINUTES * 60 * 1000;
const WINDOW_DURATION_MS = WINDOW_DURATION_MINUTES * 60 * 1000;
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
  const elapsedSinceMidnight = now.getTime() - startUtc;
  const elapsedInWindow = elapsedSinceMidnight - WINDOW_START_MS;
  const progress = Math.min(1, Math.max(0, elapsedInWindow / WINDOW_DURATION_MS));
  return {
    dayKey,
    progress,
    elapsedSinceMidnight,
    windowStartMinutes: WINDOW_START_MINUTES,
    windowEndMinutes: WINDOW_END_MINUTES,
  };
};

const createDefaultProduct = () => {
  return {
    enabled: true,
    paused: false,
    outOfStock: false,
    dailyCap: DEFAULT_DAILY_CAP,
    minDailySold: 0,
    maxDailySold: DEFAULT_DAILY_CAP,
  };
};

const createDefaultConfig = (now = new Date()) => ({
  enabled: true,
  sampleActivityEnabled: false,
  resetTime: '00:00',
  windowStart: '01:00',
  windowEnd: '23:45',
  dayKey: getIstDayInfo(now).dayKey,
  products: {},
});

const getDailyTarget = (dayKey, productId, productConfig) => {
  const minimum = Math.min(productConfig.minDailySold, productConfig.dailyCap);
  const maximum = Math.max(minimum, Math.min(productConfig.maxDailySold, productConfig.dailyCap));
  const range = Math.max(0, maximum - minimum) + 1;
  const candidate = minimum + (hashString(`${dayKey}:${productId}:target`) % range);
  if (range === 1) return candidate;

  const previousDayKey = new Date(Date.parse(`${dayKey}T00:00:00Z`) - DAY_MS)
    .toISOString()
    .slice(0, 10);
  const previousTarget = minimum + (hashString(`${previousDayKey}:${productId}:target`) % range);
  return candidate === previousTarget
    ? minimum + ((candidate - minimum + 1) % range)
    : candidate;
};

const getRandom = seed => {
  let state = hashString(seed);
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
};

const getHourlyWeights = (dayKey, productId, activityProfile) => {
  const history = Array.isArray(activityProfile) ? activityProfile.slice(0, 24) : [];
  const historyTotal = history.reduce((total, value) => total + Math.max(0, Number(value) || 0), 0);
  if (historyTotal > 0) return history.map(value => Math.max(0, Number(value) || 0) + historyTotal * 0.005 / 24);

  const random = getRandom(`${dayKey}:${productId}:hourly-pattern`);
  return Array.from({ length: 24 }, () => 0.25 + random());
};

const getSalesProgress = (dayProgress, hourlyWeights) => {
  if (dayProgress <= 0) return 0;
  if (dayProgress >= 1) return 1;

  const totalWeight = hourlyWeights.reduce((total, value) => total + value, 0);
  if (totalWeight <= 0) return dayProgress;

  const elapsedMinutes = dayProgress * WINDOW_DURATION_MINUTES;
  const currentMinuteOfDay = WINDOW_START_MINUTES + elapsedMinutes;
  const currentHour = Math.min(23, Math.floor(currentMinuteOfDay / 60));
  const partialHour = (currentMinuteOfDay - currentHour * 60) / 60;

  const windowStartHour = 1;
  const startWeight = hourlyWeights.slice(0, windowStartHour).reduce((total, value) => total + value, 0);
  const endWeight = hourlyWeights.slice(0, 23).reduce((total, value) => total + value, 0) + (hourlyWeights[23] || 0) * (45 / 60);
  const activeWindowTotal = Math.max(0.0001, endWeight - startWeight);

  const accumulatedWeight = hourlyWeights.slice(0, currentHour).reduce((total, value) => total + value, 0)
    + (hourlyWeights[currentHour] || 0) * partialHour;

  const progressInWindow = Math.max(0, Math.min(activeWindowTotal, accumulatedWeight - startWeight));
  return progressInWindow / activeWindowTotal;
};

const getSampleActivity = (dayKey, productId, simulatedSoldToday, dayProgress, hourlyWeights) => {
  const eventCount = Math.min(3, simulatedSoldToday);
  if (eventCount < 1) return [];

  const cities = ['Kolkata', 'Asansol', 'Delhi'];
  const elapsedMinutes = Math.floor(dayProgress * WINDOW_DURATION_MINUTES);
  if (elapsedMinutes < 1) return [];
  const dayStart = Date.parse(`${dayKey}T00:00:00+05:30`) + WINDOW_START_MS;
  const random = getRandom(`${dayKey}:${productId}:sample-activity`);
  const eligibleHours = Math.min(23, Math.ceil(elapsedMinutes / 60));
  const weights = (hourlyWeights.slice(1, 1 + eligibleHours) || []).map((weight, hour) =>
    hour === eligibleHours - 1 && elapsedMinutes % 60
      ? weight * (elapsedMinutes % 60) / 60
      : weight
  );
  const totalWeight = weights.reduce((total, value) => total + value, 0);

  return Array.from({ length: eventCount }, (_, index) => {
    const seed = hashString(`${dayKey}:${productId}:sample:${index}`);
    let selectedWeight = random() * totalWeight;
    let hour = 0;
    for (; hour < weights.length - 1; hour += 1) {
      selectedWeight -= weights[hour];
      if (selectedWeight < 0) break;
    }
    const hourStartMinute = hour * 60;
    const hourEndMinute = Math.min(elapsedMinutes, hourStartMinute + 60);
    const minute = hourStartMinute + Math.floor(random() * Math.max(1, hourEndMinute - hourStartMinute));
    const time = new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(dayStart + minute * 60_000));

    return {
      buyer: `Verified Patron #${String(seed % 900 + 100)}`,
      city: cities[seed % cities.length],
      time,
    };
  });
};

const getProductSnapshot = (config, productId, now = new Date(), activityProfile = []) => {
  const productConfig = config.products[String(productId)] || createDefaultProduct(productId);
  const { dayKey, progress: dayProgress } = getIstDayInfo(now);
  const hourlyWeights = getHourlyWeights(dayKey, productId, activityProfile);
  const progress = getSalesProgress(dayProgress, hourlyWeights);
  const dailyTarget = getDailyTarget(dayKey, productId, productConfig);
  const simulationActive = config.enabled && productConfig.enabled && !productConfig.paused && !productConfig.outOfStock;
  const simulatedSoldToday = simulationActive
    ? Math.min(productConfig.dailyCap, Math.round(dailyTarget * progress))
    : 0;
  const soldToday = simulatedSoldToday;
  const remaining = productConfig.outOfStock
    ? 0
    : Math.max(0, productConfig.dailyCap - soldToday);

  const sampleActivity = config.sampleActivityEnabled
    ? getSampleActivity(dayKey, productId, simulatedSoldToday, dayProgress, hourlyWeights)
    : [];

  return {
    enabled: Boolean(config.enabled && productConfig.enabled),
    paused: Boolean(productConfig.paused),
    outOfStock: Boolean(productConfig.outOfStock),
    dailyCap: productConfig.dailyCap,
    soldToday,
    simulatedSoldToday,
    remaining,
    sampleActivity,
    label: 'Live batch allocation & dispatch status',
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
      const isLegacyDefaultRange = item.minDailySold === 200 &&
        item.maxDailySold === DEFAULT_DAILY_CAP &&
        dailyCap === DEFAULT_DAILY_CAP;
      const minDailySold = Number.isSafeInteger(item.minDailySold) && item.minDailySold >= 0
        ? (isLegacyDefaultRange ? defaults.minDailySold : Math.min(item.minDailySold, dailyCap))
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
      product.maxDailySold < product.minDailySold ||
      product.maxDailySold > product.dailyCap
    ) {
      return `Invalid simulator settings for product ${productId}.`;
    }
  }
  return null;
};

const rotateConfigDay = (config, now = new Date()) => {
  const currentDayKey = getIstDayInfo(now).dayKey;
  if (config.dayKey === currentDayKey) return false;
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
  WINDOW_START_MINUTES,
  WINDOW_END_MINUTES,
  WINDOW_DURATION_MINUTES,
};
