const { LUXURY_CATALOG } = require('../data/luxuryCatalog');

const SITE_URL = (process.env.SITE_URL || 'https://www.bhumivera.com').replace(/\/+$/, '');
const LUXURY_CATALOG_SKUS = LUXURY_CATALOG.map(product => ({
  ...product,
  image_url: product.image,
}));
const PILLAR_GUIDES = [
  {
    slug: 'ultimate-guide-luxury-organic-face-wash-india',
    title: 'A Thoughtful Guide to Choosing a Luxury Organic Face Wash',
  },
  {
    slug: 'science-of-sulfate-free-luxury-herbal-shampoos',
    title: 'The Science of Sulfate-Free Luxury Herbal Shampoos',
  },
];

const escapeXml = value => String(value).replace(/[<>&'"]/g, character => ({
  '<': '&lt;',
  '>': '&gt;',
  '&': '&amp;',
  "'": '&apos;',
  '"': '&quot;',
}[character]));

const generateRobotsTxt = () => [
  'User-agent: *',
  'Allow: /',
  'Disallow: /api/',
  `Sitemap: ${SITE_URL}/sitemap.xml`,
  '',
].join('\n');

const generateLlmsTxt = () => [
  '# Bhumivera Organics',
  '',
  'Botanical skincare and haircare, established in 2016.',
  '',
  '## Pages',
  `- [Shop](${SITE_URL}/shop): Browse the botanical collection.`,
  `- [Botanical science](${SITE_URL}/science): Learn about product ingredients and formulation.`,
  `- [Guides](${SITE_URL}/guides): Practical skincare and haircare guides.`,
  `- [Contact](${SITE_URL}/contact): Contact customer support.`,
  '',
].join('\n');

const generateLlmsFullTxt = () => [
  generateLlmsTxt(),
  '## Guides',
  ...PILLAR_GUIDES.map(guide => `- [${guide.title}](${SITE_URL}/guides/${guide.slug})`),
  '',
  '## Products',
  ...LUXURY_CATALOG_SKUS.map(product => `- [${product.name}](${SITE_URL}/product/${encodeURIComponent(product.slug)})`),
  '',
].join('\n');

const findLuxurySkuBySlugOrId = identifier => {
  const normalized = decodeURIComponent(String(identifier || '')).trim().toLowerCase();
  return LUXURY_CATALOG_SKUS.find(product =>
    product.slug.toLowerCase() === normalized || product.sku.toLowerCase() === normalized
  ) || null;
};

const buildProductJsonLd = product => ({
  '@context': 'https://schema.org',
  '@type': 'Product',
  name: product.name,
  description: product.meta_description || product.description || '',
  sku: product.sku || `BHUMI-${product.id}`,
  image: product.image_url
    ? [product.image_url.startsWith('http') ? product.image_url : `${SITE_URL}${product.image_url}`]
    : [],
  brand: { '@type': 'Brand', name: product.brand || 'Bhumivera' },
  offers: {
    '@type': 'Offer',
    url: `${SITE_URL}/product/${encodeURIComponent(product.slug || product.id)}`,
    priceCurrency: 'INR',
    price: String(product.discount_price || product.price || ''),
    availability: Number(product.quantity) > 0
      ? 'https://schema.org/InStock'
      : 'https://schema.org/OutOfStock',
  },
});

const seoPrerenderMiddleware = () => (req, res, next) => next();

module.exports = {
  SITE_URL,
  LUXURY_CATALOG_SKUS,
  PILLAR_GUIDES,
  generateRobotsTxt,
  generateLlmsTxt,
  generateLlmsFullTxt,
  seoPrerenderMiddleware,
  findLuxurySkuBySlugOrId,
  buildProductJsonLd,
};
