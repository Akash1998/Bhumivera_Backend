const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateShippingCost } = require('../services/shippingPolicy');

test('shipping charges honor the configured free-standard threshold', () => {
  assert.equal(calculateShippingCost({
    deliveryType: 'standard',
    cartSubtotal: 598,
    standardCharge: 50,
    premiumCharge: 150,
    freeShippingThreshold: 599,
  }), 50);
  assert.equal(calculateShippingCost({
    deliveryType: 'standard',
    cartSubtotal: 599,
    standardCharge: 50,
    premiumCharge: 150,
    freeShippingThreshold: 599,
  }), 0);
});

test('premium costs 100 extra below 799 and uses the configured premium rate from 799', () => {
  assert.equal(calculateShippingCost({
    deliveryType: 'express',
    cartSubtotal: 598,
    standardCharge: 50,
    premiumCharge: 150,
    freeShippingThreshold: 599,
  }), 150);
  assert.equal(calculateShippingCost({
    deliveryType: 'express',
    cartSubtotal: 650,
    standardCharge: 50,
    premiumCharge: 150,
    freeShippingThreshold: 599,
  }), 100);
  assert.equal(calculateShippingCost({
    deliveryType: 'express',
    cartSubtotal: 799,
    standardCharge: 50,
    premiumCharge: 150,
    freeShippingThreshold: 599,
  }), 150);
});
