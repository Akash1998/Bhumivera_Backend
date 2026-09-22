// backend/models/subcategoryModel.js
const pool = require('../config/db');

// Non-destructive: create table and add description column if missing (MySQL 5.7 compatible)
const initSubcategoriesTable = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS subcategories (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      description TEXT,
      category_id INT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // MySQL 5.7 compatible: check information_schema before ALTER
  const [cols] = await pool.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'subcategories'
     AND COLUMN_NAME = 'description'`
  );
  if (cols.length === 0) {
    await pool.query(
      'ALTER TABLE subcategories ADD COLUMN description TEXT AFTER name'
    );
  }
};
initSubcategoriesTable().catch(console.error);

// All subcategories with parent category name
const getAllSubcategories = async () => {
  const [rows] = await pool.query(`
    SELECT sc.id, sc.name, sc.description, sc.category_id,
      c.name AS category_name, sc.created_at
    FROM subcategories sc
    JOIN categories c ON sc.category_id = c.id
    ORDER BY c.name, sc.name
  `);
  return rows;
};

// Subcategories filtered by category
const getSubcategoriesByCategory = async (categoryId) => {
  const [rows] = await pool.query(
    `SELECT sc.id, sc.name, sc.description, sc.category_id,
      c.name AS category_name, sc.created_at
     FROM subcategories sc
     JOIN categories c ON sc.category_id = c.id
     WHERE sc.category_id = ?
     ORDER BY sc.name`,
    [categoryId]
  );
  return rows;
};

// Get single subcategory by id
const getSubcategoryById = async (id) => {
  const [rows] = await pool.query(
    `SELECT sc.id, sc.name, sc.description, sc.category_id,
      c.name AS category_name, sc.created_at
     FROM subcategories sc
     JOIN categories c ON sc.category_id = c.id
     WHERE sc.id = ?`,
    [id]
  );
  return rows[0];
};

// Create subcategory
const createSubcategory = async ({ name, description, category_id }) => {
  const [result] = await pool.query(
    'INSERT INTO subcategories (name, description, category_id) VALUES (?, ?, ?)',
    [name, description || null, category_id]
  );
  return result.insertId;
};

// Update subcategory
const updateSubcategory = async (id, { name, description, category_id }) => {
  await pool.query(
    'UPDATE subcategories SET name = ?, description = ?, category_id = ? WHERE id = ?',
    [name, description || null, category_id, id]
  );
};

// Delete subcategory
const deleteSubcategory = async (id) => {
  await pool.query('DELETE FROM subcategories WHERE id = ?', [id]);
};

module.exports = {
  getAllSubcategories,
  getSubcategoriesByCategory,
  getSubcategoryById,
  createSubcategory,
  updateSubcategory,
  deleteSubcategory,
};
