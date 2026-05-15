// backend/models/wishlistModel.js
const pool = require('../config/db');
require('dotenv').config();
const CLOUDFRONT_BASE_URL = process.env.CLOUDFRONT_BASE_URL;

const createWishlistTable = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wishlist (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        product_id INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY unique_wishlist (user_id, product_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
      )
    `);
    console.log("✅ Database Verified: 'wishlist' table is active and ready.");
  } catch (err) {
    console.error("❌ Wishlist Table Init Error:", err.message);
  }
};

// Zero-Regression Auto-Migration: Auto-provision the table on boot
createWishlistTable();

const addToWishlist = async (userId, productId) => {
  await pool.query(
    'INSERT IGNORE INTO wishlist (user_id, product_id) VALUES (?, ?)',
    [userId, productId]
  );
};

const removeFromWishlist = async (userId, productId) => {
  await pool.query(
    'DELETE FROM wishlist WHERE user_id = ? AND product_id = ?',
    [userId, productId]
  );
};

const getWishlistByUser = async (userId) => {
  const [rows] = await pool.query(
    `SELECT w.id, w.created_at,
      p.id as product_id, p.name, p.price, p.discount_price, p.quantity, p.status
      FROM wishlist w
      JOIN products p ON w.product_id = p.id
      WHERE w.user_id = ?`,
    [userId]
  );

  // Attach images manually as done in productModel.js
  for (const item of rows) {
    const [imgs] = await pool.query(
      'SELECT file_path FROM product_images WHERE product_id = ?',
      [item.product_id]
    );
    item.images = imgs.map((r) => `${CLOUDFRONT_BASE_URL}/${r.file_path}`);
  }

  return rows;
};

const isInWishlist = async (userId, productId) => {
  const [rows] = await pool.query(
    'SELECT id FROM wishlist WHERE user_id = ? AND product_id = ?',
    [userId, productId]
  );
  return rows.length > 0;
};

module.exports = { createWishlistTable, addToWishlist, removeFromWishlist, getWishlistByUser, isInWishlist };
