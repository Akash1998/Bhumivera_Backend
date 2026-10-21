const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  calculateTierDiscount,
  calculateLoyaltyRedemption,
  calculateLoyaltyPointsAward,
} = require('../services/loyaltyPolicy');

describe('loyalty matrix policy', () => {
  it('stacks a tier discount after other offers without exceeding merchandise value', () => {
    assert.equal(calculateTierDiscount(1000, 100, 10), 100);
    assert.equal(calculateTierDiscount(1000, 950, 10), 50);
    assert.equal(calculateTierDiscount(1000, 0, 0), 0);
    assert.equal(calculateTierDiscount(1000, 0, 50, false), 0);
  });

  it('limits points redemption to configured percent, balance, and minimum', () => {
    const policy = {
      pointsBalance: 500,
      eligibleSubtotal: 1000,
      redemptionPointsPerRupee: 10,
      maxRedemptionPercent: 25,
      minimumRedemptionPoints: 100,
    };
    assert.deepEqual(calculateLoyaltyRedemption(policy), { points: 500, discount: 50 });
    assert.deepEqual(calculateLoyaltyRedemption({ ...policy, pointsBalance: 75 }), { points: 0, discount: 0 });
    assert.deepEqual(calculateLoyaltyRedemption({ ...policy, eligibleSubtotal: 100 }), { points: 250, discount: 25 });
    assert.deepEqual(calculateLoyaltyRedemption({ ...policy, enabled: false }), { points: 0, discount: 0 });
  });

  it('awards base, tier, and cashback-equivalent points only while enabled', () => {
    const award = {
      eligibleSpend: 1000,
      pointsPerRupee: 1,
      tierMultiplier: 2,
      tierBonusPoints: 25,
      cashbackPercent: 1,
      redemptionPointsPerRupee: 10,
    };
    // 1000 spend * 1 point/rupee * 2 tier multiplier = 2000 base points
    // 1% cashback on 1000 = 10 rupees * 10 points/rupee = 100 cashback points
    // 25 tier bonus points = 2125 total points
    assert.equal(calculateLoyaltyPointsAward(award), 2125);
    assert.equal(calculateLoyaltyPointsAward({ ...award, eligibleSpend: 0 }), 0);
    assert.equal(calculateLoyaltyPointsAward({ ...award, enabled: false }), 0);
  });
});