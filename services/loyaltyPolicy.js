const toCents = value => Math.round(Math.max(0, Number(value) || 0) * 100);
const toPercent = value => Math.max(0, Math.min(100, Number(value) || 0));

const calculateTierDiscount = (subtotal, priorDiscounts, tierDiscountPercent, enabled = true) => {
  if (!enabled) return 0;
  const merchandiseCents = toCents(subtotal);
  const remainingCents = Math.max(0, merchandiseCents - toCents(priorDiscounts));
  const configuredCents = Math.floor(merchandiseCents * toPercent(tierDiscountPercent) / 100);
  return Math.min(remainingCents, configuredCents) / 100;
};

const calculateLoyaltyRedemption = ({
  pointsBalance,
  eligibleSubtotal,
  redemptionPointsPerRupee,
  maxRedemptionPercent,
  minimumRedemptionPoints,
  enabled = true,
}) => {
  const balance = Math.floor(Math.max(0, Number(pointsBalance) || 0));
  const pointsPerRupee = Math.max(1, Math.trunc(Number(redemptionPointsPerRupee) || 1));
  const minimumPoints = Math.max(0, Math.trunc(Number(minimumRedemptionPoints) || 0));
  if (!enabled || balance < minimumPoints) return { points: 0, discount: 0 };

  const eligibleCents = toCents(eligibleSubtotal);
  const maximumDiscountCents = Math.floor(eligibleCents * toPercent(maxRedemptionPercent) / 100);
  const points = Math.min(balance, Math.floor(maximumDiscountCents * pointsPerRupee / 100));
  if (points < minimumPoints) return { points: 0, discount: 0 };
  return { points, discount: Math.min(maximumDiscountCents, Math.floor(points * 100 / pointsPerRupee)) / 100 };
};

const calculateLoyaltyPointsAward = ({
  eligibleSpend,
  pointsPerRupee,
  tierMultiplier,
  tierBonusPoints,
  cashbackPercent,
  redemptionPointsPerRupee,
  enabled = true,
}) => {
  if (!enabled) return 0;
  const spendCents = toCents(eligibleSpend);
  const earnRate = Math.max(0, Number(pointsPerRupee) || 0);
  const multiplier = Math.max(0, Math.min(10, Number(tierMultiplier) || 1));
  const basePoints = Math.floor(spendCents / 100 * earnRate * multiplier);
  const cashbackRate = toPercent(cashbackPercent);
  const redemptionRate = Math.max(1, Math.trunc(Number(redemptionPointsPerRupee) || 1));
  const cashbackPoints = Math.floor(spendCents / 100 * cashbackRate / 100 * redemptionRate);
  const bonus = spendCents > 0 ? Math.max(0, Math.trunc(Number(tierBonusPoints) || 0)) : 0;
  return Math.min(1000000, basePoints + cashbackPoints + bonus);
};

module.exports = {
  calculateTierDiscount,
  calculateLoyaltyRedemption,
  calculateLoyaltyPointsAward,
};