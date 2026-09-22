const pool = require('../config/db');

// Helper: add column if it doesn't exist
const addColumnIfMissing = async (table, column, definition) => {
  const [cols] = await pool.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = ?
     AND COLUMN_NAME = ?`,
    [table, column]
  );
  if (cols.length === 0) {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
};

// Non-destructive init: create table and add new columns if missing
const initCategoriesTable = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS categories (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      description TEXT,
      image_url VARCHAR(500),
      is_active TINYINT(1) DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await addColumnIfMissing('categories', 'description', 'TEXT AFTER name');
  await addColumnIfMissing('categories', 'image_url', 'VARCHAR(500) AFTER description');
  await addColumnIfMissing('categories', 'is_active', 'TINYINT(1) DEFAULT 1 AFTER image_url');
};

const getAllCategories = async () => {
  const [rows] = await pool.query(
    'SELECT id, name, description, image_url, is_active, created_at FROM categories ORDER BY name'
  );
  return rows;
};

const getCategoryById = async (id) => {
  const [rows] = await pool.query(
    'SELECT id, name, description, image_url, is_active, created_at FROM categories WHERE id = ?',
    [id]
  );
  return rows[0];
};

const createCategory = async ({ name, description, image_url, is_active }) => {
  const [result] = await pool.query(
    'INSERT INTO categories (name, description, image_url, is_active) VALUES (?, ?, ?, ?)',
    [name, description || null, image_url || null, is_active !== undefined ? is_active : 1]
  );
  return result.insertId;
};

const updateCategory = async (id, { name, description, image_url, is_active }) => {
  await pool.query(
    'UPDATE categories SET name = ?, description = ?, image_url = ?, is_active = ? WHERE id = ?',
    [name, description || null, image_url || null, is_active !== undefined ? is_active : 1, id]
  );
};

const deleteCategory = async (id) => {
  await pool.query('DELETE FROM categories WHERE id = ?', [id]);
};

module.exports = {
  getAllCategories,
  getCategoryById,
  createCategory,
  updateCategory,
  deleteCategory,
  initCategoriesTable // FIXED: Exported function so server.js can initialize safely
};
