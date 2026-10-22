const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { BHUMIVERA_6_PRODUCTS, LUXURY_CATALOG } = require('../data/luxuryCatalog');
const { seedLuxuryCatalog, seedAll6Products } = require('../scripts/seedLuxuryCatalog');
const {
  buildProductJsonLd,
  buildWikipediaLinkedJsonLd,
  createSeoPrerenderMiddleware,
  sitemapController,
  findLuxurySkuBySlugOrId,
  generateLlmsFullTxt,
  generateRobotsTxt,
} = require('../middleware/seoPrerender');

const createPool = () => {
  const categories = new Map();
  const products = new Map();
  const images = new Set();
  const upsertedRows = [];
  let nextId = 1;

  return {
    categories,
    products,
    images,
    upsertedRows,
    async execute(sql, params = []) {
      if (sql.includes('INSERT INTO products') && sql.includes('ON DUPLICATE KEY UPDATE')) {
        upsertedRows.push({ sql, params });
      }
      return [{}, []];
    },
    async query(sql, params = []) {
      if (sql.includes('SELECT id FROM categories WHERE name = ?')) {
        const id = categories.get(params[0]);
        return [id ? [{ id }] : [], []];
      }
      if (sql.includes('INSERT INTO categories')) {
        const id = nextId++;
        categories.set(params[0], id);
        return [{ insertId: id }, []];
      }
      if (sql.includes('INSERT IGNORE INTO products')) {
        const sku = params[2];
        if (!products.has(sku)) products.set(sku, { id: nextId++, slug: params[1] });
        return [{}, []];
      }
      if (sql.includes('SELECT id FROM products WHERE sku = ?')) {
        const product = products.get(params[0]);
        return [product ? [{ id: product.id }] : [], []];
      }
      if (sql.includes('SELECT id FROM product_images')) {
        const key = `${params[0]}:${params[1]}`;
        return [images.has(key) ? [{ id: 1 }] : [], []];
      }
      if (sql.includes('INSERT INTO product_images')) {
        images.add(`${params[0]}:${params[1]}`);
        return [{ insertId: 1 }, []];
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
};

describe('default luxury catalog seeding & 6-product GEO/SEO compliance', () => {
  it('creates the default categories, products, and images idempotently', async () => {
    const pool = createPool();
    const productCount = await seedLuxuryCatalog(pool);
    assert.equal(productCount, 6);
    assert.equal(pool.categories.size, 4);
    assert.equal(pool.products.size, 6);
    assert.equal(pool.images.size, 12);

    await seedLuxuryCatalog(pool);
    assert.equal(pool.categories.size, 4);
    assert.equal(pool.products.size, 6);
    assert.equal(pool.images.size, 12);
  });

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
    assert.match(generateRobotsTxt(), /Sitemap: https:\/\/www\.bhumivera\.com\/sitemap\.xml/);
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

    const mw = createSeoPrerenderMiddleware({});
    await mw({ path: '/products/activated-charcoal-luxury-face-wash', method: 'GET' }, res, () => {});
    assert.equal(statusCode, 200);
    assert.match(body, /3% Charcoal, 5% Glycerin/);
    assert.match(body, /https:\/\/en\.wikipedia\.org\/wiki\/Activated_carbon/);
    assert.match(body, /<noscript>/);
  });
});
