const crypto = require('crypto');
const net = require('net');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = rateLimit;

const FIFTEEN_MINUTES = 15 * 60 * 1000;
const TEN_MINUTES = 10 * 60 * 1000;

function getLoginIpKey(ip, normalizedIp = ipKeyGenerator(ip, 56)) {
  const address = String(ip || '');
  if (net.isIP(address) === 4) return `v4:${address}`;
  if (net.isIP(address) !== 6) return `unknown:${address}`;

  const normalized = address.toLowerCase();
  const mappedIpv4 = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mappedIpv4) return `v4:${mappedIpv4[1]}`;
  return `v6:${normalizedIp}`;
}

const normalizeEmail = req => typeof req.body?.email === 'string'
  ? req.body.email.trim().toLowerCase()
  : '';
const hashEmail = email => crypto.createHash('sha256').update(email).digest('hex');
const accountNetworkKey = (req, normalizedIp) =>
  `${getLoginIpKey(req.ip, normalizedIp)}:${hashEmail(normalizeEmail(req))}`;
const retryAfterSeconds = (req, windowMs) => {
  const resetAt = req.rateLimit?.resetTime?.getTime?.();
  return resetAt
    ? Math.max(1, Math.ceil((resetAt - Date.now()) / 1000))
    : Math.ceil(windowMs / 1000);
};

const createRateLimitHandler = ({ code, message, windowMs, userAction }) =>
  (req, res) => {
    const seconds = retryAfterSeconds(req, windowMs);
    res.setHeader('Retry-After', String(seconds));
    return res.status(429).json({
      code,
      message,
      retryAfterSeconds: seconds,
      ...(userAction ? { userAction } : {}),
    });
  };

const rateLimitRedisUrl = process.env.RATE_LIMIT_REDIS_URL || process.env.REDIS_URL;
const sharedRedisClient = rateLimitRedisUrl
  ? require('redis').createClient({ url: rateLimitRedisUrl })
  : null;

if (sharedRedisClient) {
  sharedRedisClient.on('error', error => {
    console.error('[RATE_LIMIT_REDIS_ERROR]', error.message);
  });
} else if (process.env.NODE_ENV === 'production') {
  console.warn('[RATE_LIMIT_STORE] RATE_LIMIT_REDIS_URL is not configured; rate limits use process-local memory.');
}

async function connectRateLimitStore() {
  if (!sharedRedisClient || sharedRedisClient.isOpen) return;
  await sharedRedisClient.connect();
  console.info('[RATE_LIMIT_STORE] Shared Redis rate-limit storage connected.');
}

async function closeRateLimitStore() {
  if (sharedRedisClient?.isOpen) await sharedRedisClient.quit();
}

function getRateLimitStoreStatus() {
  return {
    status: !sharedRedisClient ? 'process_local' : sharedRedisClient.isReady ? 'connected' : 'configured_but_disconnected',
    configured: Boolean(sharedRedisClient),
    sharedAcrossInstances: Boolean(sharedRedisClient),
  };
}

function createLimiter(name, {
  windowMs,
  max,
  message,
  code,
  keyGenerator,
  skipSuccessfulRequests = false,
  ignoreServerErrors = false,
  userAction,
  store,
}) {
  const options = {
    windowMs,
    limit: max,
    keyGenerator,
    skipSuccessfulRequests,
    requestWasSuccessful: (_req, res) =>
      res.statusCode < 400 || (ignoreServerErrors && res.statusCode >= 500),
    standardHeaders: true,
    legacyHeaders: false,
    passOnStoreError: false,
    handler: createRateLimitHandler({ code, message, windowMs, userAction }),
  };
  if (store) {
    options.store = store;
  } else if (sharedRedisClient) {
    const { RedisStore } = require('rate-limit-redis');
    options.store = new RedisStore({
      prefix: `bhumivera:rate-limit:${name}:`,
      sendCommand: (...args) => sharedRedisClient.sendCommand(args),
    });
  }
  return rateLimit(options);
}

const registerLimiter = createLimiter('register', {
  windowMs: 60 * 60 * 1000,
  max: 100,
  keyGenerator: req => getLoginIpKey(req.ip, ipKeyGenerator(req.ip, 56)),
  code: 'REGISTER_NETWORK_LIMIT',
  message: 'Too many accounts have been created from this network.',
});

const referralPreviewLimiter = createLimiter('referral-preview', {
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: req => getLoginIpKey(req.ip, ipKeyGenerator(req.ip, 56)),
  code: 'REFERRAL_PREVIEW_LIMIT',
  message: 'Too many referral lookups. Please wait before checking another code.',
  userAction: 'Wait a minute, then try again.',
});

const loginLimiter = createLimiter('login-account', {
  windowMs: FIFTEEN_MINUTES,
  max: 5,
  skipSuccessfulRequests: true,
  ignoreServerErrors: true,
  keyGenerator: req => accountNetworkKey(req, ipKeyGenerator(req.ip, 56)),
  code: 'LOGIN_ATTEMPTS_LIMIT',
  message: 'Too many unsuccessful sign-in attempts for this account from this network.',
  userAction: 'Wait for the retry interval to expire before trying again.',
});

const loginIpLimiter = createLimiter('login-network', {
  windowMs: FIFTEEN_MINUTES,
  max: 100,
  skipSuccessfulRequests: true,
  ignoreServerErrors: true,
  keyGenerator: req => getLoginIpKey(req.ip, ipKeyGenerator(req.ip, 56)),
  code: 'LOGIN_NETWORK_LIMIT',
  message: 'Too many unsuccessful sign-in attempts from this network.',
  userAction: 'Wait for the retry interval to expire before trying again.',
});

const otpRequestLimiter = createLimiter('otp-request-account-network', {
  windowMs: FIFTEEN_MINUTES,
  max: 10,
  keyGenerator: req => accountNetworkKey(req, ipKeyGenerator(req.ip, 56)),
  code: 'OTP_REQUEST_LIMIT',
  message: 'Too many OTP requests for this account from this network.',
  userAction: 'Request a new code after the retry interval expires.',
});

const otpVerificationLimiter = createLimiter('otp-verification-account-network', {
  windowMs: FIFTEEN_MINUTES,
  max: 10,
  skipSuccessfulRequests: true,
  ignoreServerErrors: true,
  keyGenerator: req => accountNetworkKey(req, ipKeyGenerator(req.ip, 56)),
  code: 'OTP_VERIFICATION_LIMIT',
  message: 'Too many unsuccessful OTP verification attempts for this account from this network.',
  userAction: 'Wait for the retry interval to expire before entering another code.',
});

const forgotLimiter = createLimiter('password-reset', {
  windowMs: TEN_MINUTES,
  max: req => normalizeEmail(req) ? 3 : 10,
  keyGenerator: req => normalizeEmail(req)
    ? accountNetworkKey(req, ipKeyGenerator(req.ip, 56))
    : getLoginIpKey(req.ip, ipKeyGenerator(req.ip, 56)),
  code: 'TOO_MANY_RESET_REQUESTS',
  message: 'Too many password reset requests. Please try again later.',
  userAction: 'Wait for the retry interval to expire before requesting another reset.',
});

const magicLinkLimiter = createLimiter('magic-link', {
  windowMs: TEN_MINUTES,
  max: 5,
  keyGenerator: req => accountNetworkKey(req, ipKeyGenerator(req.ip, 56)),
  code: 'TOO_MANY_MAGIC_LINKS',
  message: 'Too many magic link requests.',
});

const googleCallbackLimiter = createLimiter('google-callback', {
  windowMs: 60 * 1000,
  max: 20,
  keyGenerator: req => getLoginIpKey(req.ip, ipKeyGenerator(req.ip, 56)),
  code: 'GOOGLE_RATE_LIMIT',
  message: 'Too many Google OAuth callback attempts.',
});

const adminStrictLimiter = createLimiter('admin-authentication', {
  windowMs: 60 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  ignoreServerErrors: true,
  keyGenerator: req => accountNetworkKey(req, ipKeyGenerator(req.ip, 56)),
  code: 'ADMIN_RATE_LIMIT',
  message: 'Too many unsuccessful admin authentication attempts.',
  userAction: 'Wait for the retry interval to expire before trying again.',
});

const challengeLimiter = createLimiter('device-challenge', {
  windowMs: TEN_MINUTES,
  max: 10,
  keyGenerator: req => accountNetworkKey(req, ipKeyGenerator(req.ip, 56)),
  code: 'CHALLENGE_RATE_LIMIT',
  message: 'Too many device challenge attempts for this account from this network.',
});

const clientErrorLimiter = createLimiter('client-error', {
  windowMs: 5 * 60 * 1000,
  max: 30,
  keyGenerator: req => getLoginIpKey(req.ip, ipKeyGenerator(req.ip, 56)),
  code: 'CLIENT_LOG_RATE_LIMIT',
  message: 'Too many client error reports.',
  userAction: 'Wait a few minutes before submitting another report.',
});

const newsletterLimiter = createLimiter('newsletter', {
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyGenerator: req => getLoginIpKey(req.ip, ipKeyGenerator(req.ip, 56)),
  code: 'NEWSLETTER_RATE_LIMIT',
  message: 'Too many subscription attempts.',
  userAction: 'Try again later.',
});


const contactLimiter = createLimiter('contact', {
  windowMs: FIFTEEN_MINUTES,
  max: 15,
  keyGenerator: req => getLoginIpKey(req.ip, ipKeyGenerator(req.ip, 56)),
  code: 'CONTACT_RATE_LIMIT',
  message: 'Too many contact submissions from this network. Please try again later.',
});

const reviewLimiter = createLimiter('reviews', {
  windowMs: FIFTEEN_MINUTES,
  max: 15,
  keyGenerator: req => getLoginIpKey(req.ip, ipKeyGenerator(req.ip, 56)),
  code: 'REVIEW_RATE_LIMIT',
  message: 'Too many review actions from this network. Please try again shortly.',
});

const orderLimiter = createLimiter('orders', {
  windowMs: FIFTEEN_MINUTES,
  max: 30,
  keyGenerator: req => getLoginIpKey(req.ip, ipKeyGenerator(req.ip, 56)),
  code: 'ORDER_RATE_LIMIT',
  message: 'Too many order requests. Please wait a moment before trying again.',
});

const searchLimiter = createLimiter('search', {
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: req => getLoginIpKey(req.ip, ipKeyGenerator(req.ip, 56)),
  code: 'SEARCH_RATE_LIMIT',
  message: 'Too many search queries. Please slow down.',
});

const couponValidateLimiter = createLimiter('coupon-validate', {
  windowMs: TEN_MINUTES,
  max: 30,
  keyGenerator: req => getLoginIpKey(req.ip, ipKeyGenerator(req.ip, 56)),
  code: 'COUPON_RATE_LIMIT',
  message: 'Too many coupon validation attempts. Please wait before trying another code.',
});

module.exports = {
  contactLimiter,
  reviewLimiter,
  orderLimiter,
  searchLimiter,
  couponValidateLimiter,
  registerLimiter,
  referralPreviewLimiter,
  loginLimiter,
  loginIpLimiter,
  otpRequestLimiter,
  otpVerificationLimiter,
  forgotLimiter,
  magicLinkLimiter,
  googleCallbackLimiter,
  adminStrictLimiter,
  challengeLimiter,
  clientErrorLimiter,
  newsletterLimiter,
  connectRateLimitStore,
  closeRateLimitStore,
  getRateLimitStoreStatus,
  createLimiter,
  getLoginIpKey,
  accountNetworkKey,
};
