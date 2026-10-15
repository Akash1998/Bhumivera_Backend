const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  DEFAULT_ORDER_SPIN_REWARDS,
  validateOrderSpinRewards,
  chooseOrderSpinReward,
} = require('../services/orderSpinPolicy');

describe('post-order spin policy', () => {
  it('provides valid weighted rewards totaling 100%', () => {
    const result = validateOrderSpinRewards(DEFAULT_ORDER_SPIN_REWARDS);
    assert.equal(result.valid, true);
    assert.equal(result.rewards.length, 6);
    assert.equal(result.rewards.reduce((sum, reward) => sum + reward.chance, 0), 100);
  });

  it('rejects reward configurations with percentages not totaling 100', () => {
    const rewards = DEFAULT_ORDER_SPIN_REWARDS.map(reward => ({ ...reward }));
    rewards[0].chance = 34;
    assert.deepEqual(validateOrderSpinRewards(rewards), {
      valid: false,
      message: 'Spin reward chances must add up to exactly 100%.',
    });
  });

  it('accepts a configurable number of rewards and caps the list at twelve', () => {
    const rewards = DEFAULT_ORDER_SPIN_REWARDS.slice(0, 1).map(reward => ({ ...reward, chance: 100 }));
    assert.equal(validateOrderSpinRewards(rewards).valid, true);
    assert.equal(validateOrderSpinRewards(Array.from({ length: 13 }, (_, index) => ({
      ...DEFAULT_ORDER_SPIN_REWARDS[0],
      label: `Prize ${index}`,
      chance: index === 0 ? 100 : 0,
    }))).valid, false);
  });

  it('validates free-shipping and loyalty-point prizes', () => {
    const rewards = [
      { label: 'Free shipping', rewardType: 'free_shipping', minimumOrderAmount: 500, expiryDays: 30, chance: 50 },
      { label: '100 points', rewardType: 'points', points: 100, chance: 50 },
    ];
    assert.equal(validateOrderSpinRewards(rewards).valid, true);
    assert.equal(validateOrderSpinRewards([{ ...rewards[1], points: 0, chance: 100 }]).valid, false);
  });

  it('selects a reward using configured weighted ranges', () => {
    assert.equal(chooseOrderSpinReward(DEFAULT_ORDER_SPIN_REWARDS, 0).index, 0);
    assert.equal(chooseOrderSpinReward(DEFAULT_ORDER_SPIN_REWARDS, 35).index, 1);
    assert.equal(chooseOrderSpinReward(DEFAULT_ORDER_SPIN_REWARDS, 99).index, 5);
  });
});
