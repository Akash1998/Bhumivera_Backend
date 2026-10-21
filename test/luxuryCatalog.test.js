const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { LUXURY_CATALOG } = require('../data/luxuryCatalog');
const { seedLuxuryCatalog } = require('../scripts/seedLuxuryCatalog');
const {
  buildProductJsonLd,
  findLuxurySkuBySlugOrId,
  generateLlmsFullTxt,
  generateRobotsTxt,
} = require('../middleware/seoPrerender');

const createPool = () => {
  const categories = new Map();
  const products = new Map();
  const images = new Set();
  let nextId = 1;

  return {
    categories,
    products,
    images,
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

describe('default luxury catalog seeding', () => {
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

  it('provides product schema for every seeded product and guide links', () => {
    for (const product of LUXURY_CATALOG) {
      const catalogProduct = findLuxurySkuBySlugOrId(product.slug);
      assert.equal(catalogProduct?.sku, product.sku);
      assert.equal(buildProductJsonLd(catalogProduct)['@type'], 'Product');
    }
    assert.equal(findLuxurySkuBySlugOrId('8')?.sku, 'BV-SBFW-100ML');
    assert.equal(findLuxurySkuBySlugOrId('106')?.sku, 'BV-TRHM-100ML');
    assert.match(generateRobotsTxt(), /Sitemap: https:\/\/www\.bhumivera\.com\/sitemap\.xml/);
    assert.match(generateLlmsFullTxt(), /sulfate-free-luxury-herbal-shampoos/);
  });
});
