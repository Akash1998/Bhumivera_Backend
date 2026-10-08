const crypto = require('crypto');

function hashOtp(purpose, accountId, otp) {
  const secret = process.env.OTP_SECRET || process.env.JWT_SECRET;
  if (!secret || secret === 'fallback_secret' || secret.length < 32) {
    throw new Error('Set OTP_SECRET to a random secret of at least 32 characters.');
  }
  return crypto.createHmac('sha256', secret).update(`${purpose}:${accountId}:${otp}`).digest('hex');
}

module.exports = { hashOtp };
