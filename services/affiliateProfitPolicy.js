const roundCurrency = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

const calculateAffiliateProfit = ({
  items,
  merchandiseSubtotal,
  totalMerchandiseDiscount,
  paymentTotal,
  paymentMode,
  commissionSharePercent,
  fulfillmentCost,
  rtoReserve,
  onlinePaymentFeePercent,
  minimumRetainedMarginPercent,
}) => {
  const subtotal = Math.max(0, Number(merchandiseSubtotal) || 0);
  const discount = Math.max(0, Number(totalMerchandiseDiscount) || 0);
  const discountedSubtotal = Math.max(0, subtotal - discount);
  const discountRatio = subtotal > 0 ? Math.min(1, discount / subtotal) : 0;
  const normalizedItems = Array.isArray(items) ? items : [];

  const revenueExcludingTax = roundCurrency(normalizedItems.reduce((sum, item) => {
    const gross = Math.max(0, Number(item.unitPrice) || 0) * Math.max(0, Number(item.quantity) || 0);
    const netGross = gross * (1 - discountRatio);
    const taxRate = Math.max(0, Number(item.gstRate) || 0);
    return sum + (netGross / (1 + taxRate / 100));
  }, 0));
  const productCost = roundCurrency(normalizedItems.reduce((sum, item) =>
    sum + Math.max(0, Number(item.unitCost) || 0) * Math.max(0, Number(item.quantity) || 0), 0));
  const gatewayFee = paymentMode === 'online'
    ? roundCurrency(Math.max(0, Number(paymentTotal) || 0) * Math.max(0, Number(onlinePaymentFeePercent) || 0) / 100)
    : 0;
  const fixedCosts = roundCurrency(Math.max(0, Number(fulfillmentCost) || 0) + Math.max(0, Number(rtoReserve) || 0));
  const contributionProfit = roundCurrency(revenueExcludingTax - productCost - fixedCosts - gatewayFee);
  const commissionBeforeFloor = roundCurrency(Math.max(0, contributionProfit) * Math.max(0, Number(commissionSharePercent) || 0) / 100);
  const retainedMarginFloor = roundCurrency(revenueExcludingTax * Math.max(0, Number(minimumRetainedMarginPercent) || 0) / 100);
  const commissionCap = roundCurrency(Math.max(0, contributionProfit - retainedMarginFloor));
  const commission = roundCurrency(Math.min(commissionBeforeFloor, commissionCap));
  const retainedProfit = roundCurrency(contributionProfit - commission);
  const retainedMarginPercent = revenueExcludingTax > 0
    ? roundCurrency(retainedProfit / revenueExcludingTax * 100)
    : 0;
  const marginFloorMet = revenueExcludingTax > 0 &&
    retainedMarginPercent >= Number(minimumRetainedMarginPercent || 0);

  return {
    discountedSubtotal: roundCurrency(discountedSubtotal),
    revenueExcludingTax,
    productCost,
    fulfillmentCost: roundCurrency(fulfillmentCost),
    rtoReserve: roundCurrency(rtoReserve),
    gatewayFee,
    contributionProfit,
    commission: marginFloorMet ? commission : 0,
    retainedProfit,
    retainedMarginPercent,
    marginFloorMet,
    eligible: marginFloorMet && commission > 0,
  };
};

module.exports = { calculateAffiliateProfit, roundCurrency };
