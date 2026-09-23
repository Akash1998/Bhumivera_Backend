const rateLimit = require('express-rate-limit');

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, 
  max: 100, 
  standardHeaders: true, 
  legacyHeaders: false,
  message: { message: 'Too many accounts created from this network. Please try again later.' }
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, 
  max: 30, 
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many login attempts from this IP. Security protocol active. Try again in 15 minutes.' }
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

module.exports = {
  registerLimiter,
  loginLimiter,
  otpLimiter,
  forgotLimiter,
  magicLinkLimiter,
  googleCallbackLimiter,
  adminStrictLimiter,
  challengeLimiter
};
