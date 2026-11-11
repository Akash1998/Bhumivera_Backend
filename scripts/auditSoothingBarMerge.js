require('dotenv').config({
  path: require('path').resolve(__dirname, '../.env'),
  quiet: true,
});

const pool = require('../config/db');
const { BHUMIVERA_6_PRODUCTS } = require('../data/bhumiveraCatalog');

const CANONICAL_SKU = 'BV-LUX-ASOAP-05';
const LEGACY_SKU = 'BV-PROD-22';

const quoteIdentifier = identifier => `\`${String(identifier).replace(/`/g, '``')}\``;

const isProductReferenceColumn = columnName =>
  /product.*ids?$/i.test(String(columnName || ''));

const buildMergePlan = products => {
  const canonical = products.filter(product => product.sku === CANONICAL_SKU);
  const legacy = products.filter(product => product.sku === LEGACY_SKU);

  if (canonical.length > 1 || legacy.length > 1) {
    throw new Error('More than one product row uses a target SKU; stop and resolve duplicate SKUs first.');
  }

  const canonicalProduct = canonical[0] || null;
  const legacyProduct = legacy[0] || null;

  let action = 'no_matching_products';
  if (canonicalProduct && legacyProduct) action = 'merge_legacy_into_canonical';
  else if (canonicalProduct) action = 'canonical_product_only';
  else if (legacyProduct) action = 'rename_legacy_product_to_canonical_sku';

  return {
    canonicalSku: CANONICAL_SKU,
    legacySku: LEGACY_SKU,
    action,
    canonicalProductId: canonicalProduct?.id ?? null,
    legacyProductId: legacyProduct?.id ?? null,
    stockReviewRequired: Boolean(canonicalProduct && legacyProduct),
    products: [...canonical, ...legacy],
  };
};

const getCatalogSnapshot = () => {
  const product = BHUMIVERA_6_PRODUCTS.find(item => item.sku === CANONICAL_SKU);
  if (!product) {
    throw new Error(`The repository catalog has no entry for ${CANONICAL_SKU}.`);
  }

  return {
    sku: product.sku,
    name: product.name,
    slug: product.slug,
    netVolume: product.net_volume,
    category: product.category,
    activeIngredients: product.active_ingredients,
    seoTitle: product.seo_title,
    metaDescription: product.meta_description,
    shortDescription: product.short_description,
    fullDescription: product.full_description,
    searchKeywords: product.search_keywords,
  };
};

const countReferenceValues = async (connection, reference, productIds) => {
  const table = quoteIdentifier(reference.TABLE_NAME);
  const column = quoteIdentifier(reference.COLUMN_NAME);
  const dataType = String(reference.DATA_TYPE).toLowerCase();

  if (dataType === 'json') {
    const [rows] = await connection.query(
      `SELECT
         SUM(JSON_CONTAINS(${column}, CAST(? AS JSON))) AS legacy_count,
         SUM(JSON_CONTAINS(${column}, CAST(? AS JSON))) AS canonical_count
       FROM ${table}`,
      [JSON.stringify(productIds.legacy), JSON.stringify(productIds.canonical)]
    );
    return {
      legacyCount: Number(rows[0]?.legacy_count) || 0,
      canonicalCount: Number(rows[0]?.canonical_count) || 0,
    };
  }

  const [rows] = await connection.query(
    `SELECT
       SUM(${column} = ?) AS legacy_count,
       SUM(${column} = ?) AS canonical_count
     FROM ${table}`,
    [productIds.legacy, productIds.canonical]
  );
  return {
    legacyCount: Number(rows[0]?.legacy_count) || 0,
    canonicalCount: Number(rows[0]?.canonical_count) || 0,
  };
};

const runAudit = async database => {
  const connection = await database.getConnection();
  try {
    const [databaseRows] = await connection.query('SELECT DATABASE() AS database_name');
    const databaseName = databaseRows[0]?.database_name;
    if (!databaseName) throw new Error('No MySQL database is selected in the configured connection.');

    const [products] = await connection.query(
      `SELECT id, name, slug, sku, quantity, price, discount_price, status,
              description, meta_title, meta_description, tags
       FROM products
       WHERE sku IN (?, ?)
       ORDER BY sku, id`,
      [CANONICAL_SKU, LEGACY_SKU]
    );
    const plan = buildMergePlan(products);

    const [columns] = await connection.query(
      `SELECT c.TABLE_NAME, c.COLUMN_NAME, c.DATA_TYPE, t.ENGINE
       FROM INFORMATION_SCHEMA.COLUMNS c
       JOIN INFORMATION_SCHEMA.TABLES t
         ON t.TABLE_SCHEMA = c.TABLE_SCHEMA
        AND t.TABLE_NAME = c.TABLE_NAME
       WHERE c.TABLE_SCHEMA = DATABASE()
       ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`
    );
    const referenceColumns = columns.filter(column =>
      isProductReferenceColumn(column.COLUMN_NAME) &&
      column.TABLE_NAME !== 'products' &&
      ['tinyint', 'smallint', 'mediumint', 'int', 'bigint', 'decimal', 'json'].includes(
        String(column.DATA_TYPE).toLowerCase()
      )
    );

    const productIds = {
      legacy: plan.legacyProductId,
      canonical: plan.canonicalProductId,
    };
    const references = [];
    if (productIds.legacy !== null || productIds.canonical !== null) {
      for (const reference of referenceColumns) {
        const counts = await countReferenceValues(connection, reference, productIds);
        references.push({
          table: reference.TABLE_NAME,
          column: reference.COLUMN_NAME,
          dataType: reference.DATA_TYPE,
          engine: reference.ENGINE,
          ...counts,
        });
      }
    } else {
      for (const reference of referenceColumns) {
        references.push({
          table: reference.TABLE_NAME,
          column: reference.COLUMN_NAME,
          dataType: reference.DATA_TYPE,
          engine: reference.ENGINE,
          legacyCount: null,
          canonicalCount: null,
          note: 'No matching product rows, so reference counts were not queried.',
        });
      }
    }

    const inventoryColumns = new Set(
      columns
        .filter(column => column.TABLE_NAME === 'inventory_product_meta')
        .map(column => column.COLUMN_NAME)
    );
    let inventoryMetadata = [];
    if (inventoryColumns.size) {
      const selectedColumns = [
        'id',
        'product_id',
        'sku',
        'barcode',
        'qr_code_payload',
        'physical_stock',
        'shop_display_stock',
        'warehouse_vault_stock',
        'damaged_quarantine_stock',
      ].filter(column => inventoryColumns.has(column));
      const [rows] = await connection.query(
        `SELECT ${selectedColumns.map(quoteIdentifier).join(', ')}
         FROM inventory_product_meta
         WHERE ${inventoryColumns.has('product_id') ? 'product_id IN (?, ?)' : '1 = 0'}
            ${inventoryColumns.has('sku') ? 'OR sku IN (?, ?)' : ''}
         ORDER BY id`,
        [
          ...(inventoryColumns.has('product_id')
            ? [plan.canonicalProductId || -1, plan.legacyProductId || -1]
            : []),
          ...(inventoryColumns.has('sku') ? [CANONICAL_SKU, LEGACY_SKU] : []),
        ]
      );
      inventoryMetadata = rows;
    }

    return {
      readOnly: true,
      noWritesPerformed: true,
      database: databaseName,
      productMergePlan: plan,
      repositoryCatalogSnapshot: getCatalogSnapshot(),
      productReferences: references,
      inventoryMetadata,
      reviewNotes: [
        'This audit does not change products, stock, inventory metadata, serials, QR payloads, or related records.',
        'If both product rows exist, choose a stock reconciliation policy after reviewing the live quantities.',
        'JSON references are counted when the JSON value contains the exact numeric product ID.',
        'Keep historical order snapshots unchanged when preparing the eventual merge.',
      ],
    };
  } finally {
    connection.release();
  }
};

if (require.main === module) {
  runAudit(pool)
    .then(report => {
      console.log(JSON.stringify(report, null, 2));
    })
    .catch(error => {
      console.error(`Soothing bar merge audit failed: ${error.message}`);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}

module.exports = {
  buildMergePlan,
  getCatalogSnapshot,
  isProductReferenceColumn,
  runAudit,
};
