const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  DEFAULT_ORDER_SPIN_REWARDS,
  validateOrderSpinRewards,
  chooseOrderSpinReward,
} = require('../services/orderSpinPolicy');

describe('post-order spin policy', () => {
  it('provides six valid weighted rewards totaling 100%', () => {
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

  it('rejects configurations without exactly six rewards', () => {
    assert.equal(validateOrderSpinRewards(DEFAULT_ORDER_SPIN_REWARDS.slice(0, 5)).valid, false);
  });

  it('selects a reward using configured weighted ranges', () => {
    assert.equal(chooseOrderSpinReward(DEFAULT_ORDER_SPIN_REWARDS, 0).index, 0);
    assert.equal(chooseOrderSpinReward(DEFAULT_ORDER_SPIN_REWARDS, 35).index, 1);
    assert.equal(chooseOrderSpinReward(DEFAULT_ORDER_SPIN_REWARDS, 99).index, 5);
  });
});
