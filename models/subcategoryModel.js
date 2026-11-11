// backend/models/subcategoryModel.js
const pool = require('../config/db');

const toSlug = str => String(str || '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/(^-|-$)/g, '');

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
      throw err;
    }
  }

  return rows.map(r => ({
    ...r,
    slug: r.slug || toSlug(r.name),
    description: r.description || null,
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
      throw err;
    }
  }

  return rows.map(r => ({
    ...r,
    slug: r.slug || toSlug(r.name),
    description: r.description || null,
  }));
};

// Get single subcategory by id
const getSubcategoryById = async (id) => {
  let rows;
  try {
    [rows] = await pool.query(
      `SELECT sc.id, sc.name, sc.slug, sc.description, sc.category_id,
        c.name AS category_name, sc.created_at
       FROM subcategories sc
       JOIN categories c ON sc.category_id = c.id
       WHERE sc.id = ?`,
      [id]
    );
  } catch (err) {
    if (!err.message?.includes("Unknown column 'sc.slug'")) throw err;
    [rows] = await pool.query(
      `SELECT sc.id, sc.name, sc.description, sc.category_id,
        c.name AS category_name, sc.created_at
       FROM subcategories sc
       JOIN categories c ON sc.category_id = c.id
       WHERE sc.id = ?`,
      [id]
    );
  }
  const row = rows?.[0];
  return row ? {
    ...row,
    slug: row.slug || toSlug(row.name),
    description: row.description || null,
  } : null;
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
};
