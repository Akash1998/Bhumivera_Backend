const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { evaluateCartRules } = require('../utils/cartRulesEngine');

describe('cart gift reward tiers', () => {
  const giftRule = {
    id: 12,
    name: 'Complimentary travel cleanser',
    status: 'active',
    min_cart_value: 1000,
    max_cart_value: null,
    gift_product_id: 45,
    gift_product_name: 'Travel Cleanser',
    gift_quantity: 2,
  };

  it('includes configured gift details for locked and unlocked milestones', () => {
    const locked = evaluateCartRules(750, [giftRule]).tiers[0];
    assert.equal(locked.unlocked, false);
    assert.equal(locked.missingAmount, 250);
    assert.equal(locked.giftProductId, 45);
    assert.equal(locked.giftProductName, 'Travel Cleanser');
    assert.equal(locked.giftQuantity, 2);

    const unlocked = evaluateCartRules(1000, [giftRule]);
    assert.equal(unlocked.tiers[0].unlocked, true);
    assert.equal(unlocked.gifts[0].productName, 'Travel Cleanser');
    assert.equal(unlocked.gifts[0].quantity, 2);
  });
});
