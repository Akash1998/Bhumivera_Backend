const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { generateOrderNumber } = require('../services/orderNumber');

describe('public order numbers', () => {
  it('generates nine-digit numeric customer references', () => {
    const orderNumber = generateOrderNumber();
    assert.match(orderNumber, /^[1-9]\d{8}$/);
  });
});
