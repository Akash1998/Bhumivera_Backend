const toNumber = value => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

function evaluateCartRules(subtotal, rules = [], userProfile = {}) {
  const cartSubtotal = Math.max(0, toNumber(subtotal));
  const nowValue = userProfile.now ?? Date.now();
  const now = nowValue instanceof Date ? nowValue.getTime() : Number(nowValue);
  const currentTime = Number.isFinite(now) ? now : Date.now();
  const activeRules = (Array.isArray(rules) ? rules : []).filter(rule => {
    if (!rule || rule.status === 'inactive' || rule.status === 0 || rule.status === false) return false;
    if (rule.loyalty_tier_id !== null && rule.loyalty_tier_id !== undefined &&
      String(rule.loyalty_tier_id) !== String(userProfile.loyaltyTierId)) return false;
    if (rule.customer_id !== null && rule.customer_id !== undefined &&
      String(rule.customer_id) !== String(userProfile.userId)) return false;
    const start = rule.start_time ? new Date(rule.start_time).getTime() : null;
    const end = rule.end_time ? new Date(rule.end_time).getTime() : null;
    return (start === null || (Number.isFinite(start) && start <= currentTime)) &&
      (end === null || (Number.isFinite(end) && end >= currentTime));
  });
  const enforcedRules = userProfile.enforceMinimum !== false
    ? activeRules.filter(rule => Number(rule.enforce_min_checkout) === 1 && cartSubtotal < toNumber(rule.min_cart_value))
    : [];
  const enforcedMin = enforcedRules.reduce((minimum, rule) => Math.max(minimum, toNumber(rule.min_cart_value)), 0) || null;
  const matchedRules = activeRules
    .filter(rule => cartSubtotal >= toNumber(rule.min_cart_value) &&
      (rule.max_cart_value === null || rule.max_cart_value === undefined || rule.max_cart_value === '' || cartSubtotal <= toNumber(rule.max_cart_value)))
    .sort((a, b) => toNumber(b.priority) - toNumber(a.priority) || toNumber(a.id) - toNumber(b.id));

  const rawDiscount = matchedRules.reduce((total, rule) => {
    const fixed = Math.max(0, toNumber(rule.discount_amount));
    const percent = Math.max(0, toNumber(rule.discount_percent));
    return total + fixed + cartSubtotal * percent / 100;
  }, 0);
  const gifts = matchedRules
    .filter(rule => rule.gift_product_id !== null && rule.gift_product_id !== undefined)
    .map(rule => ({
      ruleId: rule.id,
      productId: Number(rule.gift_product_id),
      productName: rule.gift_product_name || null,
      productSku: rule.gift_product_sku || null,
      quantity: Math.max(1, Math.trunc(toNumber(rule.gift_quantity)) || 1),
    }));
  const matchedIds = new Set(matchedRules.map(rule => String(rule.id)));
  const tiers = activeRules.map(rule => {
    const minimum = toNumber(rule.min_cart_value);
    const maximum = rule.max_cart_value === null || rule.max_cart_value === undefined || rule.max_cart_value === ''
      ? null
      : toNumber(rule.max_cart_value);
    return {
      id: rule.id,
      name: rule.name,
      badge: rule.badge_text || rule.name,
      minCartValue: minimum,
      maxCartValue: maximum,
      unlocked: matchedIds.has(String(rule.id)),
      missingAmount: Math.max(0, minimum - cartSubtotal),
      progressPct: minimum > 0 ? Math.min(100, Math.max(0, cartSubtotal * 100 / minimum)) : 100,
      freeShipping: Number(rule.free_shipping_enabled) === 1,
    };
  });

  return {
    matchedRuleIds: matchedRules.map(rule => rule.id),
    matchedRules,
    tiers,
    totalDiscount: Math.min(cartSubtotal, Math.max(0, Number(rawDiscount.toFixed(2)))),
    gifts,
    freeShipping: matchedRules.some(rule => Number(rule.free_shipping_enabled) === 1),
    loyaltyBonusPoints: matchedRules.reduce((total, rule) => total + Math.max(0, Math.trunc(toNumber(rule.loyalty_bonus_points))), 0),
    badges: matchedRules.map(rule => rule.badge_text).filter(Boolean),
    membershipTier: userProfile.loyaltyTierName || null,
    enforcedMin,
    missingAmount: enforcedMin === null ? 0 : Math.max(0, enforcedMin - cartSubtotal),
  };
}

module.exports = { evaluateCartRules };
