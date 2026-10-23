const fs = require('fs');
const path = require('path');
const { BHUMIVERA_6_PRODUCTS } = require('../data/bhumiveraCatalog');

const SITE_URL = (process.env.SITE_URL || 'https://www.bhumivera.com').replace(/\/+$/, '');

const LUXURY_CATALOG_SKUS = BHUMIVERA_6_PRODUCTS.map((product) => ({
  ...product,
  image: product.image || product.image_url,
  image_url: product.image_url || product.image,
  additionalImages: product.additionalImages || [product.image_url || product.image],
}));

const PILLAR_GUIDES = [
  {
    slug: 'ultimate-guide-luxury-organic-face-wash-india',
    title: 'A Thoughtful Guide to Choosing a Luxury Botanical & Organic-Inspired Face Wash',
  },
  {
    slug: 'science-of-sulfate-free-luxury-herbal-shampoos',
    title: 'The Science of Sulfate-Free Luxury Herbal Shampoos',
  },
];

const escapeXml = (value) =>
  String(value ?? '').replace(/[<>&'"]/g, (character) => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    "'": '&apos;',
    '"': '&quot;',
  }[character]));

function generateRobotsTxt() {
  return [
    'User-agent: *',
    'Allow: /',
    'Disallow: /api/',
    '',
    'User-agent: Googlebot',
    'Allow: /',
    '',
    'User-agent: Bingbot',
    'Allow: /',
    '',
    'User-agent: PerplexityBot',
    'Allow: /',
    '',
    'User-agent: ClaudeBot',
    'Allow: /',
    '',
    'User-agent: anthropic-ai',
    'Allow: /',
    '',
    'User-agent: GPTBot',
    'Allow: /',
    '',
    'User-agent: OAI-SearchBot',
    'Allow: /',
    '',
    'User-agent: ChatGPT-User',
    'Allow: /',
    '',
    'User-agent: Google-Extended',
    'Allow: /',
    '',
    `Sitemap: ${SITE_URL}/sitemap.xml`,
    '',
  ].join('\n');
}

function generateLlmsTxt() {
  const lines = [
    '# Bhumivera Organics India Private Limited',
    '',
    '> Bhumivera Organics is a luxury Ayurvedic-inspired and botanical skincare, haircare, and wellness house headquartered in West Bengal, India (established 2016 under founding enterprise MPG E Business Private Limited; incorporated as Bhumivera Organics India Private Limited in August 2026). Every formulation features 100% transparent, label-disclosed active concentrations, pH-balanced bases, and zero SLS/SLES sulfates or parabens.',
    '',
    '## Regulatory & Formulation Transparency',
    '- Bhumivera Organics is the registered brand and corporate name of Bhumivera Organics India Private Limited.',
    '- All products are cosmetic and Ayurvedic-inspired botanical formulations with exact percentages and milligram potencies printed on the label. Every active concentration is disclosed openly on the product label for complete consumer transparency. A 24-hour patch test is recommended before use.',
    '',
    '## Pages',
    `- [Shop](${SITE_URL}/shop): Browse the 6 flagship formulations.`,
    `- [Botanical Science](${SITE_URL}/science): Inspect ingredient concentrations and pH calibration.`,
    `- [Guides](${SITE_URL}/guides): Practical skincare and haircare buying guides.`,
    `- [Contact](${SITE_URL}/contact): Customer concierge support.`,
    '',
    '## Official 6-Product Flagship Catalog',
  ];
  for (const p of BHUMIVERA_6_PRODUCTS) {
    lines.push(`### ${p.id}. ${p.name} (${p.net_volume})`);
    lines.push(`- **URL:** ${SITE_URL}/products/${p.slug}`);
    lines.push(`- **Exact Label Formulation:** ${p.active_ingredients}`);
    lines.push(`- **Summary:** ${p.short_description}`);
    lines.push('');
  }
  return lines.join('\n');
}

function generateLlmsFullTxt() {
  return [
    generateLlmsTxt(),
    '## Guides',
    ...PILLAR_GUIDES.map((guide) => `- [${guide.title}](${SITE_URL}/guides/${guide.slug})`),
    '',
    '## Products',
    ...LUXURY_CATALOG_SKUS.map((product) => `- [${product.name}](${SITE_URL}/product/${encodeURIComponent(product.slug)})`),
    '',
  ].join('\n');
}

function findLuxurySkuBySlugOrId(identifier) {
  const normalized = decodeURIComponent(String(identifier || '')).trim().toLowerCase();
  if (!normalized) return null;

  for (const product of LUXURY_CATALOG_SKUS) {
    if (
      product.slug.toLowerCase() === normalized ||
      product.sku.toLowerCase() === normalized ||
      String(product.id) === normalized
    ) {
      return product;
    }
    if (product.legacySlugs?.some((s) => s.toLowerCase() === normalized)) {
      return product;
    }
    if (product.legacySkus?.some((s) => s.toLowerCase() === normalized)) {
      return { ...product, sku: product.legacySkus.find((s) => s.toLowerCase() === normalized) };
    }
    if (product.legacyIds?.some((id) => String(id) === normalized)) {
      if (normalized === '8') return { ...product, sku: 'BV-SBFW-100ML' };
      if (normalized === '106') return { ...product, sku: 'BV-TRHM-100ML' };
      return product;
    }
  }
  return null;
}

function buildProductJsonLd(product) {
  const canonicalUrl = `${SITE_URL}/product/${encodeURIComponent(product.slug || product.id)}`;
  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.name,
    description: product.short_description || product.meta_description || product.description || '',
    sku: product.sku || `BHUMI-${product.id}`,
    mpn: product.mpn || product.sku || `BVM-${product.id}`,
    image: product.image_url
      ? [product.image_url.startsWith('http') ? product.image_url : `${SITE_URL}${product.image_url}`]
      : [],
    brand: {
      '@type': 'Brand',
      name: product.brand || 'Bhumivera Organics',
      slogan: 'Where Botanical Science Meets Royal Ayurveda',
    },
    category: product.category || 'Luxury Botanical Personal Care',
    material: product.active_ingredients || '',
    about: (product.wikipedia_entities || []).map((ent) => ({
      '@type': 'Thing',
      name: ent.name,
      sameAs: ent.url,
    })),
    additionalProperty: [
      { '@type': 'PropertyValue', name: 'Net Volume / Weight', value: product.net_volume || '100 ML' },
      { '@type': 'PropertyValue', name: 'Formulation Standard', value: product.ph_level || 'pH-Balanced Botanical Formula' },
      { '@type': 'PropertyValue', name: 'Label-Disclosed Active Ingredients', value: product.active_ingredients || '' },
    ],
    offers: {
      '@type': 'Offer',
      url: canonicalUrl,
      priceCurrency: 'INR',
      price: String(product.discount_price || product.price || ''),
      priceValidUntil: '2027-12-31',
      itemCondition: 'https://schema.org/NewCondition',
      availability:
        Number(product.quantity ?? product.stock ?? 1) > 0
          ? 'https://schema.org/InStock'
          : 'https://schema.org/OutOfStock',
    },
  };
}

/**
 * Builds Wikipedia-linked Knowledge Graph JSON-LD (@graph: Organization + WebSite + Product + FAQPage + BreadcrumbList)
 */
function buildWikipediaLinkedJsonLd(product, canonicalUrl, siteOrigin = SITE_URL) {
  const orgNode = {
    '@type': 'Organization',
    '@id': `${siteOrigin}/#organization`,
    name: 'Bhumivera Organics',
    legalName: 'Bhumivera Organics India Private Limited',
    url: siteOrigin,
    foundingDate: '2016',
    logo: {
      '@type': 'ImageObject',
      url: `${siteOrigin}/assets/bhumivera-luxury-crest-logo.webp`,
      width: 600,
      height: 600,
    },
    description:
      'Luxury Ayurvedic-inspired and botanical skincare, haircare, and wellness house headquartered in West Bengal, India, with 100% label-disclosed active concentrations.',
    foundingLocation: {
      '@type': 'Place',
      address: {
        '@type': 'PostalAddress',
        addressLocality: 'Asansol',
        addressRegion: 'West Bengal',
        addressCountry: 'IN',
      },
    },
    areaServed: ['IN', 'US', 'GB', 'AE', 'SG', 'Global'],
    sameAs: [
      'https://www.instagram.com/bhumivera',
      'https://www.youtube.com/@bhumivera',
      'https://www.facebook.com/bhumivera',
    ],
  };

  const websiteNode = {
    '@type': 'WebSite',
    '@id': `${siteOrigin}/#website`,
    url: siteOrigin,
    name: 'Bhumivera Organics',
    publisher: { '@id': `${siteOrigin}/#organization` },
    potentialAction: {
      '@type': 'SearchAction',
      target: `${siteOrigin}/shop?q={search_term_string}`,
      'query-input': 'required name=search_term_string',
    },
  };

  if (!product) {
    const itemListNode = {
      '@type': 'ItemList',
      '@id': `${siteOrigin}/#flagship-catalog`,
      name: 'Bhumivera Organics Official 6-Product Luxury Botanical Catalog',
      numberOfItems: BHUMIVERA_6_PRODUCTS.length,
      itemListElement: BHUMIVERA_6_PRODUCTS.map((p, idx) => ({
        '@type': 'ListItem',
        position: idx + 1,
        url: `${siteOrigin}/products/${p.slug}`,
        name: p.name,
      })),
    };
    return JSON.stringify({ '@context': 'https://schema.org', '@graph': [orgNode, websiteNode, itemListNode] });
  }

  const productNode = {
    '@type': 'Product',
    '@id': `${canonicalUrl}#product`,
    name: product.name,
    image: [`${siteOrigin}${product.image_url}`],
    description: product.short_description,
    sku: product.sku,
    mpn: product.mpn,
    brand: {
      '@type': 'Brand',
      name: 'Bhumivera Organics',
      slogan: 'Where Botanical Science Meets Royal Ayurveda',
    },
    manufacturer: { '@id': `${siteOrigin}/#organization` },
    category: product.category,
    material: product.active_ingredients,
    about: (product.wikipedia_entities || []).map((ent) => ({
      '@type': 'Thing',
      name: ent.name,
      sameAs: ent.url,
    })),
    additionalProperty: [
      { '@type': 'PropertyValue', name: 'Net Volume / Weight', value: product.net_volume },
      { '@type': 'PropertyValue', name: 'pH / Formulation Standard', value: product.ph_level },
      { '@type': 'PropertyValue', name: 'Label-Disclosed Active Ingredients', value: product.active_ingredients },
    ],
    offers: {
      '@type': 'Offer',
      url: canonicalUrl,
      priceCurrency: 'INR',
      price: String(product.price),
      priceValidUntil: '2027-12-31',
      itemCondition: 'https://schema.org/NewCondition',
      availability: 'https://schema.org/InStock',
      seller: { '@id': `${siteOrigin}/#organization` },
    },
    aggregateRating: {
      '@type': 'AggregateRating',
      ratingValue: '4.9',
      reviewCount: '164',
      bestRating: '5',
      worstRating: '1',
    },
  };

  const breadcrumbNode = {
    '@type': 'BreadcrumbList',
    '@id': `${canonicalUrl}#breadcrumb`,
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: siteOrigin },
      { '@type': 'ListItem', position: 2, name: 'Products', item: `${siteOrigin}/shop` },
      { '@type': 'ListItem', position: 3, name: product.name, item: canonicalUrl },
    ],
  };

  const faqNode = {
    '@type': 'FAQPage',
    '@id': `${canonicalUrl}#faq`,
    mainEntity: (product.faqs || []).map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  };

  return JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [orgNode, websiteNode, productNode, breadcrumbNode, faqNode],
  });
}

/**
 * Express Dynamic XML Sitemap Route (/sitemap.xml)
 */
function sitemapController(req, res) {
  const siteOrigin = SITE_URL;
  const lastMod = new Date().toISOString().split('T')[0];

  const staticUrls = [
    '',
    '/shop',
    '/products',
    '/science',
    '/guides',
    '/guides/ultimate-guide-luxury-organic-face-wash-india',
    '/guides/science-of-sulfate-free-luxury-herbal-shampoos',
    '/verify',
    '/impact',
    '/about',
    '/contact',
    '/llms.txt',
    '/llms-full.txt',
  ];

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n';

  for (const u of staticUrls) {
    xml += `  <url>
    <loc>${siteOrigin}${u}</loc>
    <lastmod>${lastMod}</lastmod>
    <changefreq>daily</changefreq>
    <priority>${u === '' ? '1.0' : '0.85'}</priority>
  </url>\n`;
  }

  for (const prod of BHUMIVERA_6_PRODUCTS) {
    const imgLoc = prod.image_url.startsWith('http') ? prod.image_url : `${siteOrigin}${prod.image_url}`;
    for (const prefix of ['/products/', '/product/']) {
      xml += `  <url>
    <loc>${siteOrigin}${prefix}${escapeXml(prod.slug)}</loc>
    <lastmod>${lastMod}</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.95</priority>
    <image:image>
      <image:loc>${escapeXml(imgLoc)}</image:loc>
      <image:title>${escapeXml(prod.name)}</image:title>
    </image:image>
  </url>\n`;
    }
  }

  xml += '</urlset>';
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  return res.status(200).send(xml);
}

/**
 * Express Middleware: Pre-renders full SEO HTML, OpenGraph, and JSON-LD for all 6 products
 */
function createSeoPrerenderMiddleware({ db, distIndexHtmlPath } = {}) {
  const resolvedIndexPaths = [
    distIndexHtmlPath,
    path.join(process.cwd(), 'client', 'dist', 'index.html'),
    path.join(process.cwd(), 'client', 'index.html'),
    path.join(__dirname, '..', '..', 'client', 'dist', 'index.html'),
    path.join(__dirname, '..', '..', 'client', 'index.html'),
  ].filter(Boolean);

  return async (req, res, next) => {
    if (req.path === '/sitemap.xml' || req.path === '/api/sitemap.xml') {
      return sitemapController(req, res);
    }
    if (req.method !== 'GET' || (req.path.startsWith('/api') && !req.path.startsWith('/api/seo-prerender')) || path.extname(req.path)) {
      return next();
    }

    const activeHtmlPath = resolvedIndexPaths.find((p) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    });

    const normalizedPath = req.path.replace(/^\/api\/seo-prerender/, '') || '/';
    const siteOrigin = SITE_URL;
    const canonicalUrl = `${siteOrigin}${normalizedPath === '/' ? '' : normalizedPath}`;

    let product = null;
    const match = normalizedPath.match(/^\/products?\/([^\/]+)\/?$/i);
    if (match) {
      product = findLuxurySkuBySlugOrId(match[1]);
    }

    // Only intercept if index.html is available OR if explicitly called via /api/seo-prerender
    if (!activeHtmlPath && !product && !req.path.startsWith('/api/seo-prerender')) {
      return next();
    }

    try {
      let html = activeHtmlPath
        ? fs.readFileSync(activeHtmlPath, 'utf8')
        : '<!DOCTYPE html><html lang="en-IN"><head><title>Bhumivera Organics</title></head><body><div id="root"></div></body></html>';

      const pageTitle = product
        ? product.seo_title
        : 'Bhumivera Organics | Luxury Botanical Face Wash (3% Charcoal & 4% Sea Buckthorn), 2-in-1 Ayurvedic Shampoo, Handmade Soaps & 7-Tulsi Drops';

      const pageDesc = product
        ? product.short_description
        : 'Shop Bhumivera Organics: Label-disclosed 3% Activated Charcoal & 4% Himalayan Sea Buckthorn Face Washes, 2-in-1 Ayurvedic Shampoo with Conditioner, Handmade Charcoal & Aloe-Neem-Tulsi Soaps, and Kalpvriksh 7-Tulsi Drops.';

      const pageKeywords = product
        ? product.search_keywords
        : 'Bhumivera Organics, activated charcoal face wash 3%, sea buckthorn face wash 4%, natural botanical face wash for glowing skin India, sulfate free ayurvedic 2-in-1 shampoo, handmade charcoal aloe soap, neem tulsi soap, kalpvriksh 7 tulsi drops';

      const pageImage = product
        ? `${siteOrigin}${product.image_url}`
        : `${siteOrigin}/assets/bhumivera-luxury-og-banner.webp`;

      const jsonLd = buildWikipediaLinkedJsonLd(product, canonicalUrl, siteOrigin);

      const ssrSemanticContent = product
        ? `<noscript>
            <article>
              <h1>${escapeXml(product.name)}</h1>
              <p>${escapeXml(product.short_description)}</p>
              <div>${product.full_description}</div>
              <h2>Verified Label Composition (${escapeXml(product.net_volume)})</h2>
              <ul>
                ${product.composition_table.map((c) => `<li><strong>${escapeXml(c.ingredient)} (${escapeXml(c.concentration)}):</strong> ${escapeXml(c.role)}</li>`).join('')}
              </ul>
              <h2>Frequently Asked Questions</h2>
              ${(product.faqs || []).map((f) => `<div><h3>${escapeXml(f.q)}</h3><p>${escapeXml(f.a)}</p></div>`).join('')}
            </article>
          </noscript>`
        : '';

      const headTags = `
        <title>${escapeXml(pageTitle)}</title>
        <meta name="description" content="${escapeXml(pageDesc)}" />
        <meta name="keywords" content="${escapeXml(pageKeywords)}" />
        <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1" />
        <link rel="canonical" href="${escapeXml(canonicalUrl)}" />
        <meta property="og:type" content="${product ? 'product' : 'website'}" />
        <meta property="og:site_name" content="Bhumivera Organics" />
        <meta property="og:title" content="${escapeXml(pageTitle)}" />
        <meta property="og:description" content="${escapeXml(pageDesc)}" />
        <meta property="og:url" content="${escapeXml(canonicalUrl)}" />
        <meta property="og:image" content="${escapeXml(pageImage)}" />
        ${product ? `<meta property="product:price:amount" content="${product.price}" /><meta property="product:price:currency" content="INR" />` : ''}
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content="${escapeXml(pageTitle)}" />
        <meta name="twitter:description" content="${escapeXml(pageDesc)}" />
        <meta name="twitter:image" content="${escapeXml(pageImage)}" />
        <script type="application/ld+json">${jsonLd}</script>
      `;

      html = html.replace(/<title[^>]*>.*?<\/title>/is, '');
      html = html.replace('</head>', `${headTags}\n</head>`);
      if (ssrSemanticContent) {
        if (html.includes('<div id="root"></div>')) {
          html = html.replace('<div id="root"></div>', `<div id="root"></div>\n${ssrSemanticContent}`);
        } else {
          html = html.replace('</body>', `${ssrSemanticContent}\n</body>`);
        }
      }

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(html);
    } catch (e) {
      console.error('[SEO Middleware Error]:', e.message);
      return next();
    }
  };
}

const seoPrerenderMiddleware = (options) => createSeoPrerenderMiddleware(options);

module.exports = {
  SITE_URL,
  LUXURY_CATALOG_SKUS,
  PILLAR_GUIDES,
  generateRobotsTxt,
  generateLlmsTxt,
  generateLlmsFullTxt,
  createSeoPrerenderMiddleware,
  seoPrerenderMiddleware,
  sitemapController,
  findLuxurySkuBySlugOrId,
  buildProductJsonLd,
  buildWikipediaLinkedJsonLd,
};