// backend/models/subcategoryModel.js
const pool = require('../config/db');

const toSlug = str => String(str || '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/(^-|-$)/g, '');

const DEFAULT_SUBCATEGORIES_SEED = [
  { id: 201, category_id: 2, category_name: 'Luxury Facial Cleansers', name: 'Himalayan Sea Buckthorn Radiance Cleansers', slug: 'seabuckthorn-radiance-cleansers', description: 'Botanical Omega-7, Vitamin C and Niacinamide radiance face washes for brightening and cellular renewal.', created_at: '2026-10-23T08:36:55.000Z' },
  { id: 202, category_id: 2, category_name: 'Luxury Facial Cleansers', name: 'Activated Charcoal Deep Pore Purifiers', slug: 'activated-charcoal-purifiers', description: 'Microporous carbon facial cleansers crafted to adsorb PM2.5 pollution and excess sebum without barrier stripping.', created_at: '2026-10-23T08:36:55.000Z' },
  { id: 301, category_id: 3, category_name: 'Luxury Hair Care', name: 'Botanical Saponin Conditioning Shampoos', slug: 'botanical-saponin-shampoos', description: 'Low-pH sulfate-free dual-action 2-in-1 hair cleansers with Reetha, Amla, Shikakai, and pure Rosemary Oil.', created_at: '2026-10-23T08:36:55.000Z' },
  { id: 302, category_id: 3, category_name: 'Luxury Hair Care', name: 'Scalp & Root Revitalizing Rituals', slug: 'scalp-root-revitalizing-rituals', description: 'Ayurvedic multi-herb botanical hair and scalp treatments designed to strengthen hair roots.', created_at: '2026-10-23T08:36:55.000Z' },
  { id: 401, category_id: 4, category_name: 'Artisanal Ayurvedic Cleansing Bars', name: 'Activated Charcoal Detox Bathing Bars', slug: 'charcoal-detox-bathing-bars', description: 'Handcrafted obsidian Ayurvedic cleansing bars infused with Aloe Vera for gentle, non-stripping deep body purification.', created_at: '2026-10-23T08:36:55.000Z' },
  { id: 402, category_id: 4, category_name: 'Artisanal Ayurvedic Cleansing Bars', name: 'Aloe Vera Neem & Tulsi Soothing Bars', slug: 'aloe-neem-tulsi-soothing-bars', description: 'Traditional sacred botanical bathing bars for blemish-prone, sensitive skin delivering a calm, glowing finish.', created_at: '2026-10-23T08:36:55.000Z' },
  { id: 501, category_id: 5, category_name: 'Luxury Ayurvedic Wellness & Immunity Drops', name: 'Seven-Tulsi Liquid Extracts & Adaptogens', slug: 'seven-tulsi-liquid-extracts', description: 'Concentrated 90% liquid distillates of 7 sacred Tulsi varieties for gut-skin axis harmony and daily wellness.', created_at: '2026-10-23T08:36:55.000Z' },
  { id: 502, category_id: 5, category_name: 'Luxury Ayurvedic Wellness & Immunity Drops', name: 'Bio-Active Botanical Wellness Distillates', slug: 'bio-active-botanical-distillates', description: 'Ingestible cellular adaptogens formulated to protect against oxidative stress and environmental wear.', created_at: '2026-10-23T08:36:55.000Z' }
];

// Non-destructive: create table and add slug & description columns if missing
const initSubcategoriesTable = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS subcategories (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      slug VARCHAR(120),
      description TEXT,
      category_id INT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const addColIfMissing = async (col, def) => {
    const [cols] = await pool.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'subcategories'
       AND COLUMN_NAME = ?`,
      [col]
    );
    if (cols.length === 0) {
      await pool.query(`ALTER TABLE subcategories ADD COLUMN ${col} ${def}`);
    }
  };

  await addColIfMissing('slug', 'VARCHAR(120) AFTER name');
  await addColIfMissing('description', 'TEXT AFTER slug');
};

// All subcategories with parent category name
const getAllSubcategories = async () => {
  let rows = [];
  try {
    const [dbRows] = await pool.query(`
      SELECT sc.id, sc.name, sc.slug, sc.description, sc.category_id,
        c.name AS category_name, sc.created_at
      FROM subcategories sc
      JOIN categories c ON sc.category_id = c.id
      ORDER BY c.name, sc.name
    `);
    rows = dbRows;
  } catch (err) {
    if (err.message && err.message.includes("Unknown column 'sc.slug'")) {
      const [legacyRows] = await pool.query(`
        SELECT sc.id, sc.name, sc.description, sc.category_id,
          c.name AS category_name, sc.created_at
        FROM subcategories sc
        JOIN categories c ON sc.category_id = c.id
        ORDER BY c.name, sc.name
      `);
      rows = legacyRows;
    } else {
      console.warn('[Subcategories load fallback]', err.message);
    }
  }

  if (!rows || rows.length === 0) {
    return DEFAULT_SUBCATEGORIES_SEED;
  }

  return rows.map(r => ({
    ...r,
    slug: r.slug || toSlug(r.name),
    description: r.description || `Specialized botanical products in ${r.name} by Bhumivera.`
  }));
};

// Subcategories filtered by category
const getSubcategoriesByCategory = async (categoryId) => {
  let rows = [];
  try {
    const [dbRows] = await pool.query(
      `SELECT sc.id, sc.name, sc.slug, sc.description, sc.category_id,
        c.name AS category_name, sc.created_at
       FROM subcategories sc
       JOIN categories c ON sc.category_id = c.id
       WHERE sc.category_id = ?
       ORDER BY sc.name`,
      [categoryId]
    );
    rows = dbRows;
  } catch (err) {
    if (err.message && err.message.includes("Unknown column 'sc.slug'")) {
      const [legacyRows] = await pool.query(
        `SELECT sc.id, sc.name, sc.description, sc.category_id,
          c.name AS category_name, sc.created_at
         FROM subcategories sc
         JOIN categories c ON sc.category_id = c.id
         WHERE sc.category_id = ?
         ORDER BY sc.name`,
        [categoryId]
      );
      rows = legacyRows;
    } else {
      console.warn('[Subcategories by category fallback]', err.message);
    }
  }

  if (!rows || rows.length === 0) {
    return DEFAULT_SUBCATEGORIES_SEED.filter(s => String(s.category_id) === String(categoryId));
  }

  return rows.map(r => ({
    ...r,
    slug: r.slug || toSlug(r.name),
    description: r.description || `Specialized botanical products in ${r.name} by Bhumivera.`
  }));
};

// Get single subcategory by id
const getSubcategoryById = async (id) => {
  try {
    const [rows] = await pool.query(
      `SELECT sc.id, sc.name, sc.slug, sc.description, sc.category_id,
        c.name AS category_name, sc.created_at
       FROM subcategories sc
       JOIN categories c ON sc.category_id = c.id
       WHERE sc.id = ?`,
      [id]
    );
    if (rows[0]) {
      return {
        ...rows[0],
        slug: rows[0].slug || toSlug(rows[0].name),
        description: rows[0].description || `Specialized botanical products in ${rows[0].name} by Bhumivera.`
      };
    }
  } catch (err) {
    console.warn('[Subcategory by id fallback]', err.message);
  }
  return DEFAULT_SUBCATEGORIES_SEED.find(s => String(s.id) === String(id)) || null;
};

// Create subcategory
const createSubcategory = async ({ name, slug, description, category_id }) => {
  const finalSlug = slug || toSlug(name);
  try {
    const [result] = await pool.query(
      'INSERT INTO subcategories (name, slug, description, category_id) VALUES (?, ?, ?, ?)',
      [name, finalSlug, description || null, category_id]
    );
    return result.insertId;
  } catch (err) {
    if (err.message && err.message.includes("Unknown column 'slug'")) {
      const [result] = await pool.query(
        'INSERT INTO subcategories (name, description, category_id) VALUES (?, ?, ?)',
        [name, description || null, category_id]
      );
      return result.insertId;
    }
    throw err;
  }
};

// Update subcategory
const updateSubcategory = async (id, { name, slug, description, category_id }) => {
  const finalSlug = slug || toSlug(name);
  try {
    await pool.query(
      'UPDATE subcategories SET name = ?, slug = ?, description = ?, category_id = ? WHERE id = ?',
      [name, finalSlug, description || null, category_id, id]
    );
  } catch (err) {
    if (err.message && err.message.includes("Unknown column 'slug'")) {
      await pool.query(
        'UPDATE subcategories SET name = ?, description = ?, category_id = ? WHERE id = ?',
        [name, description || null, category_id, id]
      );
    } else {
      throw err;
    }
  }
};

// Delete subcategory
const deleteSubcategory = async (id) => {
  await pool.query('DELETE FROM subcategories WHERE id = ?', [id]);
};

module.exports = {
  initSubcategoriesTable,
  getAllSubcategories,
  getSubcategoriesByCategory,
  getSubcategoryById,
  createSubcategory,
  updateSubcategory,
  deleteSubcategory,
  DEFAULT_SUBCATEGORIES_SEED,
};
