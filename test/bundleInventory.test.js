const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { getBundleComponents, getBundleAvailableStock } = require('../utils/bundleInventory');

describe('bundle inventory', () => {
  it('recognizes bundle configurations from database JSON and ignores standard products', () => {
    const configuration = {
      product_type: 'bundle',
      components: [{ slug: 'face-wash' }, { slug: 'serum' }],
    };

    assert.deepEqual(getBundleComponents(JSON.stringify(configuration)), configuration.components);
    assert.equal(getBundleComponents({ product_type: 'standard' }), null);
  });

  it('reports the lowest active component stock and queries each unique slug once', async () => {
    let query;
    let values;
    const database = {
      query: async (sql, params) => {
        query = sql;
        values = params;
        return [[
          { slug: 'face-wash', quantity: 5, status: 'active' },
          { slug: 'serum', quantity: 2, status: 'active' },
        ], []];
      },
    };

    const stock = await getBundleAvailableStock(database, {
      product_type: 'bundle',
      components: [{ slug: 'face-wash' }, { slug: 'serum' }, { slug: 'face-wash' }],
    });

    assert.equal(stock, 2);
    assert.deepEqual(values, ['face-wash', 'serum']);
    assert.match(query, /slug IN \(\?, \?\)/);
  });

  it('reports zero availability when a component is inactive', async () => {
    const database = {
      query: async () => [[
        { slug: 'face-wash', quantity: 5, status: 'active' },
        { slug: 'serum', quantity: 12, status: 'inactive' },
      ], []],
    };

    assert.equal(await getBundleAvailableStock(database, {
      product_type: 'bundle',
      components: [{ slug: 'face-wash' }, { slug: 'serum' }],
    }), 0);
  });

  it('fails closed when a component is missing or configuration is invalid', async () => {
    const database = { query: async () => [[{ slug: 'face-wash', quantity: 5 }], []] };
    const configuration = {
      product_type: 'bundle',
      components: [{ slug: 'face-wash' }, { slug: 'missing-product' }],
    };

    await assert.rejects(getBundleAvailableStock(database, configuration), /could not be verified/);
    assert.throws(() => getBundleComponents({
      product_type: 'bundle',
      components: [{ slug: '' }],
    }), /configuration is invalid/);
  });
});
