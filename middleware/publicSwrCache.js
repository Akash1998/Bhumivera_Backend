const crypto = require('node:crypto');
const http = require('node:http');

const MINUTE = 60 * 1000;
const FRESH_MS = Number(process.env.PUBLIC_CACHE_FRESH_MS) || 30 * MINUTE;
const MAX_STALE_MS = Number(process.env.PUBLIC_CACHE_MAX_STALE_MS) || 7 * 24 * 60 * MINUTE;
const MAX_ENTRIES = 300;
// Total byte budget: keys include query strings, so unique URLs could otherwise fill ~1 GB.
const MAX_TOTAL_BYTES = Number(process.env.PUBLIC_CACHE_MAX_BYTES) || 24 * 1024 * 1024;
const MAX_BODY_BYTES = 1024 * 1024;
const REFRESH_FAILURE_COOLDOWN_MS = MINUTE;
const BROWSER_CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=600';
const REFRESH_HEADER = 'x-swr-refresh';
const REFRESH_SECRET = crypto.randomBytes(24).toString('hex');

// Only anonymous-safe GET endpoints: responses never depend on the logged-in user.
const CACHE_RULES = [
  { re: /^\/api\/products\/(active|regimen-bundles)$/ },
  { re: /^\/api\/products\/slug\/[^/]+$/ },
  { re: /^\/api\/products\/\d+(\/qa)?$/ },
  { re: /^\/api\/categories(\/\d+)?$/ },
  { re: /^\/api\/subcategories(\/\d+|\/by-category\/\d+)?$/ },
  { re: /^\/api\/flash-sales(\/active)?$/, freshMs: 5 * MINUTE },
  { re: /^\/api\/impact\/public$/ },
  { re: /^\/api\/reviews\/(product|combo)\/[^/]+$/ },
  { re: /^\/api\/reviews\/public-stories$/ },
  { re: /^\/api\/shipping(\/zones\/active)?$/ },
  {
    re: /^\/api\/settings\/(public|catalog-availability|catalog-highlights|scarcity-simulator\/(public|popular-today))$/,
  },
];

// Writes here are high-frequency per-user noise and cannot change cached public data.
const NON_INVALIDATING_PREFIXES = [
  '/api/client-log', '/api/logs', '/api/analytics', '/api/auth', '/api/cart', '/api/wishlist',
  '/api/notifications', '/api/newsletter', '/api/support', '/api/contact', '/api/ai',
  '/api/addresses', '/api/users', '/api/wallet', '/api/recommendations',
];

const WARMUP_PATHS = [
  '/api/products/active',
  '/api/categories',
  '/api/subcategories',
  '/api/flash-sales',
  '/api/settings/public',
  '/api/settings/catalog-availability',
  '/api/settings/catalog-highlights',
  '/api/impact/public',
  '/api/shipping',
  '/api/reviews/public-stories',
];

const pathOf = req => (req.originalUrl.split('?')[0].replace(/\/+$/, '') || '/');
const findRule = path => CACHE_RULES.find(rule => rule.re.test(path));
const keyOf = req => req.originalUrl;

const isRefreshRequest = req => req.get(REFRESH_HEADER) === REFRESH_SECRET;

const sendEntry = (res, entry, state) => {
  res.setHeader('Content-Type', entry.contentType);
  res.setHeader('Cache-Control', BROWSER_CACHE_CONTROL);
  res.setHeader('X-Public-Cache', state);
  return res.status(200).send(entry.body);
};

const createPublicSwrCache = ({ getPort, isDatabaseReady = () => true } = {}) => {
  const store = new Map();
  const refreshing = new Set();
  const refreshCooldown = new Map();
  const stats = { hits: 0, stale: 0, misses: 0, refreshes: 0, refreshFailures: 0, invalidations: 0 };

  let totalBytes = 0;
  const drop = key => {
    const old = store.get(key);
    if (old) totalBytes -= old.size;
    store.delete(key);
  };
  const remember = (key, entry) => {
    drop(key);
    entry.size = Buffer.byteLength(entry.body);
    store.set(key, entry);
    totalBytes += entry.size;
    while (store.size > MAX_ENTRIES || totalBytes > MAX_TOTAL_BYTES) drop(store.keys().next().value);
  };
  const clearStore = () => {
    store.clear();
    totalBytes = 0;
  };

  const refresh = (req, key) => {
    const port = getPort?.();
    if (!port || refreshing.has(key) || (refreshCooldown.get(key) || 0) > Date.now()) return;
    refreshing.add(key);
    stats.refreshes += 1;
    const fail = () => {
      stats.refreshFailures += 1;
      if (refreshCooldown.size >= MAX_ENTRIES) refreshCooldown.delete(refreshCooldown.keys().next().value);
      refreshCooldown.set(key, Date.now() + REFRESH_FAILURE_COOLDOWN_MS);
    };
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: req.originalUrl,
      method: 'GET',
      timeout: 30000,
      headers: {
        host: req.get('host') || '',
        accept: 'application/json',
        'x-forwarded-proto': 'https',
        [REFRESH_HEADER]: REFRESH_SECRET,
      },
    }, response => {
      response.resume();
      response.on('end', () => {
        if (response.statusCode !== 200) fail();
        refreshing.delete(key);
      });
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => {
      fail();
      refreshing.delete(key);
    });
    request.end();
  };

  const middleware = (req, res, next) => {
    if (req.method !== 'GET') {
      const path = pathOf(req);
      if (path.startsWith('/api/') && !NON_INVALIDATING_PREFIXES.some(prefix => path.startsWith(prefix))) {
        res.on('finish', () => {
          if (res.statusCode < 400 && store.size) {
            clearStore();
            refreshCooldown.clear();
            stats.invalidations += 1;
          }
        });
      }
      return next();
    }

    const rule = findRule(pathOf(req));
    if (!rule) return next();

    const key = keyOf(req);
    const forcedRefresh = isRefreshRequest(req);
    const entry = forcedRefresh ? null : store.get(key);

    if (entry) {
      const age = Date.now() - entry.storedAt;
      if (age <= (rule.freshMs || FRESH_MS)) {
        stats.hits += 1;
        return sendEntry(res, entry, 'HIT');
      }
      if (age <= MAX_STALE_MS) {
        stats.stale += 1;
        refresh(req, key);
        return sendEntry(res, entry, 'STALE');
      }
      drop(key);
    }

    if (!forcedRefresh) stats.misses += 1;
    const send = res.send;
    res.send = function sendAndCache(body) {
      const contentType = String(res.getHeader('Content-Type') || '');
      const text = Buffer.isBuffer(body) ? body.toString('utf8') : body;
      if (
        res.statusCode === 200 &&
        /^application\/json\b/i.test(contentType) &&
        typeof text === 'string' &&
        Buffer.byteLength(text) <= MAX_BODY_BYTES
      ) {
        remember(key, { body: text, contentType, storedAt: Date.now() });
        res.setHeader('Cache-Control', BROWSER_CACHE_CONTROL);
      }
      res.setHeader('X-Public-Cache', forcedRefresh ? 'REFRESH' : 'MISS');
      return send.call(this, body);
    };
    return next();
  };

  middleware.warmUp = () => {
    const port = getPort?.();
    if (!port || !isDatabaseReady()) return;
    for (const path of WARMUP_PATHS) {
      refresh({ originalUrl: path, get: () => '' }, path);
    }
  };
  middleware.clear = clearStore;
  middleware.stats = () => ({ ...stats, entries: store.size, bytes: totalBytes });
  return middleware;
};

module.exports = { createPublicSwrCache, CACHE_RULES, WARMUP_PATHS };
