const crypto = require('node:crypto');

const CACHE_TTL_SECONDS = 60;
const REDIS_READ_TIMEOUT_MS = 100;
const MAX_CACHEABLE_RESPONSE_BYTES = 1024 * 1024;
const CACHE_PREFIX = 'bhumivera:response-cache:v2:';
const EDGE_CACHE_CONTROL = 'public, max-age=0, s-maxage=30, stale-while-revalidate=30';
const RATE_LIMITED_PUBLIC_PATHS = new Set([
  '/api/affiliate/referral/preview',
  '/api/search',
]);
const CACHEABLE_PUBLIC_PATHS = [
  '/api/products/active',
  '/api/categories',
  '/api/subcategories',
  '/api/flash-sales',
];
const CACHEABLE_HEADERS = ['content-type', 'cache-control', 'content-language', 'vary'];
const CACHE_KEY_HEADERS = ['accept', 'accept-language', 'accept-encoding', 'origin'];

const redisUrl = process.env.CACHE_REDIS_URL || process.env.RATE_LIMIT_REDIS_URL || process.env.REDIS_URL;
const redisClient = redisUrl
  ? require('redis').createClient({ url: redisUrl })
  : null;

if (redisClient) {
  redisClient.on('error', error => {
    console.error('[RESPONSE_CACHE_REDIS_ERROR]', error.message);
  });
} else if (process.env.NODE_ENV === 'production') {
  console.warn('[RESPONSE_CACHE] CACHE_REDIS_URL is not configured; response caching is disabled.');
}

const cacheMetrics = {
  hits: 0,
  misses: 0,
  readErrors: 0,
  writeErrors: 0,
  skippedLargeResponses: 0,
  writes: 0,
};

const hashRequest = req => {
  const headers = CACHE_KEY_HEADERS.map(name => [name, req.get(name) || '']);
  const requestKey = JSON.stringify([req.get('host'), req.originalUrl, headers]);
  return `${CACHE_PREFIX}${crypto.createHash('sha256').update(requestKey).digest('hex')}`;
};

const canCacheRequest = req => {
  const path = req.originalUrl.split('?')[0].replace(/\/+$/, '') || '/';
  const cacheControl = `${req.get('cache-control') || ''},${req.get('pragma') || ''}`;
  return req.method === 'GET' &&
    path.startsWith('/api/') &&
    (CACHEABLE_PUBLIC_PATHS.some(prefix => path === prefix || path.startsWith(`${prefix}/`)) ||
      path.startsWith('/api/products/slug/') ||
      /^\/api\/products\/\d+$/.test(path)) &&
    !RATE_LIMITED_PUBLIC_PATHS.has(path) &&
    !req.get('authorization') &&
    !req.get('cookie') &&
    !req.user &&
    !req.auth &&
    !/\b(no-cache|no-store)\b|(?:^|,)\s*max-age\s*=\s*0(?:\s*,|$)/i.test(cacheControl);
};

const isCacheableResponse = (req, res, body) => {
  const cacheControl = String(res.getHeader('Cache-Control') || '');
  const varyHeaders = String(res.getHeader('Vary') || '')
    .split(',')
    .map(name => name.trim().toLowerCase())
    .filter(Boolean);
  return req.method === 'GET' &&
    res.statusCode === 200 &&
    /^application\/json\b/i.test(String(res.getHeader('Content-Type') || '')) &&
    !/\b(private|no-store|no-cache)\b/i.test(cacheControl) &&
    !varyHeaders.includes('*') &&
    varyHeaders.every(name => CACHE_KEY_HEADERS.includes(name)) &&
    !res.hasHeader('Set-Cookie') &&
    (typeof body === 'string' || Buffer.isBuffer(body));
};

const createRedisResponseCache = (client, {
  ttlSeconds = CACHE_TTL_SECONDS,
  logger = console,
} = {}) => (req, res, next) => {
  if (!canCacheRequest(req)) return next();

  const json = res.json;
  res.json = function jsonWithPublicCacheHeaders(body) {
    if (res.statusCode === 200 && !res.hasHeader('Cache-Control')) {
      res.setHeader('Cache-Control', EDGE_CACHE_CONTROL);
    }
    return json.call(this, body);
  };

  if (!client) return next();
  if (typeof client.isReady === 'boolean' && !client.isReady) return next();

  const key = hashRequest(req);
  let timeoutId;
  const readTimeout = new Promise((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error('Redis response-cache read timed out.')),
      REDIS_READ_TIMEOUT_MS
    );
    timeoutId.unref?.();
  });
  Promise.race([
    Promise.resolve().then(() => client.get(key)),
    readTimeout,
  ]).then(cached => {
    if (cached) {
      try {
        const entry = JSON.parse(cached);
        if (entry.statusCode === 200 && typeof entry.body === 'string' &&
            entry.headers && typeof entry.headers === 'object') {
          cacheMetrics.hits += 1;
          for (const name of CACHEABLE_HEADERS) {
            const value = entry.headers[name];
            if (typeof value === 'string' ||
                (Array.isArray(value) && value.every(item => typeof item === 'string'))) {
              res.setHeader(name, value);
            }
          }
          res.setHeader('X-Redis-Cache', 'HIT');
          return res.status(entry.statusCode).send(entry.body);
        }
      } catch (error) {
        logger.error('[RESPONSE_CACHE_INVALID_ENTRY]', error.message);
      }
    }

    cacheMetrics.misses += 1;
    res.setHeader('X-Redis-Cache', 'MISS');
    const send = res.send;
    res.send = function sendWithCache(body) {
      if (isCacheableResponse(req, res, body)) {
        const bodyBytes = Buffer.isBuffer(body) ? body.length : Buffer.byteLength(body);
        if (bodyBytes > MAX_CACHEABLE_RESPONSE_BYTES) {
          cacheMetrics.skippedLargeResponses += 1;
          return send.call(this, body);
        }
        const headers = Object.fromEntries(CACHEABLE_HEADERS
          .filter(name => res.hasHeader(name))
          .map(name => [name, res.getHeader(name)]));
        const entry = JSON.stringify({
          statusCode: res.statusCode,
          headers,
          body: Buffer.isBuffer(body) ? body.toString('utf8') : body,
        });
        Promise.resolve().then(() => client.set(key, entry, { EX: ttlSeconds })).then(() => {
          cacheMetrics.writes += 1;
        }).catch(error => {
          cacheMetrics.writeErrors += 1;
          logger.error('[RESPONSE_CACHE_WRITE_ERROR]', error.message);
        });
      }
      return send.call(this, body);
    };
    return next();
  }).catch(error => {
    cacheMetrics.readErrors += 1;
    logger.error('[RESPONSE_CACHE_READ_ERROR]', error.message);
    next();
  }).finally(() => {
    clearTimeout(timeoutId);
  });
};

let responseCacheConnectionPromise;

const connectResponseCache = async () => {
  if (!redisClient || redisClient.isReady) return;
  if (!responseCacheConnectionPromise) {
    responseCacheConnectionPromise = (async () => {
      if (!redisClient.isOpen) {
        await redisClient.connect();
      } else {
        await new Promise((resolve, reject) => {
          const onReady = () => {
            redisClient.off('error', onError);
            resolve();
          };
          const onError = error => {
            redisClient.off('ready', onReady);
            reject(error);
          };
          redisClient.once('ready', onReady);
          redisClient.once('error', onError);
        });
      }
      console.info('[RESPONSE_CACHE] Redis response cache connected.');
    })().finally(() => {
      responseCacheConnectionPromise = null;
    });
  }
  await responseCacheConnectionPromise;
};

const closeResponseCache = async () => {
  if (redisClient?.isOpen) await redisClient.quit();
};

const getResponseCacheStatus = () => ({
  status: !redisClient ? 'not_configured' : redisClient.isReady ? 'connected' : 'configured_but_disconnected',
  configured: Boolean(redisClient),
  ttlSeconds: CACHE_TTL_SECONDS,
  maxCacheableResponseBytes: MAX_CACHEABLE_RESPONSE_BYTES,
  metrics: {
    ...cacheMetrics,
    hitRatePercent: cacheMetrics.hits + cacheMetrics.misses
      ? Number(((cacheMetrics.hits / (cacheMetrics.hits + cacheMetrics.misses)) * 100).toFixed(2))
      : 0,
  },
});

module.exports = {
  createRedisResponseCache,
  redisResponseCache: createRedisResponseCache(redisClient),
  connectResponseCache,
  closeResponseCache,
  getResponseCacheStatus,
};
