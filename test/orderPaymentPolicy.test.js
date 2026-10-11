const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  assertCodEligibility,
  debitWalletForOrder,
} = require('../services/orderPaymentPolicy');

describe('order payment policies', () => {
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
