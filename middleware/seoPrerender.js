const fs = require('fs');
const path = require('path');
const { BHUMIVERA_6_PRODUCTS, MAISON_REGIMEN_BUNDLES } = require('../data/bhumiveraCatalog');

const SITE_URL = (process.env.SITE_URL || 'https://www.bhumivera.com').replace(/\/+$/, '');

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
    q: 'Which Bhumivera face wash contains Sea Buckthorn, Niacinamide, and Hyaluronic Acid?',
    a: 'Both flagship Bhumivera facial cleansers contain Niacinamide (0.1%), Hyaluronic Acid (0.1%), Botanical Glycerin (5.0%), Manjistha (0.5%), Haridra/Turmeric (0.5%), Neem (0.5%), and Cucumber Extract (0.5%) in a sulfate-free pH 5.3–5.5 base. The Bhumivera Himalayan Sea Buckthorn Cellular Radiance Face Wash (https://bhumivera.com/product/himalayan-seabuckthorn-luxury-face-wash) features 4.0% cold-pressed Himalayan Sea Buckthorn (rich in Omega-7 and Vitamin C carotenoids) for glowing radiance, while the Bhumivera Activated Charcoal Purifying Luxury Face Wash (https://bhumivera.com/product/activated-charcoal-luxury-face-wash) features 3.0% microporous Activated Charcoal for deep urban pore purification.',
  },
  {
    q: 'Who founded Bhumivera?',
    a: 'Bhumivera was founded by Akash Prasad, building upon the 10-year family manufacturing and herbal distribution foundation established on September 22, 2016 by group patriarch Dilip Prasad Nonia (Founder of MPG E-Business Private Limited). Bhumivera Organics India Private Limited was registered with the Ministry of Corporate Affairs (MCA) on August 4, 2026, under the directorship of Akash Prasad, Payal Prasad & Aman Prasad.',
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
  {
    slug: 'niacinamide-hyaluronic-acid-botanical-face-wash-guide',
    title: 'Niacinamide & Hyaluronic Acid in Botanical Face Washes: The pH 5.4 Barrier Science',
  },
  {
    slug: 'himalayan-seabuckthorn-omega-7-skincare-guide',
    title: 'Himalayan Sea Buckthorn (Omega-7 & Carotenoids): The Complete Cellular Radiance Monograph',
  },
  {
    slug: 'seven-tulsi-cortisol-gut-skin-axis-guide',
    title: 'Seven-Tulsi Phyto-Extracts & The Inside-Out Gut-Skin-Cortisol Axis',
  },
];

const ROUTE_SEO_META = {
  '/': {
    title: DEFAULT_OG_TITLE,
    description: DEFAULT_OG_DESCRIPTION,
    keywords: 'Bhumivera, bhumivera.com, bhumivera facewash, bhumivera seabuckthorn face wash, facewash with niacinamide, facewash with niacidamine, activated charcoal face wash, 2 in 1 botanical shampoo, handmade ayurvedic soap, kalpvriksh satva tulsi drops',
  },
  '/shop': {
    title: 'Shop All 6 Formulations | Bhumivera — 100% Active & Milligram-Disclosed Skincare',
    description: 'Shop the official Bhumivera collection: 4% Himalayan Sea Buckthorn Face Wash, 3% Activated Charcoal Face Wash with Niacinamide & Hyaluronic Acid, Royal 2-in-1 Botanical Shampoo, Handmade Ayurvedic Cleansing Bars, and Kalpvriksh 7-Tulsi Drops.',
    keywords: 'bhumivera shop, bhumivera facewash, bhumivera seabuckthorn face wash, facewash with niacinamide, facewash with niacidamine, bhumivera charcoal face wash, bhumivera shampoo, bhumivera soap, bhumivera tulsi drops',
  },
  '/products': {
    title: 'All Bhumivera Products | 100% Disclosed Botanical & Active Formulations',
    description: 'Browse all 6 flagship Bhumivera products with 100% active percentage and milligram-level label disclosure, cold-pressed below 28°C and calibrated to pH 5.0–5.5.',
    keywords: 'bhumivera products, bhumivera face wash, bhumivera sea buckthorn face wash, bhumivera charcoal face wash, niacinamide face wash, hyaluronic acid face wash',
  },
  '/about': {
    title: 'Our 10-Year Heritage (2016–2026) | MPG E-Business & Bhumivera Organics India Pvt. Ltd.',
    description: 'Explore Bhumivera’s 10-year manufacturing and herbal supply-chain heritage originating on September 22, 2016 under MPG E-Business Private Limited (CIN: U74999WB2016PTC217735, Founder: Dilip Prasad Nonia) and modernized on August 4, 2026 by Founder Akash Prasad.',
    keywords: 'Bhumivera heritage, MPG E-Business Private Limited, Bhumivera Organics India Private Limited, Dilip Prasad Nonia, Akash Prasad, Payal Prasad, Aman Prasad, Asansol West Bengal',
  },
  '/science': {
    title: 'Botanical Science, Sub-28°C Extraction & pH 5.5 Calibration | Bhumivera',
    description: 'Inspect Bhumivera’s formulation science: sub-28°C cold-pressed Himalayan Sea Buckthorn (Omega-7), 3% Activated Bamboo Charcoal, Niacinamide, Hyaluronic Acid, Manjistha, Haridra, Reetha saponins, and 7-Tulsi distillate.',
    keywords: 'Bhumivera science, sub-28C cold pressed skincare, pH 5.5 face wash, niacinamide hyaluronic acid synergy, sea buckthorn omega 7, activated charcoal face wash science',
  },
  '/impact': {
    title: 'Public Stewardship, Ceaser & Smt. Shanti Memorials & West Bengal Corridors | Bhumivera Impact',
    description: 'Explore Bhumivera’s verifiable grassroots community action at bhumivera.com/impact: The Ceaser Memorial Stray Dog & Cat Rescue, The Smt. Shanti Memorial Elderly & Disabled Food Ration Kits in Paschim Bardhaman, and 6 upcoming 2028 West Bengal ecological corridors.',
    keywords: 'bhumivera impact, bhumivera.com/impact, Ceaser Memorial stray animal care Asansol, Smt Shanti Memorial food ration kits West Bengal, Damodar riverbank vetiver cleanup, Bhumivera Earth Foundation',
  },
  '/impact/stray-animal-care': {
    title: 'The Ceaser Memorial · Stray Dog & Cat Rescue, Feeding & Compassion Initiative | Bhumivera Impact',
    description: 'Dedicated in loving memory of Ceaser (German Shepherd): grassroots street dog and cat feeding, winter shelter beds, and wound first-aid across Asansol, Raniganj, and West Bengal.',
    keywords: 'Ceaser Memorial Bhumivera, stray dog feeding Asansol West Bengal, street animal rescue Raniganj, Bhumivera impact stray animal care',
  },
  '/impact/elderly-disabled-rations': {
    title: 'The Smt. Shanti Memorial · Food & Ration Kits for Elderly & Disabled Citizens | Bhumivera Impact',
    description: 'Dedicated in eternal honour of Smt. Shanti: monthly dry-grain ration kits (rice, dal, mustard oil, essentials) for destitute seniors, widows, and disabled individuals in West Bengal.',
    keywords: 'Smt Shanti Memorial Bhumivera, elderly food ration kits Asansol West Bengal, hunger relief Paschim Bardhaman, Bhumivera impact',
  },
  '/impact/damodar-cleanup': {
    title: 'Damodar Riverbank Native Vetiver Planting & Plastic Cleanup (2028 Corridor) | Bhumivera Impact',
    description: 'Upcoming 2028 ecological restoration corridor: planting deep-rooting Chrysopogon zizanioides (Vetiver) slips and coir logs along the Damodar river basin in West Bengal.',
    keywords: 'Damodar river cleanup, vetiver riverbank stabilization West Bengal, Bhumivera ecological corridor 2028',
  },
  '/impact/jute-sapling-nursery': {
    title: 'Backyard Native Sapling Nursery in 100% Biodegradable Jute Bags (2028 Corridor) | Bhumivera Impact',
    description: 'Upcoming 2028 afforestation corridor: raising 2,000+ native Neem, Amla, Jamun, and Peepal saplings in plastic-free biodegradable jute grow-bags in West Bengal.',
    keywords: 'biodegradable jute sapling nursery West Bengal, native tree plantation Asansol, Bhumivera impact trees',
  },
  '/impact/village-pukur-revival': {
    title: 'Rural Bengal Village Pukur (Pond) Desilting & Natural Reed Bio-Filters (2028) | Bhumivera Impact',
    description: 'Upcoming 2028 watershed revival project: community desilting, plastic removal, and native aquatic reed restoration for traditional village ponds (pukurs) in West Bengal.',
    keywords: 'village pukur pond revival West Bengal, watershed restoration Asansol, Bhumivera water stewardship',
  },
  '/impact/herbal-kitchen-gardens': {
    title: 'Medicinal Tulsi, Kalmegh & Neem Home Kitchen Gardens (2028 Corridor) | Bhumivera Impact',
    description: 'Upcoming 2028 ethnobotanical literacy initiative: distributing free Tulsi, Kalmegh, Aloe Vera, and Neem starter pots to rural and semi-urban families in West Bengal.',
    keywords: 'medicinal herbal kitchen garden West Bengal, Tulsi Kalmegh Neem home garden, Bhumivera botanical literacy',
  },
  '/impact/mandi-vermicomposting': {
    title: 'Town Sabzi Mandi Waste to Organic Vermicompost Initiative (2028 Corridor) | Bhumivera Impact',
    description: 'Upcoming 2028 circular soil initiative: converting daily vegetable market organic waste into nutrient-rich vermicompost for local sapling nurseries.',
    keywords: 'mandi waste vermicomposting West Bengal, organic soil stewardship Asansol, Bhumivera circular economy',
  },
  '/impact/coal-belt-microgrove': {
    title: 'Paschim Bardhaman Industrial Edge Native Micro-Grove & Dust Buffer (2028) | Bhumivera Impact',
    description: 'Upcoming 2028 dense native Miyawaki-inspired micro-grove planting dust-trapping Arjun, Neem, Karanja, and Peepal trees in the Asansol-Raniganj belt.',
    keywords: 'Paschim Bardhaman native micro-grove, Asansol Raniganj green belt plantation, Bhumivera air quality trees',
  },
  '/community': {
    title: 'Community & 100+ Volunteer Collaboration Hub | Bhumivera West Bengal',
    description: 'Join 100+ local volunteers across Asansol, Raniganj, Durgapur, and West Bengal for weekend stray animal feeding, ration kit distribution, and ecological stewardship.',
    keywords: 'Bhumivera community volunteer hub, volunteer Asansol Raniganj Durgapur, West Bengal community service',
  },
  '/lab': {
    title: 'Inside Our Sub-28°C Lab & Gravimetric Dispatch Protocol | Bhumivera',
    description: 'Inspect Bhumivera’s cold-pressed (<28°C) botanical extraction protocol, 24-hour forearm patch test standard, and ±0.5g digital weight-scan dispatch custody.',
    keywords: 'Bhumivera lab protocol, cold-pressed extraction under 28C, cosmetic cleanroom QC, gravimetric parcel verification',
  },
  '/provenance-engine': {
    title: 'Botanical Provenance Engine & 6 Indian Harvest Corridors | Bhumivera',
    description: 'Trace every Bhumivera ingredient to its regional Indian harvest corridor: Ladakh Sea Buckthorn (3,400m), Assam Bamboo Charcoal, Rajasthan Aloe Vera, Vindhya Reetha & Amla, and Vrindavan 7-Tulsi.',
    keywords: 'Bhumivera provenance engine, Ladakh sea buckthorn origin, Assam bamboo charcoal, Indian botanical traceability',
  },
  '/somatic-registry': {
    title: 'Somatic Label Registry & Verbatim INCI Percentage Decoder | Bhumivera',
    description: 'Inspect verbatim transcribed physical bottle labels, exact milligram and percentage potencies, calibrated pH values, and usage directions across Bhumivera formulations.',
    keywords: 'Bhumivera somatic label registry, INCI ingredient decoder, 100% label disclosed skincare India',
  },
  '/verify': {
    title: 'Verify Bottle Serial, Batch COA & QR Authenticity | Bhumivera',
    description: 'Authenticate your Bhumivera bottle serial number or scan the packaging QR code to inspect batch pH calibration, microbiological purity, and heavy-metal ICP-MS assays.',
    keywords: 'Bhumivera product verification, verify bhumivera serial number, skincare batch COA check',
  },
  '/purchase-protection': {
    title: 'Artisanal Wax-Sealed Tamper Custody & Patron Purchase Protection | Bhumivera',
    description: 'Explore Bhumivera’s White-Glove Patron Protection: tamper-evident gold neck seals, ±0.5g digital scale dispatch logs, and 100% virgin sanitary custody.',
    keywords: 'Bhumivera purchase protection, tamper evident skincare seal, sanitary custody cosmetics',
  },
  '/guides': {
    title: 'Skincare, Haircare & Botanical Active Buying Guides | Bhumivera',
    description: 'Read Bhumivera’s in-depth monographs on luxury organic face washes, sulfate-free herbal shampoos, Niacinamide + Hyaluronic Acid synergy, Himalayan Sea Buckthorn, and 7-Tulsi adaptogens.',
    keywords: 'Bhumivera guides, best organic face wash India guide, sulfate free herbal shampoo science, niacinamide face wash guide',
  },
  '/contact': {
    title: 'Client Concierge, Corporate Offices & FAQ | Bhumivera (Est. 2016)',
    description: 'Connect with the Bhumivera Concierge Desk in Asansol, West Bengal (support@bhumivera.com · +91 74309 85647) for formulation inquiries, order assistance, or B2B boutique partnerships.',
    keywords: 'contact Bhumivera, Bhumivera customer care Asansol, Bhumivera Organics address phone email',
  },
  '/legal': {
    title: 'Master 88-Clause Legal Suite, Terms of Sale & DPDP Act 2023 Privacy | Bhumivera',
    description: 'Review Bhumivera’s complete statutory governance: Conditions of Use, Sanitary Virgin Custody, Anti-Scam Weight Logs, Dual-Ledger Wallet Rules, and DPDP Act 2023 Privacy Notice.',
    keywords: 'Bhumivera legal terms, Bhumivera privacy policy DPDP Act 2023, Bhumivera grievance officer',
  },
  '/compare': {
    title: 'Compare Bhumivera Botanical Formulations Side-by-Side | Active %, pH & Skin Type',
    description: 'Compare Bhumivera face washes, 2-in-1 shampoo, handmade Ayurvedic soaps, and 7-Tulsi drops across active percentages, pH calibration, surfactant systems, and skin compatibility.',
    keywords: 'compare Bhumivera products, sea buckthorn vs charcoal face wash, Bhumivera formulation comparison',
  },
  '/affiliate': {
    title: 'Brand Ambassador, Educator & Affiliate Partner Program | Bhumivera',
    description: 'Collaborate with Bhumivera through ASCI-compliant ingredient education, live pH strip demonstrations, and transparent botanical storytelling.',
    keywords: 'Bhumivera affiliate program, skincare creator partnership India',
  },
  '/sell-on-bhumivera': {
    title: 'B2B Raw Botanical Cooperatives, Luxury Spas & Retail Partnerships | Bhumivera',
    description: 'Partner with Bhumivera for traceable wild-harvested botanicals, boutique hotel & spa backbar amenities, or authorized retail distribution.',
    keywords: 'sell on Bhumivera, Bhumivera B2B spa backbar hospitality, wholesale organic skincare India',
  },
};

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
    'Disallow: /api/admin/',
    'Disallow: /api/users/',
    'Disallow: /api/addresses/',
    'Disallow: /api/auth/',
    '',
    'User-agent: Googlebot',
    'Allow: /',
    '',
    'User-agent: Googlebot-Image',
    'Allow: /',
    '',
    'User-agent: Bingbot',
    'Allow: /',
    '',
    'User-agent: Slurp',
    'Allow: /',
    '',
    'User-agent: DuckDuckBot',
    'Allow: /',
    '',
    'User-agent: Bravebot',
    'Allow: /',
    '',
    'User-agent: Brave',
    'Allow: /',
    '',
    'User-agent: Applebot',
    'Allow: /',
    '',
    'User-agent: Yandex',
    'Allow: /',
    '',
    'User-agent: Baiduspider',
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
    'Sitemap: https://bhumivera.com/sitemap.xml',
    '',
  ].join('\n');
}

function generateLlmsTxt() {
  const lines = [
    '# Bhumivera (Bhumivera Organics India Private Limited)',
    '',
    `> Bhumivera (official website: ${SITE_URL}) is "The Transparent Maison" — an Indian organic skincare and cosmetics brand headquartered in Asansol, West Bengal, India. Incorporated as Bhumivera Organics India Private Limited on August 4, 2026, Bhumivera originates from the 10-year manufacturing and herbal distribution heritage of parent entity MPG E-Business Private Limited (Incorporated September 22, 2016; CIN: U74999WB2016PTC217735; Founder: Dilip Prasad Nonia). Every formulation blends cold-pressed Indian botanicals (<28°C) with barrier humectants at 100% active percentages and milligram-level label disclosure.`,
    '',
    '## Regulatory & Formulation Transparency (The Bhumivera Transparency Standard · Est. 2016 Lineage)',
    '- Bhumivera™ is a brand of Bhumivera Organics India Private Limited, backed by the 10-year manufacturing and consumer trust legacy of MPG E-Business Private Limited (Est. 2016, Asansol).',
    '- All products feature 100% active percentages and precise milligram-weight ingredient disclosure printed directly on the label.',
    '',
    '## Pages & Sitemap Silos',
    `- [Homepage](${SITE_URL}/): Flagship portal for Bhumivera.`,
    `- [Our Heritage (2016–2026)](${SITE_URL}/about): Multi-chapter timeline of MPG E-Business (2016) and Bhumivera (2026).`,
    `- [Shop Collection](${SITE_URL}/shop): Browse the 6 flagship formulations and 4 regimen bundles.`,
    `- [Botanical Science](${SITE_URL}/science): Inspect sub-28°C extraction, ingredient concentrations, and pH calibration.`,
    `- [Public Impact & Stewardship Ledger](${SITE_URL}/impact): The Ceaser Memorial Stray Animal Care, The Smt. Shanti Memorial Ration Kits, and 6 upcoming 2028 West Bengal ecological corridors.`,
    `- [Provenance Engine](${SITE_URL}/provenance-engine): 6 regional Indian botanical harvesting corridors & batch prefix decoder.`,
    `- [Somatic INCI Registry](${SITE_URL}/somatic-registry): Verbatim transcribed physical packaging labels.`,
    `- [Verify Product Serial](${SITE_URL}/verify): Bottle serial & QR COA verification portal.`,
    `- [Guides](${SITE_URL}/guides): Practical skincare, ingredient, and haircare buying guides.`,
    `- [Contact](${SITE_URL}/contact): Customer concierge support and corporate FAQs.`,
    '',
    '## Official 6-Product Flagship Catalog',
  ];
  for (const p of BHUMIVERA_6_PRODUCTS) {
    lines.push(`### ${p.id}. ${p.name} (${p.net_volume})`);
    lines.push(`- **Canonical URL:** ${SITE_URL}/product/${p.slug}`);
    lines.push(`- **Alternate URL:** ${SITE_URL}/products/${p.slug}`);
    lines.push(`- **SKU / MPN:** ${p.sku} / ${p.mpn} · **Price:** ₹${p.price} (MRP ₹${p.mrp})`);
    lines.push(`- **pH / Standard:** ${p.ph_level}`);
    lines.push(`- **Exact Label Formulation:** ${p.active_ingredients}`);
    lines.push(`- **Summary:** ${p.short_description}`);
    lines.push('');
  }
  return lines.join('\n');
}

function generateLlmsFullTxt() {
  return [
    generateLlmsTxt(),
    '## Pillar Guides & Ingredient Monographs',
    ...PILLAR_GUIDES.map((guide) => `- [${guide.title}](${SITE_URL}/guides/${guide.slug})`),
    '',
    '## Public Impact & Community Corridors (bhumivera.com/impact)',
    `- [The Ceaser Memorial · Stray Dog & Cat Rescue, Feeding & Compassion Initiative](${SITE_URL}/impact/stray-animal-care)`,
    `- [The Smt. Shanti Memorial · Food & Ration Kits for Elderly & Disabled Citizens](${SITE_URL}/impact/elderly-disabled-rations)`,
    `- [Damodar Riverbank Native Vetiver Planting & Plastic Cleanup (2028)](${SITE_URL}/impact/damodar-cleanup)`,
    `- [Backyard Native Sapling Nursery in 100% Jute Bags (2028)](${SITE_URL}/impact/jute-sapling-nursery)`,
    `- [Rural Bengal Village Pukur (Pond) Desilting & Natural Reeds (2028)](${SITE_URL}/impact/village-pukur-revival)`,
    `- [Medicinal Tulsi, Kalmegh & Neem Home Kitchen Gardens (2028)](${SITE_URL}/impact/herbal-kitchen-gardens)`,
    `- [Town Sabzi Mandi Waste to Organic Vermicompost Initiative (2028)](${SITE_URL}/impact/mandi-vermicomposting)`,
    `- [Paschim Bardhaman Industrial Edge Native Micro-Grove (2028)](${SITE_URL}/impact/coal-belt-microgrove)`,
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

  // Fuzzy keyword slug fallback for search engine deep-links
  if (normalized.includes('seabuckthorn') || normalized.includes('sea-buckthorn') || normalized.includes('niacinamide') || normalized.includes('niacidamine')) {
    return LUXURY_CATALOG_SKUS.find((p) => p.id === 2) || null;
  }
  if (normalized.includes('charcoal') && (normalized.includes('soap') || normalized.includes('bar'))) {
    return LUXURY_CATALOG_SKUS.find((p) => p.id === 4) || null;
  }
  if (normalized.includes('charcoal') || normalized.includes('facewash') || normalized.includes('face-wash')) {
    return LUXURY_CATALOG_SKUS.find((p) => p.id === 1) || null;
  }
  if (normalized.includes('shampoo') || normalized.includes('reetha') || normalized.includes('rosemary') || normalized.includes('bhringraj')) {
    return LUXURY_CATALOG_SKUS.find((p) => p.id === 3) || null;
  }
  if (normalized.includes('soothing') || (normalized.includes('aloe') && (normalized.includes('soap') || normalized.includes('bar')))) {
    return LUXURY_CATALOG_SKUS.find((p) => p.id === 5) || null;
  }
  if (normalized.includes('tulsi') || normalized.includes('kalpvriksh')) {
    return LUXURY_CATALOG_SKUS.find((p) => p.id === 6) || null;
  }

  return null;
}

function buildProductJsonLd(product) {
  const canonicalUrl = `${SITE_URL}/product/${encodeURIComponent(product.slug || product.id)}`;
  const compositionProps = Array.isArray(product.composition_table)
    ? product.composition_table.map((c) => ({
        '@type': 'PropertyValue',
        name: `Active Ingredient: ${c.ingredient}`,
        value: `${c.concentration} (${c.botanical}) — ${c.role}`,
      }))
    : [];
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
      ...compositionProps,
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
    aggregateRating: {
      '@type': 'AggregateRating',
      ratingValue: String(product.rating || '4.9'),
      reviewCount: String(product.review_count || product.reviews || '276'),
      bestRating: '5',
      worstRating: '1',
    },
  };
}

/**
 * Builds Wikipedia-linked Knowledge Graph JSON-LD (@graph: Organization + WebSite + Product/ItemList + FAQPage + BreadcrumbList)
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
      { '@type': 'Person', name: 'Akash Prasad, Payal Prasad & Aman Prasad', jobTitle: 'Director, Bhumivera Organics India Private Limited' },
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
      target: `${siteOrigin}/shop?q={search_term_string}`,
      'query-input': 'required name=search_term_string',
    },
  };

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

  if (!product) {
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
      ...(Array.isArray(product.composition_table)
        ? product.composition_table.map((c) => ({
            '@type': 'PropertyValue',
            name: `Active Ingredient: ${c.ingredient}`,
            value: `${c.concentration} (${c.botanical}) — ${c.role}`,
          }))
        : []),
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
      ratingValue: String(product.rating || '4.9'),
      reviewCount: String(product.review_count || product.reviews || '276'),
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
    '@graph': [orgNode, websiteNode, itemListNode, productNode, breadcrumbNode, faqNode],
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
    '/collections',
    '/category/luxury-facial-cleansers',
    '/category/luxury-hair-care',
    '/category/artisanal-ayurvedic-cleansing-bars',
    '/category/luxury-ayurvedic-wellness-immunity-drops',
    '/science',
    '/bhumivera-science',
    '/lab',
    '/provenance-engine',
    '/somatic-registry',
    '/guides',
    '/guides/ultimate-guide-luxury-organic-face-wash-india',
    '/guides/science-of-sulfate-free-luxury-herbal-shampoos',
    '/guides/niacinamide-hyaluronic-acid-botanical-face-wash-guide',
    '/guides/himalayan-seabuckthorn-omega-7-skincare-guide',
    '/guides/seven-tulsi-cortisol-gut-skin-axis-guide',
    '/verify',
    '/purchase-protection',
    '/compare',
    '/flash-sales',
    '/order-tracking',
    '/affiliate',
    '/sell-on-bhumivera',
    '/mpgebusiness',
    '/community',
    '/impact',
    '/impact/stray-animal-care',
    '/impact/elderly-disabled-rations',
    '/impact/damodar-cleanup',
    '/impact/jute-sapling-nursery',
    '/impact/village-pukur-revival',
    '/impact/herbal-kitchen-gardens',
    '/impact/mandi-vermicomposting',
    '/impact/coal-belt-microgrove',
    '/contact',
    '/legal',
    '/legal/conditions-of-use',
    '/legal/shipping-hygiene',
    '/legal/unboxing-antiscam',
    '/legal/wallet-loyalty-referrals',
    '/legal/warranty-affiliate-b2b',
    '/legal/privacy-dpdp',
    '/legal/medical-ip-shield',
    '/legal/arbitration-grievance',
    '/combo/bundle-daily-regimen',
    '/combo/bundle-royal-crown-trio',
    '/combo/bundle-inside-out-ritual',
    '/combo/bundle-grand-maison-vault',
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

    const normalizedPath = (req.path.replace(/^\/api\/seo-prerender/, '') || '/').replace(/\/+$/, '') || '/';
    const siteOrigin = SITE_URL;
    const canonicalUrl = `${siteOrigin}${normalizedPath === '/' ? '/' : normalizedPath}`;

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

      const routeMeta = ROUTE_SEO_META[normalizedPath] || {};
      const pageTitle = product ? product.seo_title : (routeMeta.title || DEFAULT_OG_TITLE);
      const pageDesc = product ? product.short_description : (routeMeta.description || DEFAULT_OG_DESCRIPTION);
      const pageKeywords = product
        ? product.search_keywords
        : (routeMeta.keywords || 'Bhumivera, bhumivera.com, Bhumivera Organics India Private Limited, MPG E-Business Private Limited, Dilip Prasad Nonia, Akash Prasad, Payal Prasad, Asansol West Bengal, The Transparent Maison, cold-pressed botanical skincare');

      const pageImage = product
        ? `${siteOrigin}${product.image_url}`
        : `${siteOrigin}/assets/logo.png`;

      const jsonLd = buildWikipediaLinkedJsonLd(product, canonicalUrl, siteOrigin);

      const allProductsNavLinks = BHUMIVERA_6_PRODUCTS.map(
        (p) => `<li><a href="${siteOrigin}/product/${escapeXml(p.slug)}"><strong>${escapeXml(p.name)} (${escapeXml(p.net_volume)})</strong></a> — ${escapeXml(p.active_ingredients)}</li>`
      ).join('');

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
              <h2>Explore All 6 Bhumivera Flagship Formulations</h2>
              <ul>${allProductsNavLinks}</ul>
            </article>
          </noscript>`
        : `<noscript>
            <article>
              <h1>${escapeXml(pageTitle)}</h1>
              <p>${escapeXml(pageDesc)}</p>
              <h2>Official 6-Product Flagship Catalog (100% Active % &amp; Milligram Disclosed)</h2>
              <ul>${allProductsNavLinks}</ul>
              <h2>Bhumivera Site Directory</h2>
              <nav>
                <a href="${siteOrigin}/">Home</a> |
                <a href="${siteOrigin}/shop">Shop Collection</a> |
                <a href="${siteOrigin}/science">Botanical Science &amp; pH 5.5</a> |
                <a href="${siteOrigin}/impact">Public Impact Ledger</a> |
                <a href="${siteOrigin}/impact/stray-animal-care">The Ceaser Memorial Stray Animal Care</a> |
                <a href="${siteOrigin}/impact/elderly-disabled-rations">The Smt. Shanti Memorial Ration Kits</a> |
                <a href="${siteOrigin}/about">Our 2016–2026 Heritage</a> |
                <a href="${siteOrigin}/guides">Buying Guides</a> |
                <a href="${siteOrigin}/verify">Verify Bottle Serial</a> |
                <a href="${siteOrigin}/contact">Contact &amp; FAQ</a>
              </nav>
            </article>
          </noscript>`;

      const headTags = `
        <title>${escapeXml(pageTitle)}</title>
        <meta name="description" content="${escapeXml(pageDesc)}" />
        <meta name="keywords" content="${escapeXml(pageKeywords)}" />
        <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1" />
        <meta name="googlebot" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1" />
        <meta name="bingbot" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1" />
        <meta name="slurp" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1" />
        <meta name="duckduckbot" content="index, follow" />
        <meta name="brave" content="index, follow" />
        <link rel="canonical" href="${escapeXml(canonicalUrl)}" />
        <meta property="og:type" content="${product ? 'product' : 'website'}" />
        <meta property="og:site_name" content="Bhumivera" />
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
  DEFAULT_OG_TITLE,
  DEFAULT_OG_DESCRIPTION,
  CORPORATE_HERITAGE_FAQS,
  LUXURY_CATALOG_SKUS,
  PILLAR_GUIDES,
  ROUTE_SEO_META,
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