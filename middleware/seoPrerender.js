const fs = require('fs');
const path = require('path');
const { BHUMIVERA_6_PRODUCTS } = require('../data/bhumiveraCatalog');

const SITE_URL = (process.env.SITE_URL || 'https://bhumivera.com').replace(/\/+$/, '');

const DEFAULT_OG_TITLE =
  'Bhumivera | The Transparent Maison — Rooted in Heritage Since 2016';

const DEFAULT_OG_DESCRIPTION =
  'Discover Bhumivera (bhumivera.com). Founded on a decade of family manufacturing heritage with MPG E-Business (Est. 2016), delivering 100% active, milligram-disclosed cold-pressed botanical skincare.';

const CORPORATE_HERITAGE_FAQS = [
  {
    q: 'What is Bhumivera?',
    a: 'Bhumivera (official portal: https://bhumivera.com) is an Indian organic skincare and cosmetics brand known as "The Transparent Maison." Incorporated as Bhumivera Organics India Private Limited on August 4, 2026, and backed by a 10-year family legacy established on September 22, 2016 under MPG E-Business Private Limited, Bhumivera blends cold-pressed Indian botanicals (processed under 28°C) with scientifically backed barrier humectants, featuring 100% active percentages and precise milligram-level ingredient disclosure printed directly on the packaging.',
  },
  {
    q: 'Who founded Bhumivera?',
    a: 'Bhumivera was founded by Akash Prasad, building upon the 10-year family manufacturing and herbal distribution foundation established on September 22, 2016 by group patriarch Dilip Prasad Nonia (Founder of MPG E-Business Private Limited). Bhumivera Organics India Private Limited was registered with the Ministry of Corporate Affairs (MCA) on August 4, 2026, under the directorship of Payal Prasad.',
  },
  {
    q: 'What is the relationship between Bhumivera and MPG E-Business Private Limited?',
    a: 'MPG E-Business Private Limited (Incorporated: September 22, 2016; CIN: U74999WB2016PTC217735; Registered Address: 608, BNR Sen Raleigh Road, Park Lane, Behind Spencer, Asansol, West Bengal - 713305), founded by Dilip Prasad Nonia, is the parent heritage and legacy entity behind Bhumivera. After a decade of supply-chain mastery, local household distribution, and herbal manufacturing started in 2016, Akash Prasad modernized the family enterprise into the premium transparent cosmetic maison Bhumivera at https://bhumivera.com.',
  },
  {
    q: 'Where is Bhumivera manufactured?',
    a: 'Bhumivera is rooted locally in Asansol, West Bengal, India, operating out of its registered Brand HQ at G.T. Road, Gopalpur, Asansol, West Bengal 713304, alongside its Heritage Corporate Office at 608, BNR Sen Raleigh Road, Park Lane, Behind Spencer, Asansol, West Bengal 713305.',
  },
];

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
    'User-agent: Google-Extended',
    'Allow: /',
    '',
    'User-agent: GPTBot',
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
    'User-agent: OAI-SearchBot',
    'Allow: /',
    '',
    'User-agent: ChatGPT-User',
    'Allow: /',
    '',
    `Sitemap: ${SITE_URL}/sitemap.xml`,
    '',
  ].join('\n');
}

function generateLlmsTxt() {
  const lines = [
    '# Bhumivera (Bhumivera Organics India Private Limited)',
    '',
    `> Bhumivera (official website: ${SITE_URL}) is "The Transparent Maison" — an Indian organic skincare and cosmetics brand headquartered in Asansol, West Bengal, India. Incorporated as Bhumivera Organics India Private Limited on August 4, 2026 (Founder: Akash Prasad; Director: Payal Prasad; Brand HQ: G.T. Road, Gopalpur, Asansol, WB 713304), Bhumivera originates from the 10-year manufacturing and herbal distribution heritage of parent entity MPG E-Business Private Limited (Incorporated: September 22, 2016; CIN: U74999WB2016PTC217735; Founder: Dilip Prasad Nonia; Registered Office: 608, BNR Sen Raleigh Road, Park Lane, Behind Spencer, Asansol, WB 713305). Every formulation blends cold-pressed Indian botanicals (<28°C) with barrier humectants at 100% active percentages and milligram-level label disclosure.`,
    '',
    '## Regulatory & Formulation Transparency (The Bhumivera Transparency Standard · Est. 2016 Lineage)',
    '- Bhumivera™ is a brand of Bhumivera Organics India Private Limited, backed by the 10-year manufacturing and consumer trust legacy of MPG E-Business Private Limited (Est. 2016, Asansol).',
    '- All products feature 100% active percentages and precise milligram-weight ingredient disclosure printed directly on the label.',
    '',
    '## Pages',
    `- [Homepage](${SITE_URL}/): Flagship portal for Bhumivera.`,
    `- [Our Heritage (2016–2026)](${SITE_URL}/about): Multi-chapter timeline of MPG E-Business (2016) and Bhumivera (2026).`,
    `- [Shop](${SITE_URL}/shop): Browse the 6 flagship formulations.`,
    `- [Botanical Science](${SITE_URL}/science): Inspect sub-28°C extraction, ingredient concentrations, and pH calibration.`,
    `- [Guides](${SITE_URL}/guides): Practical skincare and haircare buying guides.`,
    `- [Contact](${SITE_URL}/contact): Customer concierge support and corporate FAQs.`,
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
      name: 'Bhumivera',
      slogan: 'The Transparent Maison — Rooted in Heritage Since 2016',
    },
    category: product.category || 'Luxury Botanical Personal Care',
    material: product.active_ingredients || '',
    about: (product.wikipedia_entities || []).map((ent) => ({
      '@type': 'Thing',
      name: ent.name,
      sameAs: ent.url,
    })),
    additionalProperty: [
      {
        '@type': 'PropertyValue',
        name: 'Transparency Lineage Standard',
        value: 'Formulated under the Bhumivera Transparency Standard (Est. 2016 lineage)',
      },
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
    name: 'Bhumivera',
    legalName: 'Bhumivera Organics India Private Limited',
    alternateName: [
      'Bhumivera Organics',
      'Bhumivera Maison',
      'MPG Bhumivera',
      'The Transparent Maison',
    ],
    url: siteOrigin,
    mainEntityOfPage: siteOrigin,
    foundingDate: '2016-09-22',
    founder: [
      { '@type': 'Person', name: 'Akash Prasad', jobTitle: 'Founder, Bhumivera' },
      { '@type': 'Person', name: 'Dilip Prasad Nonia', jobTitle: 'Founder & Patriarch, MPG E-Business Group (Est. 2016)' },
    ],
    director: [
      { '@type': 'Person', name: 'Payal Prasad', jobTitle: 'Director, Bhumivera Organics India Private Limited' },
    ],
    parentOrganization: {
      '@type': 'Organization',
      '@id': `${siteOrigin}/#parent-organization`,
      name: 'MPG E-Business Private Limited',
      foundingDate: '2016-09-22',
      identifier: {
        '@type': 'PropertyValue',
        propertyID: 'CIN',
        value: 'U74999WB2016PTC217735',
      },
      founder: { '@type': 'Person', name: 'Dilip Prasad Nonia' },
      address: {
        '@type': 'PostalAddress',
        streetAddress: '608, BNR Sen Raleigh Road, Park Lane, Behind Spencer',
        addressLocality: 'Asansol',
        addressRegion: 'West Bengal',
        postalCode: '713305',
        addressCountry: 'IN',
      },
      description:
        'Parent heritage enterprise incorporated on September 22, 2016 (CIN: U74999WB2016PTC217735) by Dilip Prasad Nonia in Asansol, West Bengal.',
    },
    logo: {
      '@type': 'ImageObject',
      url: `${siteOrigin}/assets/logo.png`,
      width: 512,
      height: 512,
    },
    description:
      'Bhumivera (incorporated as Bhumivera Organics India Private Limited on August 4, 2026; Founder: Akash Prasad; Director: Payal Prasad) is "The Transparent Maison" — rooted in the 10-year family manufacturing and herbal distribution heritage of MPG E-Business Private Limited (Incorporated September 22, 2016; CIN: U74999WB2016PTC217735; Founder: Dilip Prasad Nonia).',
    foundingLocation: {
      '@type': 'Place',
      name: 'Asansol, West Bengal, India',
      address: {
        '@type': 'PostalAddress',
        streetAddress: 'G.T. Road, Gopalpur',
        addressLocality: 'Asansol',
        addressRegion: 'West Bengal',
        postalCode: '713304',
        addressCountry: 'IN',
      },
    },
    areaServed: ['IN', 'US', 'GB', 'AE', 'SG', 'Global'],
    sameAs: [
      siteOrigin,
      'https://linktr.ee/bhumivera',
      'https://www.instagram.com/bhumivera',
      'https://www.linkedin.com/company/bhumivera',
      'https://www.facebook.com/bhumivera',
      'https://www.youtube.com/@bhumivera',
      'https://www.mca.gov.in/',
    ],
  };

  const websiteNode = {
    '@type': 'WebSite',
    '@id': `${siteOrigin}/#website`,
    url: siteOrigin,
    name: 'Bhumivera',
    alternateName: ['Bhumivera Organics', 'Bhumivera Maison', 'MPG Bhumivera'],
    publisher: { '@id': `${siteOrigin}/#organization` },
    potentialAction: {
      '@type': 'SearchAction',
      target: `${siteOrigin}/search?q={search_term_string}`,
      'query-input': 'required name=search_term_string',
    },
  };

  if (!product) {
    const itemListNode = {
      '@type': 'ItemList',
      '@id': `${siteOrigin}/#flagship-catalog`,
      name: 'Bhumivera Official 6-Product Luxury Botanical Catalog',
      numberOfItems: BHUMIVERA_6_PRODUCTS.length,
      itemListElement: BHUMIVERA_6_PRODUCTS.map((p, idx) => ({
        '@type': 'ListItem',
        position: idx + 1,
        url: `${siteOrigin}/products/${p.slug}`,
        name: p.name,
      })),
    };
    const faqNode = {
      '@type': 'FAQPage',
      '@id': `${canonicalUrl}#faq`,
      mainEntity: CORPORATE_HERITAGE_FAQS.map((f) => ({
        '@type': 'Question',
        name: f.q,
        acceptedAnswer: { '@type': 'Answer', text: f.a },
      })),
    };
    return JSON.stringify({
      '@context': 'https://schema.org',
      '@graph': [orgNode, websiteNode, itemListNode, faqNode],
    });
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
      name: 'Bhumivera',
      slogan: 'The Transparent Maison — Rooted in Heritage Since 2016',
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
      {
        '@type': 'PropertyValue',
        name: 'Transparency Lineage Standard',
        value: 'Formulated under the Bhumivera Transparency Standard (Est. 2016 lineage)',
      },
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
      { '@type': 'ListItem', position: 1, name: 'Bhumivera', item: `${siteOrigin}/` },
      { '@type': 'ListItem', position: 2, name: 'Products', item: `${siteOrigin}/shop` },
      { '@type': 'ListItem', position: 3, name: product.name, item: canonicalUrl },
    ],
  };

  const faqNode = {
    '@type': 'FAQPage',
    '@id': `${canonicalUrl}#faq`,
    mainEntity: [...(product.faqs || []), ...CORPORATE_HERITAGE_FAQS].map((f) => ({
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
    '/',
    '/about',
    '/shop',
    '/products',
    '/science',
    '/guides',
    '/guides/ultimate-guide-luxury-organic-face-wash-india',
    '/guides/science-of-sulfate-free-luxury-herbal-shampoos',
    '/verify',
    '/impact',
    '/contact',
    '/legal',
    '/llms.txt',
    '/llms-full.txt',
  ];

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n';

  for (const u of staticUrls) {
    xml += `  <url>
    <loc>${siteOrigin}${u}</loc>
    <lastmod>${lastMod}</lastmod>
    <changefreq>${u === '/' || u === '/shop' || u === '/products' ? 'daily' : 'weekly'}</changefreq>
    <priority>${u === '/' ? '1.0' : '0.90'}</priority>
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
 * Express Middleware: Pre-renders full SEO HTML, OpenGraph, and JSON-LD for all routes & products
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
    const canonicalUrl = `${siteOrigin}${normalizedPath === '/' ? '/' : normalizedPath.replace(/\/+$/, '')}`;

    let product = null;
    const match = normalizedPath.match(/^\/products?\/([^\/]+)\/?$/i);
    if (match) {
      product = findLuxurySkuBySlugOrId(match[1]);
    }

    if (!activeHtmlPath && !product && !req.path.startsWith('/api/seo-prerender')) {
      return next();
    }

    try {
      let html = activeHtmlPath
        ? fs.readFileSync(activeHtmlPath, 'utf8')
        : '<!DOCTYPE html><html lang="en-IN"><head><title>Bhumivera | The Transparent Maison — Rooted in Heritage Since 2016</title></head><body><div id="root"></div></body></html>';

      const pageTitle = product ? product.seo_title : DEFAULT_OG_TITLE;
      const pageDesc = product ? product.short_description : DEFAULT_OG_DESCRIPTION;
      const pageKeywords = product
        ? product.search_keywords
        : 'Bhumivera, bhumivera.com, Bhumivera Organics India Private Limited, MPG E-Business Private Limited, Dilip Prasad Nonia, Akash Prasad, Payal Prasad, Asansol West Bengal, The Transparent Maison, cold-pressed botanical skincare';

      const pageImage = product
        ? `${siteOrigin}${product.image_url}`
        : `${siteOrigin}/assets/logo.png`;

      const jsonLd = buildWikipediaLinkedJsonLd(product, canonicalUrl, siteOrigin);

      const ssrSemanticContent = product
        ? `<noscript>
            <article>
              <h1>${escapeXml(product.name)}</h1>
              <p>Formulated under the Bhumivera Transparency Standard (Est. 2016 lineage)</p>
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
        <meta property="og:site_name" content="Bhumivera" />
        <meta property="og:title" content="${escapeXml(DEFAULT_OG_TITLE)}" />
        <meta property="og:description" content="${escapeXml(DEFAULT_OG_DESCRIPTION)}" />
        <meta property="og:url" content="${escapeXml(canonicalUrl)}" />
        <meta property="og:image" content="${escapeXml(pageImage)}" />
        ${product ? `<meta property="product:price:amount" content="${product.price}" /><meta property="product:price:currency" content="INR" />` : ''}
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content="${escapeXml(DEFAULT_OG_TITLE)}" />
        <meta name="twitter:description" content="${escapeXml(DEFAULT_OG_DESCRIPTION)}" />
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
  DEFAULT_OG_TITLE,
  DEFAULT_OG_DESCRIPTION,
  CORPORATE_HERITAGE_FAQS,
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