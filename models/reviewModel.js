const pool = require('../config/db');

const createReviewTable = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reviews (
      id INT AUTO_INCREMENT PRIMARY KEY,
      product_id INT NOT NULL,
      user_id INT NOT NULL,
      order_id INT DEFAULT NULL,
      rating TINYINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
      title VARCHAR(255) DEFAULT NULL,
      body TEXT DEFAULT NULL,
      is_approved TINYINT(1) DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY one_review_per_order (user_id, product_id, order_id),
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
};

const syncProductStats = async (productId) => {
  await pool.query(`
    UPDATE products p
    SET rating = (SELECT IFNULL(AVG(rating), 0) FROM reviews WHERE product_id = p.id AND is_approved = 1),
        review_count = (SELECT COUNT(*) FROM reviews WHERE product_id = p.id AND is_approved = 1)
    WHERE p.id = ?
  `, [productId]);
};

const createReview = async (data) => {
  const { product_id, user_id, order_id, rating, title, body } = data;
  const [result] = await pool.query(
    'INSERT INTO reviews (product_id, user_id, order_id, rating, title, body) VALUES (?, ?, ?, ?, ?, ?)',
    [product_id, user_id, order_id || null, rating, title || null, body || null]
  );
  return result.insertId;
};

const getReviewsByProduct = async (productId, approvedOnly = true) => {
  const whereClause = approvedOnly ? 'AND r.is_approved = 1' : '';
  const [rows] = await pool.query(
    `SELECT r.*, u.name as user_name FROM reviews r
    JOIN users u ON r.user_id = u.id
    WHERE r.product_id = ? ${whereClause}
    ORDER BY r.created_at DESC`,
    [productId]
  );
  return rows;
};

const getProductRatingSummary = async (productId) => {
  const [rows] = await pool.query(
    `SELECT COUNT(*) as total, AVG(rating) as average,
    SUM(rating=5) as five, SUM(rating=4) as four, SUM(rating=3) as three,
    SUM(rating=2) as two, SUM(rating=1) as one
    FROM reviews WHERE product_id = ? AND is_approved = 1`,
    [productId]
  );
  return rows[0];
};

const getAllReviews = async (approved = null) => {
  let query = `SELECT r.*, u.name as user_name, p.name as product_name
    FROM reviews r
    JOIN users u ON r.user_id = u.id
    JOIN products p ON r.product_id = p.id`;
  const params = [];
  if (approved !== null) { query += ' WHERE r.is_approved = ?'; params.push(approved); }
  query += ' ORDER BY r.created_at DESC';
  const [rows] = await pool.query(query, params);
  return rows;
};

const approveReview = async (id) => {
  const [[review]] = await pool.query('SELECT product_id FROM reviews WHERE id = ?', [id]);
  if (!review) return;
  await pool.query('UPDATE reviews SET is_approved = 1 WHERE id = ?', [id]);
  await syncProductStats(review.product_id);
};

const rejectReview = async (id) => {
  const [[review]] = await pool.query('SELECT product_id FROM reviews WHERE id = ?', [id]);
  if (!review) return;
  await pool.query('DELETE FROM reviews WHERE id = ?', [id]);
  await syncProductStats(review.product_id);
};

const getUserReviews = async (userId) => {
  const [rows] = await pool.query(
    `SELECT r.*, p.name as product_name FROM reviews r
    JOIN products p ON r.product_id = p.id
    WHERE r.user_id = ? ORDER BY r.created_at DESC`,
    [userId]
  );
  return rows;
};

module.exports = { 
  createReviewTable, 
  createReview, 
  getReviewsByProduct, 
  getProductRatingSummary, 
  getAllReviews, 
  approveReview, 
  rejectReview, 
  getUserReviews 
};
