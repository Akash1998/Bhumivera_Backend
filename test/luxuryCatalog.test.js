const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { BHUMIVERA_6_PRODUCTS, LUXURY_CATALOG } = require('../data/luxuryCatalog');
const {
  buildProductJsonLd,
  buildWikipediaLinkedJsonLd,
  createSeoPrerenderMiddleware,
  sitemapController,
  normalizeSiteUrl,
  findLuxurySkuBySlugOrId,
  generateLlmsFullTxt,
  generateRobotsTxt,
} = require('../middleware/seoPrerender');

describe('luxury catalog GEO/SEO compliance', () => {
  it('provides Wikipedia-linked product schema for every seeded product and guide links', () => {
    assert.equal(BHUMIVERA_6_PRODUCTS.length, 6);
    for (const product of LUXURY_CATALOG) {
      const catalogProduct = findLuxurySkuBySlugOrId(product.slug);
      assert.equal(catalogProduct?.sku, product.sku);
      assert.equal(buildProductJsonLd(catalogProduct)['@type'], 'Product');

      const graphJson = JSON.parse(
        buildWikipediaLinkedJsonLd(product, `https://www.bhumivera.com/products/${product.slug}`)
      );
      assert.ok(Array.isArray(graphJson['@graph']));
      const prodNode = graphJson['@graph'].find((n) => n['@type'] === 'Product');
      assert.ok(prodNode);
      assert.ok(prodNode.about.length >= 3);
      assert.ok(prodNode.about.every((ent) => ent.sameAs.startsWith('https://en.wikipedia.org/wiki/')));
    }
    assert.equal(findLuxurySkuBySlugOrId('8')?.sku, 'BV-SBFW-100ML');
    assert.equal(findLuxurySkuBySlugOrId('106')?.sku, 'BV-TRHM-100ML');
    const robotsTxt = generateRobotsTxt();
    assert.match(robotsTxt, /Sitemap: https:\/\/www\.bhumivera\.com\/sitemap\.xml/);
    assert.equal((robotsTxt.match(/^Sitemap:/gm) || []).length, 1);
    assert.doesNotMatch(robotsTxt, /Sitemap: https:\/\/bhumivera\.com\//);
    assert.equal(normalizeSiteUrl('https://bhumivera.com'), 'https://www.bhumivera.com');
    assert.equal(normalizeSiteUrl('http://www.bhumivera.com/'), 'https://www.bhumivera.com');
    assert.equal(normalizeSiteUrl('https://preview.bhumivera.test'), 'https://preview.bhumivera.test');
    assert.match(generateLlmsFullTxt(), /sulfate-free-luxury-herbal-shampoos/);
  });

  it('enforces 100% regulatory compliance with zero unverified organic or dermatologist certification claims', () => {
    const serialized = JSON.stringify(BHUMIVERA_6_PRODUCTS) + generateLlmsFullTxt();
    assert.doesNotMatch(serialized, /100%\s*certified\s*organic/i);
    assert.doesNotMatch(serialized, /dermatologist\s*certified/i);
    assert.doesNotMatch(serialized, /dermatologically\s*tested/i);
    assert.doesNotMatch(serialized, /india['’]s\s*#1/i);
    assert.doesNotMatch(serialized, /haccp,\s*iso\s*&\s*kosher\s*certified/i);
  });

  it('pre-renders product SEO HTML and serves dynamic XML sitemap', async () => {
    let statusCode = 0;
    let body = '';
    const headers = {};
    const res = {
      setHeader(k, v) { headers[k] = v; },
      status(c) { statusCode = c; return this; },
      send(b) { body = b; return this; },
    };

    sitemapController({ path: '/sitemap.xml', method: 'GET' }, res);
    assert.equal(statusCode, 200);
    assert.match(body, /activated-charcoal-luxury-face-wash/);
    assert.match(body, /himalayan-seabuckthorn-luxury-face-wash/);
    assert.match(body, /kalpvriksh-satva-tulsi-7-tulsi-extract/);
    const sitemapLocs = [...body.matchAll(/<loc>(.*?)<\/loc>/g)].map(([, loc]) => loc);
    assert.ok(sitemapLocs.length > 0);
    assert.ok(sitemapLocs.every(loc => loc.startsWith('https://www.bhumivera.com/')));

    const mw = createSeoPrerenderMiddleware({});
    await mw({ path: '/products/activated-charcoal-luxury-face-wash', method: 'GET' }, res, () => {});
    assert.equal(statusCode, 200);
    assert.match(body, /3% Charcoal, 5% Glycerin/);
    assert.match(body, /https:\/\/en\.wikipedia\.org\/wiki\/Activated_carbon/);
    assert.match(body, /<noscript>/);
  });
});
