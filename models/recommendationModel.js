const pool = require('../config/db');

const createRecommendationTables = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_product_views (
      user_id INT NOT NULL,
      product_id INT NOT NULL,
      view_count SMALLINT UNSIGNED NOT NULL DEFAULT 1,
      last_viewed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, product_id),
      INDEX idx_user_product_views_recent (user_id, last_viewed_at),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
    )
  `);
};

const recordProductView = async (userId, productId) => {
  await pool.query(
    `INSERT INTO user_product_views (user_id, product_id)
     VALUES (?, ?)
     ON DUPLICATE KEY UPDATE
       view_count = LEAST(view_count + 1, 65535),
       last_viewed_at = CURRENT_TIMESTAMP`,
    [userId, productId]
  );
};

const getPersonalizedRecommendations = async (userId, currentProductId, limit = 8) => {
  const [rows] = await pool.query(
    `WITH user_signals AS (
       SELECT oi.product_id, 4 + LEAST(SUM(oi.quantity), 5) AS weight
       FROM orders o
       JOIN order_items oi ON oi.order_id = o.id
       WHERE o.user_id = ? AND oi.product_id IS NOT NULL
         AND o.status NOT IN ('cancelled', 'returned')
       GROUP BY oi.product_id
       UNION ALL
       SELECT product_id, 3 AS weight
       FROM wishlist
       WHERE user_id = ?
       UNION ALL
       SELECT product_id, 2 AS weight
       FROM reviews
       WHERE user_id = ? AND is_approved = 1 AND rating >= 4
       UNION ALL
       SELECT product_id, LEAST(view_count, 5) AS weight
       FROM user_product_views
       WHERE user_id = ?
     )
     SELECT p.*,
       SUM(
         CASE WHEN p.category_id IS NOT NULL AND p.category_id = seed.category_id THEN 5 ELSE 0 END +
         CASE WHEN p.brand IS NOT NULL AND seed.brand IS NOT NULL AND LOWER(p.brand) = LOWER(seed.brand) THEN 3 ELSE 0 END +
         CASE WHEN p.price BETWEEN seed.price * 0.7 AND seed.price * 1.3 THEN 1 ELSE 0 END
       ) AS recommendation_score
     FROM products p
     JOIN user_signals s ON 1 = 1
     JOIN products seed ON seed.id = s.product_id
     WHERE p.status = 'active'
       AND p.id <> ?
       AND (
         (p.category_id IS NOT NULL AND p.category_id = seed.category_id) OR
         (p.brand IS NOT NULL AND seed.brand IS NOT NULL AND LOWER(p.brand) = LOWER(seed.brand)) OR
         p.price BETWEEN seed.price * 0.7 AND seed.price * 1.3
       )
     GROUP BY p.id
     ORDER BY recommendation_score DESC, p.is_trending DESC, p.rating DESC, p.created_at DESC
     LIMIT ?`,
    [userId, userId, userId, userId, currentProductId, limit]
  );

  if (rows.length) return { products: rows, personalized: true };

  const [popularProducts] = await pool.query(
    `SELECT p.*
     FROM products p
     WHERE p.status = 'active' AND p.id <> ?
     ORDER BY p.is_trending DESC, p.rating DESC, p.review_count DESC, p.created_at DESC
     LIMIT ?`,
    [currentProductId, limit]
  );
  return { products: popularProducts, personalized: false };
};

module.exports = { createRecommendationTables, recordProductView, getPersonalizedRecommendations };
