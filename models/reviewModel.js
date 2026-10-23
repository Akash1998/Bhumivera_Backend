let pool;
try { pool = require('../config/db'); } catch (_) { pool = { query: async () => [[]] }; }
const { INITIAL_REVIEWS_SEED } = require('../data/bhumiveraReviewsData');
const { LUXURY_CATALOG } = require('../data/luxuryCatalog');

// Mutable runtime store initialized with the 330 unique customer reviews
let memoryReviewsStore = INITIAL_REVIEWS_SEED.map(r => ({ ...r }));

const parseReview = review => {
  if (!review) return review;
  let images = review.images;
  if (typeof images === 'string') {
    try { images = JSON.parse(images); } catch { images = []; }
  }
  return {
    ...review,
    body: review.body || review.comment || '',
    comment: review.comment || review.body || '',
    user_name: review.user_name || review.reviewer_name || 'Verified Customer',
    reviewer_name: review.reviewer_name || review.user_name || 'Verified Customer',
    images: Array.isArray(images) ? images : []
  };
};

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

const syncProductStats = async (productId) => {
  try {
    await pool.query(`
      UPDATE products p
      SET rating = (SELECT IFNULL(AVG(rating), 0) FROM reviews WHERE product_id = p.id AND is_approved = 1),
          review_count = (SELECT COUNT(*) FROM reviews WHERE product_id = p.id AND is_approved = 1)
      WHERE p.id = ?
    `, [productId]);
  } catch (_) {
    // Ignore DB sync error when running against in-memory store
  }
};

const createReview = async (data) => {
  const { product_id, user_id, order_id, rating, title, body, images = [], public_story_consent = false } = data;
  try {
    const [result] = await pool.query(
      'INSERT INTO reviews (product_id, user_id, order_id, rating, title, body, images, public_story_consent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [product_id, user_id, order_id || null, rating, title || null, body || null, JSON.stringify(images), public_story_consent && images.length > 0 ? 1 : 0]
    );
    return result.insertId;
  } catch (_) {
    const newId = Math.max(2000, ...memoryReviewsStore.map(r => Number(r.id) || 0)) + 1;
    const prod = LUXURY_CATALOG.find(p => Number(p.id) === Number(product_id)) || {};
    const nowIso = new Date().toISOString();
    memoryReviewsStore.unshift({
      id: newId,
      product_id: Number(product_id),
      product_slug: prod.slug || '',
      product_name: prod.name || `Product #${product_id}`,
      user_id: Number(user_id) || 999,
      user_name: data.user_name || 'Verified Customer',
      reviewer_name: data.user_name || 'Verified Customer',
      order_id: order_id || null,
      rating: Number(rating),
      title: title || null,
      body: body || null,
      comment: body || null,
      images: Array.isArray(images) ? images : [],
      public_story_consent: public_story_consent && images.length > 0 ? 1 : 0,
      is_approved: 1,
      status: 'approved',
      created_at: data.created_at || nowIso,
      updated_at: nowIso
    });
    return newId;
  }
};

const createReviewAsAdmin = async (data) => {
  const newId = Math.max(2000, ...memoryReviewsStore.map(r => Number(r.id) || 0)) + 1;
  const productId = Number(data.product_id) || 3;
  const prod = LUXURY_CATALOG.find(p => Number(p.id) === productId) || {};
  const createdAt = data.created_at ? new Date(data.created_at).toISOString() : new Date().toISOString();
  const newReview = {
    id: newId,
    product_id: productId,
    product_slug: prod.slug || '',
    product_name: data.product_name || prod.name || `Product #${productId}`,
    user_id: 3000 + newId,
    user_name: (data.user_name || data.reviewer_name || 'Verified Patron').trim(),
    reviewer_name: (data.user_name || data.reviewer_name || 'Verified Patron').trim(),
    reviewer_location: (data.reviewer_location || 'India').trim(),
    user_email: data.user_email || `patron.${newId}@bhumivera.com`,
    order_id: data.order_id || (90000 + newId),
    order_number: data.order_number || `BV-2026-${90000 + newId}`,
    rating: Number(data.rating) || 5,
    title: (data.title || '').trim(),
    body: (data.body || data.comment || '').trim(),
    comment: (data.body || data.comment || '').trim(),
    images: Array.isArray(data.images) ? data.images : [],
    public_story_consent: Array.isArray(data.images) && data.images.length > 0 ? 1 : 0,
    is_approved: data.is_approved !== undefined ? (data.is_approved ? 1 : 0) : 1,
    verified_purchase: data.verified_purchase !== false,
    status: data.is_approved === 0 || data.is_approved === false ? 'pending' : 'approved',
    created_at: createdAt,
    updated_at: new Date().toISOString()
  };
  memoryReviewsStore.unshift(newReview);
  return newReview;
};

const getPublicCustomerStories = async () => {
  try {
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
    const parsed = rows.map(parseReview).filter(review => review.images.length > 0);
    if (parsed.length > 0) return parsed;
  } catch (_) {}

  return memoryReviewsStore
    .filter(r => Number(r.is_approved) === 1 && Array.isArray(r.images) && r.images.length > 0)
    .slice(0, 12)
    .map(r => ({
      ...parseReview(r),
      first_name: String(r.user_name || 'Patron').split(' ')[0]
    }));
};

const getReviewsByProduct = async (productId, approvedOnly = true) => {
  let dbRows = [];
  try {
    const whereClause = approvedOnly ? 'AND r.is_approved = 1' : '';
    const [rows] = await pool.query(
      `SELECT r.*, u.name as user_name FROM reviews r
      JOIN users u ON r.user_id = u.id
      WHERE r.product_id = ? ${whereClause}
      ORDER BY r.created_at DESC`,
      [productId]
    );
    dbRows = rows.map(parseReview);
  } catch (_) {}

  const memRows = memoryReviewsStore
    .filter(r => Number(r.product_id) === Number(productId) && (!approvedOnly || Number(r.is_approved) === 1))
    .map(parseReview);

  const combined = [...dbRows, ...memRows];
  const seenIds = new Set();
  return combined.filter(r => {
    if (seenIds.has(r.id)) return false;
    seenIds.add(r.id);
    return true;
  }).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
};

const getProductRatingSummary = async (productId) => {
  const reviews = await getReviewsByProduct(productId, true);
  const total = reviews.length;
  if (total === 0) {
    return { total: 0, average: 0, five: 0, four: 0, three: 0, two: 0, one: 0 };
  }
  const sum = reviews.reduce((acc, r) => acc + (Number(r.rating) || 0), 0);
  const average = Number((sum / total).toFixed(1));
  return {
    total,
    average,
    five: reviews.filter(r => Math.round(Number(r.rating)) === 5).length,
    four: reviews.filter(r => Math.round(Number(r.rating)) === 4).length,
    three: reviews.filter(r => Math.round(Number(r.rating)) === 3).length,
    two: reviews.filter(r => Math.round(Number(r.rating)) === 2).length,
    one: reviews.filter(r => Math.round(Number(r.rating)) === 1).length,
  };
};

const getAllReviews = async (approved = null) => {
  let dbRows = [];
  try {
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
    dbRows = rows.map(parseReview);
  } catch (_) {}

  const memRows = memoryReviewsStore
    .filter(r => approved === null || Number(r.is_approved) === Number(approved))
    .map(parseReview);

  const combined = [...dbRows, ...memRows];
  const seenIds = new Set();
  return combined.filter(r => {
    if (seenIds.has(r.id)) return false;
    seenIds.add(r.id);
    return true;
  }).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
};

const updateReviewAsAdmin = async (id, data) => {
  const memIdx = memoryReviewsStore.findIndex(r => String(r.id) === String(id));
  if (memIdx !== -1) {
    const existing = memoryReviewsStore[memIdx];
    const previousImages = Array.isArray(existing.images) ? existing.images : [];
    const nextProductId = data.product_id !== undefined ? Number(data.product_id) : existing.product_id;
    const prod = LUXURY_CATALOG.find(p => Number(p.id) === Number(nextProductId));
    const updated = {
      ...existing,
      ...(data.rating !== undefined ? { rating: Number(data.rating) } : {}),
      ...(data.title !== undefined ? { title: data.title } : {}),
      ...(data.body !== undefined ? { body: data.body, comment: data.body } : {}),
      ...(data.user_name !== undefined ? { user_name: data.user_name, reviewer_name: data.user_name } : {}),
      ...(data.reviewer_location !== undefined ? { reviewer_location: data.reviewer_location } : {}),
      ...(data.created_at !== undefined ? { created_at: new Date(data.created_at).toISOString() } : {}),
      ...(data.product_id !== undefined ? {
        product_id: nextProductId,
        product_name: prod?.name || existing.product_name,
        product_slug: prod?.slug || existing.product_slug
      } : {}),
      ...(data.images !== undefined ? { images: data.images } : {}),
      ...(data.is_approved !== undefined ? {
        is_approved: data.is_approved ? 1 : 0,
        status: data.is_approved ? 'approved' : 'pending'
      } : {}),
      updated_at: new Date().toISOString()
    };
    memoryReviewsStore[memIdx] = updated;
    const retained = Array.isArray(updated.images) ? updated.images : [];
    return {
      review: updated,
      removedImages: previousImages.filter(image => !retained.includes(image) && typeof image === 'string' && image.startsWith('reviews/'))
    };
  }

  try {
    const [[review]] = await pool.query('SELECT product_id, images FROM reviews WHERE id = ?', [id]);
    if (!review) return false;
    const previousImages = parseReview(review).images;
    const fields = [];
    const values = [];
    for (const field of ['rating', 'title', 'body', 'is_approved', 'created_at', 'product_id']) {
      if (Object.prototype.hasOwnProperty.call(data, field) && data[field] !== undefined) {
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
  } catch (_) {
    return false;
  }
};

const approveReview = async (id) => {
  const memIdx = memoryReviewsStore.findIndex(r => String(r.id) === String(id));
  if (memIdx !== -1) {
    memoryReviewsStore[memIdx] = {
      ...memoryReviewsStore[memIdx],
      is_approved: 1,
      status: 'approved',
      updated_at: new Date().toISOString()
    };
    return true;
  }
  try {
    const [[review]] = await pool.query('SELECT product_id FROM reviews WHERE id = ?', [id]);
    if (!review) return false;
    await pool.query('UPDATE reviews SET is_approved = 1 WHERE id = ?', [id]);
    await syncProductStats(review.product_id);
    return true;
  } catch (_) {
    return false;
  }
};

const rejectReview = async (id) => {
  const memIdx = memoryReviewsStore.findIndex(r => String(r.id) === String(id));
  if (memIdx !== -1) {
    const removed = memoryReviewsStore.splice(memIdx, 1)[0];
    return (removed.images || []).filter(image => typeof image === 'string' && image.startsWith('reviews/'));
  }
  try {
    const [[review]] = await pool.query('SELECT product_id, images FROM reviews WHERE id = ?', [id]);
    if (!review) return null;
    await pool.query('DELETE FROM reviews WHERE id = ?', [id]);
    await syncProductStats(review.product_id);
    return parseReview(review).images.filter(image => image.startsWith('reviews/'));
  } catch (_) {
    return null;
  }
};

const getUserReviews = async (userId) => {
  try {
    const [rows] = await pool.query(
      `SELECT r.*, p.name as product_name FROM reviews r
      JOIN products p ON r.product_id = p.id
      WHERE r.user_id = ? ORDER BY r.created_at DESC`,
      [userId]
    );
    return rows.map(parseReview);
  } catch (_) {
    return memoryReviewsStore.filter(r => Number(r.user_id) === Number(userId)).map(parseReview);
  }
};

module.exports = { 
  createReviewTable, 
  createReview,
  createReviewAsAdmin,
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
