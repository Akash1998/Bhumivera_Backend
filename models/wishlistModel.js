// backend/models/wishlistModel.js
const pool = require('../config/db');
require('dotenv').config();
const CLOUDFRONT_BASE_URL = (process.env.CLOUDFRONT_BASE_URL || 'https://pub-70fdb5d94df347c4bed417c28b066c02.r2.dev/bhumivera').replace(/\/$/, '');

const createWishlistTable = async () => {
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
};

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
    `SELECT w.id AS wishlist_id, w.created_at,
      p.id, p.id AS product_id, p.slug, p.name, p.price, p.discount_price,
      p.quantity, p.status, p.brand, p.description, c.name AS category_name
      FROM wishlist w
      JOIN products p ON w.product_id = p.id
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE w.user_id = ?
      ORDER BY w.created_at DESC`,
    [userId]
  );

  if (rows.length === 0) return rows;
  const productIds = rows.map(item => item.product_id);
  const placeholders = productIds.map(() => '?').join(',');
  const [imageRows] = await pool.query(
    `SELECT product_id, file_path, media_type
      FROM product_images
      WHERE product_id IN (${placeholders})
      ORDER BY sort_order, id`,
    productIds
  );
  const imagesByProduct = new Map();
  for (const row of imageRows) {
    const images = imagesByProduct.get(row.product_id) || [];
    const url = /^https?:\/\//i.test(row.file_path)
      ? row.file_path
      : `${CLOUDFRONT_BASE_URL}/${String(row.file_path).replace(/^\/+/, '')}`;
    images.push({ url, file_path: row.file_path, type: row.media_type || 'image' });
    imagesByProduct.set(row.product_id, images);
  }

  return rows.map(item => {
    const images = imagesByProduct.get(item.product_id) || [];
    return { ...item, images, image_url: images[0]?.url || null };
  });
};

const isInWishlist = async (userId, productId) => {
  const [rows] = await pool.query(
    'SELECT id FROM wishlist WHERE user_id = ? AND product_id = ?',
    [userId, productId]
  );
  return rows.length > 0;
};

module.exports = { createWishlistTable, addToWishlist, removeFromWishlist, getWishlistByUser, isInWishlist };
