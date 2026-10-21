const DEFAULT_TIERS = [
  { name: 'Bronze', min_points: 0 },
  { name: 'Silver', min_points: 500 },
  { name: 'Gold', min_points: 1000 },
  { name: 'Platinum', min_points: 5000 },
];

function computeLoyaltyTier(points, tiers = DEFAULT_TIERS) {
  const totalPoints = Math.max(0, Number(points) || 0);
  const orderedTiers = (Array.isArray(tiers) ? tiers : DEFAULT_TIERS)
    .filter(tier => tier && Number.isFinite(Number(tier.min_points)))
    .slice()
    .sort((left, right) => Number(left.min_points) - Number(right.min_points));
  const safeTiers = orderedTiers.length ? orderedTiers : DEFAULT_TIERS;
  let currentIndex = 0;
  for (let index = 0; index < safeTiers.length; index += 1) {
    if (totalPoints >= Number(safeTiers[index].min_points)) currentIndex = index;
    else break;
  }
  const currentTier = safeTiers[currentIndex];
  const nextTier = safeTiers[currentIndex + 1] || null;
  const currentMinimum = Number(currentTier.min_points) || 0;
  const nextMinimum = nextTier ? Number(nextTier.min_points) : currentMinimum;
  const span = nextMinimum - currentMinimum;
  const progressPct = nextTier && span > 0
    ? Math.max(0, Math.min(100, Math.round((totalPoints - currentMinimum) * 100 / span)))
    : 100;

  return {
    points: totalPoints,
    currentTier: currentTier.name,
    currentTierDetails: currentTier,
    nextTier: nextTier?.name || null,
    nextTierName: nextTier?.name || null,
    nextTierPointsRequired: nextTier ? Math.max(0, nextMinimum - totalPoints) : 0,
    progressPct,
  };
}

module.exports = { computeLoyaltyTier, DEFAULT_TIERS };
