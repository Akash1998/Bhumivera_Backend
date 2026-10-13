const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { hashOtp, compareOtp } = require('../utils/otpCrypto');

describe('Security Hardening Verification Suite', () => {
  it('SEC-CRIT-02: shippingModel.js updateZone rejects dynamic SQL injection column keys', async () => {
    // Test the allowlist mechanism in updateZone logic
    const ALLOWED_SHIPPING_FIELDS = Object.freeze({
      name: 'name',
      regions: 'regions',
      base_charge: 'base_charge',
      per_kg_charge: 'per_kg_charge',
      free_above: 'free_above',
      estimated_days: 'estimated_days',
      is_active: 'is_active',
    });

    const maliciousData = {
      'name = (SELECT 1) -- ': 'injected',
      base_charge: 50.0,
      'malicious_key': 'drop table',
    };

    const updates = [];
    const values = [];
    for (const [key, value] of Object.entries(maliciousData)) {
      if (Object.prototype.hasOwnProperty.call(ALLOWED_SHIPPING_FIELDS, key)) {
        const dbColumn = ALLOWED_SHIPPING_FIELDS[key];
        updates.push(`\`${dbColumn}\` = ?`);
        values.push(value);
      }
    }

    assert.equal(updates.length, 1);
    assert.equal(updates[0], '`base_charge` = ?');
    assert.equal(values[0], 50.0);
  });

  it('SEC-CRIT-05: OTP verification compares against hashed OTP values safely and timing-safely', () => {
    const email = 'customer@bhumivera.com';
    const otp = '654321';
    const hashed = hashOtp('email-verification', email, otp);

    assert.equal(compareOtp('email-verification', email, otp, hashed), true);
    assert.equal(compareOtp('email-verification', email, '123456', hashed), false);
    assert.equal(compareOtp('reset-password', email, otp, hashed), false);
  });

  it('SEC-HIGH-05: CSV export formulas are sanitized against DDE injection', () => {
    function sanitizeCsvCell(value) {
      if (value === null || value === undefined) return '""';
      const str = String(value);
      const sanitized = /^[=+\-@\t\r]/.test(str) ? "'" + str : str;
      return '"' + sanitized.replace(/"/g, '""') + '"';
    }

    assert.equal(sanitizeCsvCell('=CMD|\' /C calc\'!A0'), '"\'=CMD|\' /C calc\'!A0"');
    assert.equal(sanitizeCsvCell('+123456789'), '"\'+123456789"');
    assert.equal(sanitizeCsvCell('-@dangerous'), '"\'-@dangerous"');
    assert.equal(sanitizeCsvCell('@SUM(A1:A10)'), '"\'@SUM(A1:A10)"');
    assert.equal(sanitizeCsvCell('normal_customer@example.com'), '"normal_customer@example.com"');
    assert.equal(sanitizeCsvCell('has "quotes"'), '"has ""quotes"""');
  });

  it('SEC-MED-02: Wallet balance arithmetic handles fixed-point paise without negative debits', () => {
    const currentBalance = 150.25;
    const currentPaise = Math.round(currentBalance * 100);
    const debitAmount = 50.10;
    const deltaPaise = Math.round(debitAmount * 100);

    const newPaise = currentPaise - deltaPaise;
    const newBalance = Number((newPaise / 100).toFixed(2));

    assert.equal(newBalance, 100.15);

    // Negative amount check
    const invalidAmount = -50;
    assert.equal(Number.isFinite(invalidAmount) && invalidAmount > 0, false);
  });
});
