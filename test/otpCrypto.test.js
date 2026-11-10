const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { hashOtp, resolveOtpSecret } = require('../utils/otpCrypto');

describe('OTP key derivation', () => {
  it('derives a stable OTP-specific key from the production JWT secret', () => {
    const env = { JWT_SECRET: 'j'.repeat(48) };
    const derived = resolveOtpSecret(env);

    assert.equal(derived, resolveOtpSecret(env));
    assert.equal(derived.length, 64);
    assert.notEqual(derived, env.JWT_SECRET);
  });

  it('uses an independently configured OTP secret', () => {
    assert.equal(
      resolveOtpSecret({ JWT_SECRET: 'j'.repeat(48), OTP_SECRET: 'o'.repeat(48) }),
      'o'.repeat(48)
    );
  });

  it('rejects weak, placeholder, or reused configured secrets', () => {
    for (const env of [
      { JWT_SECRET: 'j'.repeat(48), OTP_SECRET: 'short' },
      { JWT_SECRET: 'j'.repeat(48), OTP_SECRET: 'change_me' },
      { JWT_SECRET: 'j'.repeat(48), OTP_SECRET: 'j'.repeat(48) },
      { JWT_SECRET: 'fallback_secret' },
    ]) {
      assert.throws(() => resolveOtpSecret(env));
    }
  });

  it('binds OTP hashes to the purpose, account, and code', () => {
    const previousSecret = process.env.OTP_SECRET;
    const previousJwtSecret = process.env.JWT_SECRET;
    process.env.OTP_SECRET = 'o'.repeat(48);
    process.env.JWT_SECRET = 'j'.repeat(48);
    try {
      const expected = hashOtp('admin-login', 17, '123456');
      assert.equal(expected, hashOtp('admin-login', 17, '123456'));
      assert.notEqual(expected, hashOtp('user-login', 17, '123456'));
      assert.notEqual(expected, hashOtp('admin-login', 18, '123456'));
      assert.notEqual(expected, hashOtp('admin-login', 17, '654321'));
    } finally {
      if (previousSecret === undefined) delete process.env.OTP_SECRET;
      else process.env.OTP_SECRET = previousSecret;
      if (previousJwtSecret === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = previousJwtSecret;
    }
  });
});
