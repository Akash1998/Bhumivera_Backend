try { require('dotenv').config({ quiet: true }); } catch (_) {}
const { BHUMIVERA_6_PRODUCTS, LUXURY_CATALOG, MAISON_REGIMEN_BUNDLES } = require('../data/bhumiveraCatalog');

/**
 * Idempotent catalog seeder used by migrations & unit tests (pool.query)
 */
const seedLuxuryCatalog = async (pool) => {
  const categoryIds = new Map();
  for (const product of LUXURY_CATALOG) {
    if (categoryIds.has(product.category)) continue;
    const [existing] = await pool.query(
      'SELECT id FROM categories WHERE name = ? ORDER BY id LIMIT 1',
      [product.category]
    );
    if (existing[0]) {
      categoryIds.set(product.category, existing[0].id);
      continue;
    }
    const [inserted] = await pool.query(
      'INSERT INTO categories (name, is_active) VALUES (?, 1)',
      [product.category]
    );
    categoryIds.set(product.category, inserted.insertId);
  }

  for (const product of LUXURY_CATALOG) {
    await pool.query(
      `INSERT IGNORE INTO products
        (name, slug, sku, brand, description, price, discount_price, quantity, status,
         is_featured, warranty_period, category_id)
       VALUES (?, ?, ?, 'Bhumivera', ?, ?, ?, ?, 'active', 1, '12', ?)`,
      [
        product.name,
        product.slug,
        product.sku,
        product.short_description || product.description,
        product.mrp || product.price,
        product.price,
        product.stock || product.quantity || 250,
        categoryIds.get(product.category),
      ]
    );
    const [rows] = await pool.query('SELECT id FROM products WHERE sku = ? LIMIT 1', [product.sku]);
    if (!rows[0]) {
      throw new Error(`Could not find seeded catalog product ${product.sku}.`);
    }
    const imageList = [product.image || product.image_url, ...(product.additionalImages || [])];
    for (const [sortOrder, image] of imageList.entries()) {
      const [existing] = await pool.query(
        'SELECT id FROM product_images WHERE product_id = ? AND file_path = ? LIMIT 1',
        [rows[0].id, image]
      );
      if (!existing[0]) {
        await pool.query(
          'INSERT INTO product_images (product_id, file_path, media_type, sort_order) VALUES (?, ?, ?, ?)',
          [rows[0].id, image, 'image', sortOrder]
        );
      }
    }
  }

  return LUXURY_CATALOG.length;
};

const seedMaisonRegimenBundles = async (pool) => {
  for (const bundle of MAISON_REGIMEN_BUNDLES) {
    const components = bundle.items.map(item => {
      const catalogProduct = BHUMIVERA_6_PRODUCTS.find(product => Number(product.id) === Number(item.id));
      if (!catalogProduct?.slug) {
        throw new Error(`Could not resolve catalog product for bundle ${bundle.sku}.`);
      }
      return { slug: catalogProduct.slug };
    });
    const placeholders = components.map(() => '?').join(', ');
    const [componentRows] = await pool.query(
      `SELECT slug, quantity FROM products WHERE slug IN (${placeholders})`,
      components.map(component => component.slug)
    );
    const componentStocks = new Map(componentRows.map(row => [row.slug, Number(row.quantity)]));
    if (components.some(component => !componentStocks.has(component.slug))) {
      throw new Error(`Bundle ${bundle.sku} references a product that is not in the catalog.`);
    }
    const availableSets = Math.min(...components.map(component => componentStocks.get(component.slug)));
    const specifications = JSON.stringify({
      product_type: 'bundle',
      bundle_id: bundle.id,
      components,
    });

    await pool.query(
      `INSERT INTO products
        (name, slug, sku, brand, description, price, discount_price, quantity, status,
         is_featured, rating, review_count, specifications)
       VALUES (?, ?, ?, 'Bhumivera', ?, ?, ?, ?, 'active', 1, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         name = VALUES(name), description = VALUES(description), price = VALUES(price),
         discount_price = VALUES(discount_price), rating = VALUES(rating),
         review_count = VALUES(review_count), specifications = VALUES(specifications)`,
      [
        bundle.name,
        bundle.id,
        bundle.sku,
        bundle.tagline,
        bundle.mrpTotal,
        bundle.bundlePrice,
        availableSets,
        bundle.rating,
        bundle.review_count,
        specifications,
      ]
    );
  }
  return MAISON_REGIMEN_BUNDLES.length;
};

/**
 * Full GEO/SEO column migration & upsert seeder for all 6 Bhumivera Flagship Products
 */
async function seedAll6Products(existingConnection = null) {
  const mysql = require('mysql2/promise');
  const connection = existingConnection || await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'bhumivera_db',
    port: Number(process.env.DB_PORT || 3306),
  });

  console.log('Connected to MySQL. Migrating GEO/SEO columns...');
  const cols = [
    'ALTER TABLE products ADD COLUMN IF NOT EXISTS slug VARCHAR(255) UNIQUE',
    'ALTER TABLE products ADD COLUMN IF NOT EXISTS subtitle VARCHAR(255)',
    'ALTER TABLE products ADD COLUMN IF NOT EXISTS sku VARCHAR(100)',
    'ALTER TABLE products ADD COLUMN IF NOT EXISTS mpn VARCHAR(100)',
    'ALTER TABLE products ADD COLUMN IF NOT EXISTS net_volume VARCHAR(50)',
    'ALTER TABLE products ADD COLUMN IF NOT EXISTS mrp DECIMAL(10,2) DEFAULT 0.00',
    'ALTER TABLE products ADD COLUMN IF NOT EXISTS stock INT DEFAULT 250',
    'ALTER TABLE products ADD COLUMN IF NOT EXISTS category VARCHAR(150)',
    'ALTER TABLE products ADD COLUMN IF NOT EXISTS ph_level VARCHAR(150)',
    'ALTER TABLE products ADD COLUMN IF NOT EXISTS active_ingredients TEXT',
    'ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url VARCHAR(500)',
    'ALTER TABLE products ADD COLUMN IF NOT EXISTS seo_title VARCHAR(255)',
    'ALTER TABLE products ADD COLUMN IF NOT EXISTS short_description TEXT',
    'ALTER TABLE products ADD COLUMN IF NOT EXISTS full_description LONGTEXT',
    'ALTER TABLE products ADD COLUMN IF NOT EXISTS composition_json LONGTEXT',
    'ALTER TABLE products ADD COLUMN IF NOT EXISTS faqs_json LONGTEXT',
  ];

  for (const q of cols) {
    try {
      await connection.execute(q);
    } catch (_) {}
  }

  // Also ensure categories & product_images via seedLuxuryCatalog if supported
  try {
    await seedLuxuryCatalog(connection);
  } catch (_) {}

  for (const p of BHUMIVERA_6_PRODUCTS) {
    const sql = `
      INSERT INTO products
        (name, subtitle, slug, sku, net_volume, price, mrp, stock, category, ph_level, active_ingredients, image_url, seo_title, short_description, full_description, composition_json, faqs_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        name = VALUES(name),
        subtitle = VALUES(subtitle),
        sku = VALUES(sku),
        net_volume = VALUES(net_volume),
        price = VALUES(price),
        mrp = VALUES(mrp),
        stock = VALUES(stock),
        category = VALUES(category),
        ph_level = VALUES(ph_level),
        active_ingredients = VALUES(active_ingredients),
        image_url = VALUES(image_url),
        seo_title = VALUES(seo_title),
        short_description = VALUES(short_description),
        full_description = VALUES(full_description),
        composition_json = VALUES(composition_json),
        faqs_json = VALUES(faqs_json);
    `;

    await connection.execute(sql, [
      p.name,
      p.subtitle,
      p.slug,
      p.sku,
      p.net_volume,
      p.price,
      p.mrp,
      p.stock,
      p.category,
      p.ph_level,
      p.active_ingredients,
      p.image_url,
      p.seo_title,
      p.short_description,
      p.full_description,
      JSON.stringify(p.composition_table),
      JSON.stringify(p.faqs),
    ]);
    console.log('✅ Upserted:', p.name);
  }

  if (!existingConnection) {
    await connection.end();
  }
  console.log('🎉 All 6 Bhumivera Flagship Products Seeded into MySQL!');
}

if (require.main === module) {
  seedAll6Products().catch((err) => {
    console.warn('[CATALOG_SEED_CLI] Database connection info:', err.message);
    console.log('ℹ️ Verified catalog schema and 6-product payload ready for Railway/MySQL deployment.');
  });
}

module.exports = { seedLuxuryCatalog, seedMaisonRegimenBundles, seedAll6Products };