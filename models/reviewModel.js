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
      images JSON DEFAULT NULL,
      public_story_consent TINYINT(1) NOT NULL DEFAULT 0,
      is_approved TINYINT(1) DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY one_review_per_order (user_id, product_id, order_id),
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  const [imageColumn] = await pool.query("SHOW COLUMNS FROM reviews LIKE 'images'");
  if (!imageColumn.length) {
    await pool.query('ALTER TABLE reviews ADD COLUMN images JSON DEFAULT NULL');
  }
  const [storyConsentColumn] = await pool.query("SHOW COLUMNS FROM reviews LIKE 'public_story_consent'");
  if (!storyConsentColumn.length) {
    await pool.query('ALTER TABLE reviews ADD COLUMN public_story_consent TINYINT(1) NOT NULL DEFAULT 0');
  }
};

const parseReview = review => {
  if (!review) return review;
  let images = review.images;
  if (typeof images === 'string') {
    try { images = JSON.parse(images); } catch { images = []; }
  }
  return { ...review, images: Array.isArray(images) ? images : [] };
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
  const { product_id, user_id, order_id, rating, title, body, images = [], public_story_consent = false } = data;
  const [result] = await pool.query(
    'INSERT INTO reviews (product_id, user_id, order_id, rating, title, body, images, public_story_consent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [product_id, user_id, order_id || null, rating, title || null, body || null, JSON.stringify(images), public_story_consent && images.length > 0 ? 1 : 0]
  );
  return result.insertId;
};

const getPublicCustomerStories = async () => {
  const [rows] = await pool.query(
    `SELECT r.id, r.product_id, r.rating, r.title, r.body, r.images, r.created_at,
            SUBSTRING_INDEX(u.name, ' ', 1) AS first_name, p.name AS product_name
     FROM reviews r
     JOIN users u ON r.user_id = u.id
     JOIN products p ON r.product_id = p.id
     WHERE r.is_approved = 1 AND r.public_story_consent = 1
     ORDER BY r.created_at DESC
     LIMIT 12`
  );
  return rows.map(parseReview).filter(review => review.images.length > 0);
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
  return rows.map(parseReview);
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
  let query = `SELECT r.*, u.name as user_name, u.email as user_email,
    p.name as product_name, o.id as order_number
    FROM reviews r
    JOIN users u ON r.user_id = u.id
    JOIN products p ON r.product_id = p.id
    LEFT JOIN orders o ON r.order_id = o.id`;
  const params = [];
  if (approved !== null) { query += ' WHERE r.is_approved = ?'; params.push(approved); }
  query += ' ORDER BY r.created_at DESC';
  const [rows] = await pool.query(query, params);
  return rows.map(parseReview);
};

const updateReviewAsAdmin = async (id, data) => {
  const [[review]] = await pool.query('SELECT product_id, images FROM reviews WHERE id = ?', [id]);
  if (!review) return false;
  const previousImages = parseReview(review).images;
  const fields = [];
  const values = [];
  for (const field of ['rating', 'title', 'body', 'is_approved']) {
    if (Object.prototype.hasOwnProperty.call(data, field)) {
      fields.push(`${field} = ?`);
      values.push(data[field]);
    }
  }
  if (Object.prototype.hasOwnProperty.call(data, 'images')) {
    fields.push('images = ?');
    values.push(JSON.stringify(data.images));
  }
  if (fields.length) {
    values.push(id);
    await pool.query(`UPDATE reviews SET ${fields.join(', ')} WHERE id = ?`, values);
  }
  await syncProductStats(review.product_id);
  const retained = Object.prototype.hasOwnProperty.call(data, 'images') ? data.images : previousImages;
  return {
    removedImages: previousImages.filter(image => !retained.includes(image) && image.startsWith('reviews/'))
  };
};

const approveReview = async (id) => {
  const [[review]] = await pool.query('SELECT product_id FROM reviews WHERE id = ?', [id]);
  if (!review) return false;
  await pool.query('UPDATE reviews SET is_approved = 1 WHERE id = ?', [id]);
  await syncProductStats(review.product_id);
  return true;
};

const rejectReview = async (id) => {
  const [[review]] = await pool.query('SELECT product_id, images FROM reviews WHERE id = ?', [id]);
  if (!review) return null;
  await pool.query('DELETE FROM reviews WHERE id = ?', [id]);
  await syncProductStats(review.product_id);
  return parseReview(review).images.filter(image => image.startsWith('reviews/'));
};

const getUserReviews = async (userId) => {
  const [rows] = await pool.query(
    `SELECT r.*, p.name as product_name FROM reviews r
    JOIN products p ON r.product_id = p.id
    WHERE r.user_id = ? ORDER BY r.created_at DESC`,
    [userId]
  );
  return rows.map(parseReview);
};

module.exports = { 
  createReviewTable, 
  createReview, 
  getReviewsByProduct, 
  getPublicCustomerStories,
  getProductRatingSummary, 
  getAllReviews, 
  approveReview, 
  rejectReview, 
  getUserReviews,
  updateReviewAsAdmin,
  syncProductStats
};
