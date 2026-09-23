const cache = new Map();
const MAX_ENTRIES = 10000;
const TTL_MS = 60 * 1000;

const markRevoked = (jti) => {
  if (!jti) return;
  const now = Date.now();
  if (cache.size >= MAX_ENTRIES) {
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  cache.set(String(jti), now + TTL_MS);
};

const isRevoked = (jti) => {
  if (!jti) return false;
  const key = String(jti);
  const expiry = cache.get(key);
  if (!expiry) return false;
  if (Date.now() > expiry) { cache.delete(key); return false; }
  return true;
};

const _cleanup = () => {
  const now = Date.now();
  for (const [k, v] of cache) if (now > v) cache.delete(k);
};

const _size = () => cache.size;

module.exports = {
  MAX_ENTRIES,
  TTL_MS,
  markRevoked,
  isRevoked,
  _cleanup,
  _size
};
