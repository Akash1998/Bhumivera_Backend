const PREMIUM_DELIVERY_THRESHOLD = 799;
const PREMIUM_DELIVERY_SURCHARGE = 100;

const calculateShippingCost = ({
  deliveryType,
  cartSubtotal,
  standardCharge,
  premiumCharge,
  freeShippingThreshold,
  freeShipping = false,
}) => {
  const subtotal = Math.max(0, Number(cartSubtotal) || 0);
  const standardRate = Number(standardCharge);
  const premiumRate = Number(premiumCharge);
  const threshold = Number(freeShippingThreshold);
  const standardIsFree = Boolean(freeShipping) ||
    (Number.isFinite(threshold) && threshold > 0 && subtotal >= threshold);
  const standardCost = standardIsFree || !Number.isFinite(standardRate)
    ? 0
    : Math.max(0, standardRate);

  if (deliveryType !== 'express') return standardCost;
  if (subtotal < PREMIUM_DELIVERY_THRESHOLD) return standardCost + PREMIUM_DELIVERY_SURCHARGE;
  return Number.isFinite(premiumRate) ? Math.max(0, premiumRate) : 0;
};

module.exports = {
  PREMIUM_DELIVERY_SURCHARGE,
  PREMIUM_DELIVERY_THRESHOLD,
  calculateShippingCost,
};
