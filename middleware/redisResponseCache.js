const crypto = require('node:crypto');

const CACHE_TTL_SECONDS = 60;
const REDIS_READ_TIMEOUT_MS = 100;
const CACHE_PREFIX = 'bhumivera:response-cache:v1:';
const RATE_LIMITED_PUBLIC_PATHS = new Set([
  '/api/affiliate/referral/preview',
  '/api/search',
]);
const CACHEABLE_HEADERS = ['content-type', 'cache-control', 'content-language', 'vary'];

const redisUrl = process.env.CACHE_REDIS_URL || process.env.RATE_LIMIT_REDIS_URL;
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

const hashRequest = req => {
  const headers = Object.entries(req.headers)
    .sort(([left], [right]) => left.localeCompare(right));
  const requestKey = JSON.stringify([req.get('host'), req.originalUrl, headers]);
  return `${CACHE_PREFIX}${crypto.createHash('sha256').update(requestKey).digest('hex')}`;
};

const canCacheRequest = req => {
  const path = req.originalUrl.split('?')[0].replace(/\/+$/, '') || '/';
  const cacheControl = `${req.get('cache-control') || ''},${req.get('pragma') || ''}`;
  return req.method === 'GET' &&
    path.startsWith('/api/') &&
    !RATE_LIMITED_PUBLIC_PATHS.has(path) &&
    !req.get('authorization') &&
    !req.get('cookie') &&
    !req.user &&
    !req.auth &&
    !/\b(no-cache|no-store)\b|(?:^|,)\s*max-age\s*=\s*0(?:\s*,|$)/i.test(cacheControl);
};

const isCacheableResponse = (req, res, body) => {
  const cacheControl = String(res.getHeader('Cache-Control') || '');
  return req.method === 'GET' &&
    res.statusCode === 200 &&
    /^application\/json\b/i.test(String(res.getHeader('Content-Type') || '')) &&
    !/\b(private|no-store|no-cache)\b/i.test(cacheControl) &&
    String(res.getHeader('Vary') || '').trim() !== '*' &&
    !res.hasHeader('Set-Cookie') &&
    (typeof body === 'string' || Buffer.isBuffer(body));
};

const createRedisResponseCache = (client, {
  ttlSeconds = CACHE_TTL_SECONDS,
  logger = console,
} = {}) => (req, res, next) => {
  if (!client || !canCacheRequest(req)) return next();
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

    res.setHeader('X-Redis-Cache', 'MISS');
    const send = res.send;
    res.send = function sendWithCache(body) {
      if (isCacheableResponse(req, res, body)) {
        const headers = Object.fromEntries(CACHEABLE_HEADERS
          .filter(name => res.hasHeader(name))
          .map(name => [name, res.getHeader(name)]));
        const entry = JSON.stringify({
          statusCode: res.statusCode,
          headers,
          body: Buffer.isBuffer(body) ? body.toString('utf8') : body,
        });
        Promise.resolve().then(() => client.set(key, entry, { EX: ttlSeconds })).catch(error => {
          logger.error('[RESPONSE_CACHE_WRITE_ERROR]', error.message);
        });
      }
      return send.call(this, body);
    };
    return next();
  }).catch(error => {
    logger.error('[RESPONSE_CACHE_READ_ERROR]', error.message);
    next();
  }).finally(() => {
    clearTimeout(timeoutId);
  });
};

const connectResponseCache = async () => {
  if (!redisClient || redisClient.isOpen) return;
  await redisClient.connect();
  console.info('[RESPONSE_CACHE] Redis response cache connected.');
};

const closeResponseCache = async () => {
  if (redisClient?.isOpen) await redisClient.quit();
};

module.exports = {
  createRedisResponseCache,
  redisResponseCache: createRedisResponseCache(redisClient),
  connectResponseCache,
  closeResponseCache,
};
