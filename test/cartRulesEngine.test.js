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

  it('stacks all eligible rewards across cumulative cart milestones', () => {
    const firstMilestone = 100;
    const secondMilestone = 200;
    const thirdMilestone = 300;
    const rules = [
      {
        id: 1,
        name: 'First configured benefit',
        status: 'active',
        min_cart_value: firstMilestone,
        max_cart_value: null,
        free_shipping_enabled: 1,
      },
      {
        id: 2,
        name: 'Second configured benefit',
        status: 'active',
        min_cart_value: secondMilestone,
        max_cart_value: null,
        gift_product_id: 46,
        gift_product_name: 'Configured gift one',
        gift_quantity: 1,
      },
      {
        id: 3,
        name: 'Third configured benefit',
        status: 'active',
        min_cart_value: thirdMilestone,
        max_cart_value: null,
        free_shipping_enabled: 1,
        gift_product_id: 47,
        gift_product_name: 'Configured gift two',
        gift_quantity: 1,
      },
    ];

    const atGiftTier = evaluateCartRules(secondMilestone, rules);
    assert.deepEqual(atGiftTier.gifts.map(gift => gift.productName), ['Configured gift one']);
    assert.equal(atGiftTier.freeShipping, true);

    const atHighestTier = evaluateCartRules(thirdMilestone, rules);
    assert.deepEqual(atHighestTier.gifts.map(gift => gift.productName), ['Configured gift one', 'Configured gift two']);
    assert.equal(atHighestTier.freeShipping, true);
  });
});
