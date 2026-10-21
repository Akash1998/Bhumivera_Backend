const { LUXURY_CATALOG } = require('../data/luxuryCatalog');

const seedLuxuryCatalog = async pool => {
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
        product.description,
        product.price,
        product.discountPrice,
        product.quantity,
        categoryIds.get(product.category),
      ]
    );
    const [rows] = await pool.query('SELECT id FROM products WHERE sku = ? LIMIT 1', [product.sku]);
    if (!rows[0]) {
      throw new Error(`Could not find seeded catalog product ${product.sku}.`);
    }
    for (const [sortOrder, image] of [product.image, ...product.additionalImages].entries()) {
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

if (require.main === module) {
  const pool = require('../config/db');
  seedLuxuryCatalog(pool)
    .then(count => console.info(`[CATALOG_SEED] Ensured ${count} default products are available.`))
    .catch(error => {
      console.error('[CATALOG_SEED] Failed to seed catalog.', error);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}

module.exports = { seedLuxuryCatalog };
