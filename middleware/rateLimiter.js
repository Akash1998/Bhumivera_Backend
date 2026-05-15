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

module.exports = {
  registerLimiter,
  loginLimiter,
  otpLimiter
};
