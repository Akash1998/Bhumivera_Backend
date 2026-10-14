const crypto = require('crypto');

const DEFAULT_ORDER_SPIN_REWARDS = [
  { label: '₹50 off', discountType: 'fixed', discountValue: 50, minimumOrderAmount: 500, maxDiscount: null, chance: 35, expiryDays: 30 },
  { label: '5% off (up to ₹200)', discountType: 'percentage', discountValue: 5, minimumOrderAmount: 500, maxDiscount: 200, chance: 25, expiryDays: 30 },
  { label: '₹100 off', discountType: 'fixed', discountValue: 100, minimumOrderAmount: 1000, maxDiscount: null, chance: 18, expiryDays: 30 },
  { label: '10% off (up to ₹500)', discountType: 'percentage', discountValue: 10, minimumOrderAmount: 1500, maxDiscount: 500, chance: 12, expiryDays: 30 },
  { label: '₹250 off', discountType: 'fixed', discountValue: 250, minimumOrderAmount: 2500, maxDiscount: null, chance: 7, expiryDays: 30 },
  { label: '₹500 off', discountType: 'fixed', discountValue: 500, minimumOrderAmount: 5000, maxDiscount: null, chance: 3, expiryDays: 30 },
];

const validateOrderSpinRewards = value => {
  let rewards = value;
  if (typeof rewards === 'string') {
    try {
      rewards = JSON.parse(rewards);
    } catch {
      return { valid: false, message: 'Spin rewards must be valid JSON.' };
    }
  }
  if (!Array.isArray(rewards) || rewards.length !== 6) {
    return { valid: false, message: 'Configure exactly six spin rewards.' };
  }

  const normalized = [];
  for (const [index, reward] of rewards.entries()) {
    const label = typeof reward?.label === 'string' ? reward.label.trim() : '';
    const discountType = reward?.discountType;
    const discountValue = Number(reward?.discountValue);
    const minimumOrderAmount = Number(reward?.minimumOrderAmount);
    const maxDiscount = reward?.maxDiscount === null || reward?.maxDiscount === '' ? null : Number(reward?.maxDiscount);
    const chance = Number(reward?.chance);
    const expiryDays = Number(reward?.expiryDays);
    if (!label || label.length > 120 ||
        !['percentage', 'fixed'].includes(discountType) ||
        !Number.isFinite(discountValue) || discountValue <= 0 ||
        discountType === 'percentage' && discountValue > 100 ||
        !Number.isFinite(minimumOrderAmount) || minimumOrderAmount < 0 ||
        maxDiscount !== null && (!Number.isFinite(maxDiscount) || maxDiscount <= 0) ||
        !Number.isInteger(chance) || chance < 0 || chance > 100 ||
        !Number.isInteger(expiryDays) || expiryDays < 1 || expiryDays > 365) {
      return { valid: false, message: `Spin reward ${index + 1} has invalid fields.` };
    }
    normalized.push({ label, discountType, discountValue, minimumOrderAmount, maxDiscount, chance, expiryDays });
  }

  if (normalized.reduce((sum, reward) => sum + reward.chance, 0) !== 100) {
    return { valid: false, message: 'Spin reward chances must add up to exactly 100%.' };
  }
  return { valid: true, rewards: normalized };
};

const chooseOrderSpinReward = (rewards, roll = crypto.randomInt(100)) => {
  if (!Number.isInteger(roll) || roll < 0 || roll >= 100) throw new RangeError('Spin roll must be an integer from 0 to 99.');
  let cumulativeChance = 0;
  for (const [index, reward] of rewards.entries()) {
    cumulativeChance += reward.chance;
    if (roll < cumulativeChance) return { ...reward, index };
  }
  throw new Error('Spin reward chances must total 100%.');
};

module.exports = { DEFAULT_ORDER_SPIN_REWARDS, validateOrderSpinRewards, chooseOrderSpinReward };
