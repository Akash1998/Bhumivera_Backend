const UNSUPPORTED_CLAIM_PATTERNS = [
  /\b(?:100\s*%\s*guaranteed\s+medical\s+cure|cures\s+cancer|anritvox|car\s+equipment\s+upgrades|android\s+player|network\s+marketing|multi[\s-]*level\s+marketing|mlm\s+scheme|pyramid\s+scheme)\b/gi,
];

const cleanProductMarketingText = value => {
  if (typeof value !== 'string') return value;
  return UNSUPPORTED_CLAIM_PATTERNS.reduce(
    (text, pattern) => text.replace(pattern, ''),
    value
  ).replace(/\s{2,}/g, ' ').replace(/\s+([,.;:!?])/g, '$1').trim();
};

const hasUnsupportedProductMarketingClaim = value =>
  typeof value === 'string' &&
  UNSUPPORTED_CLAIM_PATTERNS.some(pattern => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  });

const cleanProductMarketingFields = product => {
  const cleaned = { ...product };
  for (const field of ['name', 'description', 'meta_title', 'meta_description', 'tags']) {
    if (typeof cleaned[field] === 'string') {
      cleaned[field] = cleanProductMarketingText(cleaned[field]);
    }
  }
  return cleaned;
};

const validateProductMarketingFields = fields =>
  ['name', 'description', 'meta_title', 'meta_description', 'tags']
    .some(field => hasUnsupportedProductMarketingClaim(fields[field]));

module.exports = {
  cleanProductMarketingText,
  cleanProductMarketingFields,
  validateProductMarketingFields,
};
