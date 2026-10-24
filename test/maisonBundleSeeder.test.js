const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { BHUMIVERA_6_PRODUCTS, MAISON_REGIMEN_BUNDLES } = require('../data/bhumiveraCatalog');
const { seedMaisonRegimenBundles } = require('../scripts/seedLuxuryCatalog');

describe('maison regimen bundle seeder', () => {
  it('creates image-free catalog products with component-based stock', async () => {
    const inserts = [];
    const pool = {
      async query(sql, values = []) {
        if (sql.startsWith('SELECT slug, quantity FROM products')) {
          return [values.map((slug, index) => ({ slug, quantity: 20 - index })), []];
        }
        if (sql.startsWith('INSERT INTO products')) {
          inserts.push({ sql, values });
          return [{ affectedRows: 1 }, []];
        }
        throw new Error(`Unexpected bundle seed query: ${sql}`);
      },
    };

    assert.equal(await seedMaisonRegimenBundles(pool), MAISON_REGIMEN_BUNDLES.length);
    assert.equal(inserts.length, MAISON_REGIMEN_BUNDLES.length);

    for (const [index, insert] of inserts.entries()) {
      const bundle = MAISON_REGIMEN_BUNDLES[index];
      const specifications = JSON.parse(insert.values.at(-1));
      const expectedSlugs = bundle.items.map(item =>
        BHUMIVERA_6_PRODUCTS.find(product => Number(product.id) === Number(item.id)).slug
      );
      assert.equal(insert.values[1], bundle.id);
      assert.equal(insert.values[2], bundle.sku);
      assert.equal(insert.values[6], 20 - (bundle.items.length - 1));
      assert.deepEqual(specifications.components.map(component => component.slug), expectedSlugs);
      assert.doesNotMatch(insert.sql, /image_url|product_images/i);
    }
  });
});
