const crypto = require('crypto');

const DEFAULT_ORDER_SPIN_REWARDS = [
  { label: '₹50 off', rewardType: 'discount', discountType: 'fixed', discountValue: 50, minimumOrderAmount: 500, maxDiscount: null, chance: 80, expiryDays: 30 },
  { label: '5% off (up to ₹200)', rewardType: 'discount', discountType: 'percentage', discountValue: 5, minimumOrderAmount: 500, maxDiscount: 200, chance: 85, expiryDays: 30 },
  { label: '₹100 off', rewardType: 'discount', discountType: 'fixed', discountValue: 100, minimumOrderAmount: 599, maxDiscount: null, chance: 20, expiryDays: 30 },
  { label: '10% off (up to ₹500)', rewardType: 'discount', discountType: 'percentage', discountValue: 10, minimumOrderAmount: 1000, maxDiscount: 500, chance: 40, expiryDays: 30 },
  { label: '₹500 off', rewardType: 'discount', discountType: 'fixed', discountValue: 500, minimumOrderAmount: 2000, maxDiscount: null, chance: 5, expiryDays: 30 },
];

const LEGACY_DEFAULT_ORDER_SPIN_REWARDS = [
  { label: '₹50 off', rewardType: 'discount', discountType: 'fixed', discountValue: 50, minimumOrderAmount: 500, maxDiscount: null, chance: 35, expiryDays: 30 },
  { label: '5% off (up to ₹200)', rewardType: 'discount', discountType: 'percentage', discountValue: 5, minimumOrderAmount: 500, maxDiscount: 200, chance: 25, expiryDays: 30 },
  { label: '₹100 off', rewardType: 'discount', discountType: 'fixed', discountValue: 100, minimumOrderAmount: 1000, maxDiscount: null, chance: 18, expiryDays: 30 },
  { label: '10% off (up to ₹500)', rewardType: 'discount', discountType: 'percentage', discountValue: 10, minimumOrderAmount: 1500, maxDiscount: 500, chance: 12, expiryDays: 30 },
  { label: '₹250 off', rewardType: 'discount', discountType: 'fixed', discountValue: 250, minimumOrderAmount: 2500, maxDiscount: null, chance: 7, expiryDays: 30 },
  { label: '₹500 off', rewardType: 'discount', discountType: 'fixed', discountValue: 500, minimumOrderAmount: 5000, maxDiscount: null, chance: 3, expiryDays: 30 },
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
  if (!Array.isArray(rewards) || rewards.length < 1 || rewards.length > 12) {
    return { valid: false, message: 'Configure between one and twelve spin rewards.' };
  }

  const normalized = [];
  for (const [index, reward] of rewards.entries()) {
    const label = typeof reward?.label === 'string' ? reward.label.trim() : '';
    const description = typeof reward?.description === 'string' ? reward.description.trim() : '';
    const termsAndConditions = typeof reward?.termsAndConditions === 'string' ? reward.termsAndConditions.trim() : '';
    const rewardType = reward?.rewardType || 'discount';
    const discountType = reward?.discountType;
    const discountValue = Number(reward?.discountValue);
    const points = Number(reward?.points);
    const minimumOrderAmount = Number(reward?.minimumOrderAmount);
    const maxDiscount = reward?.maxDiscount === null || reward?.maxDiscount === '' ? null : Number(reward?.maxDiscount);
    const chance = Number(reward?.chance);
    const expiryDays = Number(reward?.expiryDays);
    if (!label || label.length > 120 ||
        description.length > 255 || termsAndConditions.length > 2000 ||
        !['discount', 'free_shipping', 'points'].includes(rewardType) ||
        !Number.isInteger(chance) || chance < 0 || chance > 100000) {
      return { valid: false, message: `Spin reward ${index + 1} has invalid fields.` };
    }
    if (rewardType === 'points') {
      if (!Number.isInteger(points) || points < 1 || points > 100000) {
        return { valid: false, message: `Spin reward ${index + 1} must award 1–100000 points.` };
      }
      normalized.push({ label, description, termsAndConditions, rewardType, points, chance });
      continue;
    }
    if (!Number.isFinite(minimumOrderAmount) || minimumOrderAmount < 0 ||
        !Number.isInteger(expiryDays) || expiryDays < 1 || expiryDays > 365) {
      return { valid: false, message: `Spin reward ${index + 1} has invalid fields.` };
    }
    if (rewardType === 'discount' &&
        (!['percentage', 'fixed'].includes(discountType) ||
         !Number.isFinite(discountValue) || discountValue <= 0 ||
         discountType === 'percentage' && discountValue > 100 ||
         maxDiscount !== null && (!Number.isFinite(maxDiscount) || maxDiscount <= 0))) {
      return { valid: false, message: `Spin reward ${index + 1} has invalid discount fields.` };
    }
    normalized.push(rewardType === 'free_shipping'
      ? { label, description, termsAndConditions, rewardType, minimumOrderAmount, chance, expiryDays }
      : { label, description, termsAndConditions, rewardType, discountType, discountValue, minimumOrderAmount, maxDiscount, chance, expiryDays });
  }

  if (normalized.reduce((sum, reward) => sum + reward.chance, 0) < 1) {
    return { valid: false, message: 'At least one spin reward must have a positive chance weight.' };
  }
  return { valid: true, rewards: normalized };
};

const chooseOrderSpinReward = (rewards, roll) => {
  const totalWeight = rewards.reduce((sum, reward) => sum + reward.chance, 0);
  if (!Number.isSafeInteger(totalWeight) || totalWeight < 1) {
    throw new RangeError('Spin reward weights must have a positive total.');
  }
  const selectedRoll = roll === undefined ? crypto.randomInt(totalWeight) : roll;
  if (!Number.isInteger(selectedRoll) || selectedRoll < 0 || selectedRoll >= totalWeight) {
    throw new RangeError(`Spin roll must be an integer from 0 to ${totalWeight - 1}.`);
  }
  let cumulativeChance = 0;
  for (const [index, reward] of rewards.entries()) {
    cumulativeChance += reward.chance;
    if (selectedRoll < cumulativeChance) return { ...reward, index };
  }
  throw new Error('Spin reward weights could not select a reward.');
};

module.exports = {
  DEFAULT_ORDER_SPIN_REWARDS,
  LEGACY_DEFAULT_ORDER_SPIN_REWARDS,
  validateOrderSpinRewards,
  chooseOrderSpinReward,
};
