const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  assertCodEligibility,
  calculateReferralWalletRedemption,
  calculateTieredReferralWalletRedemption,
  debitWalletForOrder,
} = require('../services/orderPaymentPolicy');

describe('order payment policies', () => {
  it('caps referral wallet redemption by balance, per-order limit, and eligible subtotal', () => {
    assert.equal(calculateReferralWalletRedemption(1000, 100, 999), 100);
    assert.equal(calculateReferralWalletRedemption(75, 100, 999), 75);
    assert.equal(calculateReferralWalletRedemption(1000, 100, 60), 60);
    assert.equal(calculateReferralWalletRedemption(1000, 100, 999.999), 100);
    assert.equal(calculateReferralWalletRedemption(-10, 100, 999), 0);
  });

  it('selects the highest eligible referral tier and caps it by balance and subtotal', () => {
    const tiers = [
      { min_order_amount: 700, referral_amount: 100 },
      { min_order_amount: 1100, referral_amount: 200 },
    ];
    assert.equal(calculateTieredReferralWalletRedemption(500, 699.99, tiers), 0);
    assert.equal(calculateTieredReferralWalletRedemption(500, 700, tiers), 100);
    assert.equal(calculateTieredReferralWalletRedemption(500, 1100, tiers), 200);
    assert.equal(calculateTieredReferralWalletRedemption(75, 1200, tiers), 75);
    assert.equal(calculateTieredReferralWalletRedemption(500, 1100, tiers, 900), 200);
    assert.equal(calculateTieredReferralWalletRedemption(500, 1100, tiers, 80), 80);
    assert.equal(calculateTieredReferralWalletRedemption(500, 80, [{ min_order_amount: 0, referral_amount: 100 }]), 80);
  });

  it('requires two successfully delivered orders before COD is allowed', () => {
    for (const deliveredCount of [0, 1]) {
      assert.throws(
        () => assertCodEligibility('COD', deliveredCount),
        error => error.status === 403 && error.code === 'COD_DELIVERY_REQUIREMENT'
      );
    }
    assert.doesNotThrow(() => assertCodEligibility('COD', 2));
    assert.doesNotThrow(() => assertCodEligibility('online', 0));
    assert.doesNotThrow(() => assertCodEligibility('WALLET', 0));
  });

  it('debits wallet balance and records the order payment in the same transaction', async () => {
    const calls = [];
    const connection = {
      async query(sql, values) {
        calls.push({ sql, values });
        if (sql.startsWith('SELECT balance')) return [[{ balance: '125.00' }]];
        return [{ affectedRows: 1 }];
      },
    };

    await debitWalletForOrder(connection, 7, 100, 42);

    assert.ok(calls.some(({ sql, values }) =>
      sql.includes('INSERT IGNORE INTO wallets (user_id, balance)') &&
      sql.includes('SELECT id, COALESCE(wallet_balance, 0.00) FROM users') &&
      values[0] === 7
    ));
    assert.ok(calls.some(({ sql, values }) =>
      sql.startsWith('UPDATE wallets SET balance') && values[0] === 25
    ));
    assert.ok(calls.some(({ sql, values }) =>
      sql.startsWith('INSERT INTO wallet_transactions') &&
      values[1] === 100 &&
      values[2] === 'debit' &&
      values[4] === '42'
    ));
  });

  it('does not debit an insufficient wallet balance', async () => {
    const calls = [];
    const connection = {
      async query(sql) {
        calls.push(sql);
        if (sql.startsWith('SELECT balance')) return [[{ balance: '99.99' }]];
        return [{ affectedRows: 1 }];
      },
    };

    await assert.rejects(
      debitWalletForOrder(connection, 7, 100, 42),
      error => error.status === 400 && error.code === 'INSUFFICIENT_WALLET_BALANCE'
    );
    assert.equal(calls.some(sql => sql.startsWith('UPDATE wallets SET balance')), false);
    assert.equal(calls.some(sql => sql.startsWith('INSERT INTO wallet_transactions')), false);
  });
});
