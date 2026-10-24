const crypto = require('crypto');
const net = require('net');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = rateLimit;

const FIFTEEN_MINUTES = 15 * 60 * 1000;
const TEN_MINUTES = 10 * 60 * 1000;
const FIVE_MINUTES = 5 * 60 * 1000;

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
let rateLimitConnectionPromise;
let rateLimitRedisUnavailable = false;
let rateLimitFallbackLogged = false;

if (sharedRedisClient) {
  sharedRedisClient.on('error', error => {
    console.error('[RATE_LIMIT_REDIS_ERROR]', error.message);
  });
} else if (process.env.NODE_ENV === 'production') {
  console.warn('[RATE_LIMIT_STORE] RATE_LIMIT_REDIS_URL is not configured; rate limits use process-local memory.');
}

async function connectRateLimitStore() {
  if (!sharedRedisClient || sharedRedisClient.isReady || rateLimitRedisUnavailable) return;
  if (!rateLimitConnectionPromise) {
    rateLimitConnectionPromise = (async () => {
      if (!sharedRedisClient.isOpen) {
        await sharedRedisClient.connect();
      } else {
        await new Promise((resolve, reject) => {
          const onReady = () => {
            sharedRedisClient.off('error', onError);
            resolve();
          };
          const onError = error => {
            sharedRedisClient.off('ready', onReady);
            reject(error);
          };
          sharedRedisClient.once('ready', onReady);
          sharedRedisClient.once('error', onError);
        });
      }
      console.info('[RATE_LIMIT_STORE] Shared Redis rate-limit storage connected.');
    })().finally(() => {
      rateLimitConnectionPromise = null;
    });
  }
  await rateLimitConnectionPromise;
}

function markRateLimitStoreUnavailable(error) {
  if (!sharedRedisClient) return;
  rateLimitRedisUnavailable = true;
  if (!rateLimitFallbackLogged) {
    rateLimitFallbackLogged = true;
    console.warn(
      '[RATE_LIMIT_STORE] Shared Redis is unavailable; using process-local rate limits.',
      error?.message || 'Redis connection failed.'
    );
  }
}

async function closeRateLimitStore() {
  if (sharedRedisClient?.isOpen) await sharedRedisClient.quit();
}

const createRedisCommand = (client, ensureConnected) => (...args) =>
  Promise.resolve().then(ensureConnected).then(() => client.sendCommand(args));

function createFailoverRateLimitStore(primaryStore, ensurePrimaryStore, onFailure = markRateLimitStoreUnavailable) {
  const localStore = new rateLimit.MemoryStore();
  let usePrimaryStore = !rateLimitRedisUnavailable;

  const fallBack = error => {
    usePrimaryStore = false;
    onFailure(error);
  };

  return {
    init(options) {
      primaryStore.init?.(options);
      localStore.init(options);
    },
    async increment(key) {
      if (usePrimaryStore && !rateLimitRedisUnavailable) {
        try {
          await ensurePrimaryStore();
          return await primaryStore.increment(key);
        } catch (error) {
          fallBack(error);
        }
      }
      return localStore.increment(key);
    },
    async decrement(key) {
      if (usePrimaryStore && !rateLimitRedisUnavailable) {
        try {
          return await primaryStore.decrement(key);
        } catch (error) {
          fallBack(error);
        }
      }
      return localStore.decrement(key);
    },
    async resetKey(key) {
      if (usePrimaryStore && !rateLimitRedisUnavailable) {
        try {
          return await primaryStore.resetKey(key);
        } catch (error) {
          fallBack(error);
        }
      }
      return localStore.resetKey(key);
    },
    async shutdown() {
      await localStore.shutdown();
      if (usePrimaryStore) await primaryStore.shutdown?.();
    },
  };
}

function getRateLimitStoreStatus() {
  return {
    status: !sharedRedisClient || rateLimitRedisUnavailable
      ? 'process_local'
      : sharedRedisClient.isReady ? 'connected' : 'configured_but_disconnected',
    configured: Boolean(sharedRedisClient),
    sharedAcrossInstances: Boolean(sharedRedisClient && !rateLimitRedisUnavailable),
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
  skip = null,
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
  if (skip) options.skip = skip;
  if (store) {
    options.store = store;
  } else if (sharedRedisClient) {
    const { RedisStore } = require('rate-limit-redis');
    options.store = createFailoverRateLimitStore(
      new RedisStore({
        prefix: `bhumivera:rate-limit:${name}:`,
        sendCommand: createRedisCommand(sharedRedisClient, connectRateLimitStore),
      }),
      connectRateLimitStore
    );
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

const emailAccountLookupLimiter = createLimiter('email-account-lookup-ip', {
  windowMs: FIFTEEN_MINUTES,
  max: 30,
  keyGenerator: req => getLoginIpKey(req.ip, ipKeyGenerator(req.ip, 56)),
  code: 'EMAIL_LOOKUP_RATE_LIMIT',
  message: 'Too many email checks from this network. Please try again later.',
  userAction: 'Wait for the retry interval to expire before checking again.',
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

// --- AI CUSTOMER SUPPORT ENGINE RATE LIMITERS ---
const supportSessionLimiter = createLimiter('ai-support-session', {
  windowMs: FIFTEEN_MINUTES,
  max: 30,
  keyGenerator: req => getLoginIpKey(req.ip, ipKeyGenerator(req.ip, 56)),
  code: 'SUPPORT_SESSION_RATE_LIMIT',
  message: 'Too many support session requests from this network. Please wait a moment.',
  userAction: 'Wait a moment before starting a new chat session.',
});

const supportChatLimiter = createLimiter('ai-support-chat', {
  windowMs: FIVE_MINUTES,
  max: 35,
  keyGenerator: req => getLoginIpKey(req.ip, ipKeyGenerator(req.ip, 56)),
  code: 'SUPPORT_CHAT_RATE_LIMIT',
  message: 'You are sending messages too quickly. Please wait a moment before sending another message.',
  userAction: 'Wait a few seconds before sending your next message.',
});

const supportDuplicateMessageLimiter = createLimiter('ai-support-duplicate-message', {
  windowMs: TEN_MINUTES,
  max: 1,
  skip: req => {
    const message = typeof req.body?.message === 'string' ? req.body.message : '';
    return !message.trim() || /^(?:agent|human|support|live\s*agent|executive|supervisor|manager|escalate|helpdesk)$|\b(?:customer support|support team|(?:need|want|request)\s+(?:some\s+)?support|(?:need|want|request)\s+(?:a\s+)?human(?:\s+(?:agent|support))?|live\s*agent|real\s*person|customer\s*care|speak\s*to\s*(?:someone|agent|manager|supervisor)|talk\s*to\s*(?:agent|human|person|support)|connect\s*me\s*(?:to|with)\s*(?:an?\s*)?(?:agent|human|support)|escalat(?:e|ion))\b/i.test(message);
  },
  keyGenerator: req => {
    const principal = req.user?.id
      ? `user:${req.user.id}`
      : `ip:${getLoginIpKey(req.ip, ipKeyGenerator(req.ip, 56))}`;
    const normalizedMessage = typeof req.body?.message === 'string'
      ? req.body.message.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()
      : '';
    const messageHash = crypto.createHash('sha256').update(normalizedMessage).digest('hex');
    return `${principal}:${messageHash}`;
  },
  code: 'SUPPORT_DUPLICATE_MESSAGE_LIMIT',
  message: 'You already sent this message recently. Please wait 10 minutes before sending it again.',
  userAction: 'You can send a different question now, or retry this message after 10 minutes.',
});

const supportEscalationLimiter = createLimiter('ai-support-escalation', {
  windowMs: FIFTEEN_MINUTES,
  max: 6,
  keyGenerator: req => getLoginIpKey(req.ip, ipKeyGenerator(req.ip, 56)),
  code: 'SUPPORT_ESCALATION_RATE_LIMIT',
  message: 'An escalation request has already been queued for our human support team.',
  userAction: 'Our team has been notified and will reach out shortly.',
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
  emailAccountLookupLimiter,
  otpRequestLimiter,
  otpVerificationLimiter,
  forgotLimiter,
  magicLinkLimiter,
  googleCallbackLimiter,
  adminStrictLimiter,
  challengeLimiter,
  clientErrorLimiter,
  newsletterLimiter,
  supportSessionLimiter,
  supportChatLimiter,
  supportDuplicateMessageLimiter,
  supportEscalationLimiter,
  connectRateLimitStore,
  markRateLimitStoreUnavailable,
  closeRateLimitStore,
  getRateLimitStoreStatus,
  createLimiter,
  createFailoverRateLimitStore,
  createRedisCommand,
  getLoginIpKey,
  accountNetworkKey,
};
