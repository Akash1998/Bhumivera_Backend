const crypto = require('crypto');
const net = require('net');
const rateLimit = require('express-rate-limit');

function getLoginIpKey(ip) {
  const address = String(ip || '');
  if (net.isIP(address) === 4) return `v4:${address}`;
  if (net.isIP(address) !== 6) return `unknown:${address}`;

  const normalized = address.toLowerCase();
  const mappedIpv4 = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mappedIpv4) return `v4:${mappedIpv4[1]}`;

  const segments = normalized.split(':');
  const lastSegment = segments[segments.length - 1];
  if (lastSegment.includes('.')) {
    const octets = lastSegment.split('.').map(Number);
    segments.splice(
      segments.length - 1,
      1,
      ((octets[0] << 8) | octets[1]).toString(16),
      ((octets[2] << 8) | octets[3]).toString(16)
    );
  }

  const compressed = segments.indexOf('');
  let groups;
  if (compressed >= 0) {
    const left = segments.slice(0, compressed).filter(Boolean);
    const right = segments.slice(compressed + 1).filter(Boolean);
    groups = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  } else {
    groups = segments;
  }
  if (groups.length !== 8) return `v6:${normalized}`;

  const prefix = groups.slice(0, 3).map(group => parseInt(group, 16).toString(16).padStart(4, '0')).join('');
  const fourthGroupPrefix = (parseInt(groups[3], 16) & 0xff00).toString(16).padStart(4, '0');
  return `v6:${prefix}${fourthGroupPrefix}`;
}

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, 
  max: 100, 
  standardHeaders: true, 
  legacyHeaders: false,
  message: { message: 'Too many accounts created from this network. Please try again later.' }
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyGenerator: req => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const emailHash = crypto.createHash('sha256').update(email).digest('hex');
    return `login:${getLoginIpKey(req.ip)}:${emailHash}`;
  },
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    code: 'LOGIN_ATTEMPTS_LIMIT',
    message: 'Too many sign-in attempts for this account from this network. Please wait 15 minutes before trying again.'
  }
});

const loginIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    code: 'LOGIN_NETWORK_LIMIT',
    message: 'There have been too many unsuccessful sign-in attempts from this network. Please wait 15 minutes and try again.'
  }
});

const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, 
  max: 30, 
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many OTP requests. System locked for 15 minutes to prevent brute-force attacks.' }
});

const forgotLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: (req, res) => { return req.body && req.body.email ? 3 : 10; },
  keyGenerator: (req, res) => { return req.body && req.body.email ? `${req.body.email.toLowerCase()}|${req.ip}` : req.ip; },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next, options) => res.status(429).setHeader('Retry-After', Math.ceil(options.windowMs / 1000)).json({ message:'Too many reset requests. Please try again later.', code:'TOO_MANY_RESET_REQUESTS', retryAfterSeconds: Math.ceil(options.windowMs / 1000) })
});

const magicLinkLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  keyGenerator: (req, res) => (req.body && req.body.email) ? req.body.email.toLowerCase() : req.ip,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message:'Too many magic link requests. Try again in 10 minutes.', code:'TOO_MANY_MAGIC_LINKS' }
});

const googleCallbackLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message:'Too many Google OAuth callback attempts.', code:'GOOGLE_RATE_LIMIT' }
});

const adminStrictLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => (req.body && req.body.email) ? `admin:${req.body.email.toLowerCase()}|${req.ip}` : `admin:ip:${req.ip}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message:'Too many admin authentication attempts. Account locked for 1 hour.', code:'ADMIN_RATE_LIMIT' }
});

const challengeLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  keyGenerator: (req, res) => (req.body && req.body.email) ? `ch:${req.body.email.toLowerCase()}` : `ch:ip:${req.ip}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message:'Too many device challenge attempts.', code:'CHALLENGE_RATE_LIMIT' }
});

const clientErrorLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json({
    code: 'CLIENT_LOG_RATE_LIMIT',
    message: 'Too many client error reports.',
    userAction: 'Wait a few minutes before submitting another report.',
  }),
});

const newsletterLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: 'NEWSLETTER_RATE_LIMIT', message: 'Too many subscription attempts.', userAction: 'Try again later.' },
});

module.exports = {
  registerLimiter,
  loginLimiter,
  loginIpLimiter,
  otpLimiter,
  forgotLimiter,
  magicLinkLimiter,
  googleCallbackLimiter,
  adminStrictLimiter,
  challengeLimiter,
  clientErrorLimiter,
  newsletterLimiter
};
