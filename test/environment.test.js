const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { parseOrigins, validateProductionEnvironment } = require('../config/environment');

const validProductionEnvironment = () => ({
  NODE_ENV: 'production',
  JWT_SECRET: 'f'.repeat(48),
  OTP_SECRET: 'o'.repeat(48),
  DB_HOST: 'mysql.example.com',
  DB_USER: 'bhumivera',
  DB_PASSWORD: 'database-password',
  DB_NAME: 'bhumivera',
  FRONTEND_ORIGINS: 'https://store.example',
  DB_PORT: '3306',
  PORT: '5000',
  DB_SSL: 'true',
  RAZORPAY_KEY_ID: 'rzp_live_key',
  RAZORPAY_KEY_SECRET: 'razorpay-secret',
  RAZORPAY_WEBHOOK_SECRET: 'webhook-secret'.padEnd(40, 'x'),
  CARRIER_CREDENTIALS_KEY: 'a'.repeat(64),
});

describe('production environment validation', () => {
  it('accepts configured production secrets and valid optional integrations', () => {
    assert.deepEqual(validateProductionEnvironment(validProductionEnvironment()), []);
  });

  it('allows secure key derivation and exact-origin defaults when optional settings are omitted', () => {
    const env = validProductionEnvironment();
    delete env.FRONTEND_ORIGINS;
    delete env.OTP_SECRET;
    assert.deepEqual(validateProductionEnvironment(env), []);
    assert.deepEqual(
      parseOrigins(undefined, ['https://www.bhumivera.com', 'https://bhumivera.com'], 'production'),
      ['https://www.bhumivera.com', 'https://bhumivera.com']
    );
  });

  it('rejects missing, weak, placeholder, or reused critical secrets', () => {
    const env = validProductionEnvironment();
    env.JWT_SECRET = 'fallback_secret';
    env.OTP_SECRET = env.JWT_SECRET;
    assert.throws(validateProductionEnvironment.bind(null, env), /JWT_SECRET.*OTP_SECRET/s);
  });

  it('rejects partial payment credentials and invalid database settings', () => {
    const env = validProductionEnvironment();
    delete env.RAZORPAY_KEY_SECRET;
    env.DB_SSL = 'false';
    env.DB_PORT = '3306x';
    assert.throws(validateProductionEnvironment.bind(null, env), error => {
      assert.match(error.message, /RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET/);
      assert.match(error.message, /DB_SSL cannot be disabled/);
      assert.match(error.message, /DB_PORT must be an integer/);
      return true;
    });
  });

  it('does not impose production-only requirements in development', () => {
    assert.deepEqual(validateProductionEnvironment({ NODE_ENV: 'development' }), []);
  });
});

describe('frontend origin parsing', () => {
  it('parses and deduplicates exact origins', () => {
    assert.deepEqual(
      parseOrigins('https://store.example, https://store.example, http://localhost:5173', []),
      ['https://store.example', 'http://localhost:5173']
    );
  });

  it('rejects URL paths and malformed origins', () => {
    assert.throws(() => parseOrigins('https://store.example/path', []), /exact HTTP\(S\) origins/);
  });

  it('rejects insecure frontend origins in production', () => {
    assert.throws(
      () => parseOrigins('http://store.example', [], 'production'),
      /must use HTTPS in production/
    );
  });
});
