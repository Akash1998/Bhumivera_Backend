const crypto = require('crypto');

const PLACEHOLDER_SECRETS = new Set([
  'fallback_secret',
  'your_secret',
  'changeme',
  'change_me',
]);

function resolveOtpSecret(env = process.env) {
  const configuredSecret = env.OTP_SECRET?.trim();
  if (configuredSecret) {
    if (configuredSecret.length < 32 ||
        PLACEHOLDER_SECRETS.has(configuredSecret.toLowerCase()) ||
        configuredSecret === env.JWT_SECRET?.trim()) {
      throw new Error('OTP_SECRET must be a non-placeholder secret of at least 32 characters, different from JWT_SECRET.');
    }
    return configuredSecret;
  }

  const jwtSecret = env.JWT_SECRET?.trim();
  if (!jwtSecret || jwtSecret.length < 32 || PLACEHOLDER_SECRETS.has(jwtSecret.toLowerCase())) {
    throw new Error('Set a strong JWT_SECRET before deriving the OTP signing key.');
  }

  return Buffer.from(crypto.hkdfSync(
    'sha256',
    Buffer.from(jwtSecret, 'utf8'),
    Buffer.from('Bhumivera production key derivation v1', 'utf8'),
    Buffer.from('OTP HMAC-SHA256 v1', 'utf8'),
    32
  )).toString('hex');
}

function hashOtp(purpose, accountId, otp) {
  const secret = resolveOtpSecret();
  return crypto.createHmac('sha256', secret).update(`${purpose}:${accountId}:${otp}`).digest('hex');
}

module.exports = { hashOtp, resolveOtpSecret };
