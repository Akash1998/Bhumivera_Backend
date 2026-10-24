const pool = require('../config/db');
const { INITIAL_REVIEWS_SEED } = require('../data/bhumiveraReviewsData');

const parseJsonArray = val => {
  if (Array.isArray(val)) return val;
  if (typeof val === 'string' && val.trim()) {
    try {
      const parsed = JSON.parse(val);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
};

const parseReview = review => {
  if (!review) return review;
  const images = parseJsonArray(review.images);
  const videos = parseJsonArray(review.videos);
  const name = review.reviewer_name || review.user_name || 'Verified Patron';
  return {
    ...review,
    user_name: name,
    reviewer_name: name,
    reviewer_location: review.reviewer_location || 'India',
    category_tag: review.category_tag || 'Quick & Everyday Impressions',
    is_combo_review: Boolean(review.is_combo_review || review.category_tag === 'Combo Pack Ritual'),
    body: review.body || review.comment || '',
    comment: review.comment || review.body || '',
    images,
    videos,
    helpful_count: Number(review.helpful_count) || 0,
    is_approved: Number(review.is_approved ?? 1),
    status: Number(review.is_approved ?? 1) === 1 ? 'approved' : 'pending'
  };
};

const createReviewTable = async (db = pool) => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS reviews (
      id INT AUTO_INCREMENT PRIMARY KEY,
      product_id INT NOT NULL,
      user_id INT DEFAULT NULL,
      order_id INT DEFAULT NULL,
      order_number VARCHAR(64) DEFAULT NULL,
      reviewer_name VARCHAR(150) DEFAULT 'Verified Patron',
      reviewer_location VARCHAR(150) DEFAULT 'India',
      category_tag VARCHAR(120) DEFAULT 'Quick & Everyday Impressions',
      is_combo_review TINYINT(1) DEFAULT 0,
      combo_name VARCHAR(255) DEFAULT NULL,
      rating TINYINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
      title VARCHAR(255) DEFAULT NULL,
      body TEXT DEFAULT NULL,
      images JSON DEFAULT NULL,
      videos JSON DEFAULT NULL,
      helpful_count INT DEFAULT 0,
      public_story_consent TINYINT(1) NOT NULL DEFAULT 0,
      is_approved TINYINT(1) DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  const extraCols = [
    ['images', 'JSON DEFAULT NULL'],
    ['videos', 'JSON DEFAULT NULL'],
    ['public_story_consent', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['reviewer_name', "VARCHAR(150) DEFAULT 'Verified Patron'"],
    ['reviewer_location', "VARCHAR(150) DEFAULT 'India'"],
    ['category_tag', "VARCHAR(120) DEFAULT 'Quick & Everyday Impressions'"],
    ['is_combo_review', 'TINYINT(1) DEFAULT 0'],
    ['combo_name', 'VARCHAR(255) DEFAULT NULL'],
    ['order_number', 'VARCHAR(64) DEFAULT NULL'],
    ['helpful_count', 'INT DEFAULT 0'],
  ];

  for (const [col, def] of extraCols) {
    const [exists] = await db.query(`SHOW COLUMNS FROM reviews LIKE '${col}'`);
    if (!exists.length) {
      await db.query(`ALTER TABLE reviews ADD COLUMN ${col} ${def}`);
    }
  }
};

const syncProductStats = async (productId, db = pool) => {
  await db.query(`
    UPDATE products p
    SET rating = (SELECT IFNULL(ROUND(AVG(rating), 2), 0) FROM reviews WHERE product_id = p.id AND is_approved = 1),
        review_count = (SELECT COUNT(*) FROM reviews WHERE product_id = p.id AND is_approved = 1)
    WHERE p.id = ?
  `, [productId]);
};

/**
 * Automatically seeds all 1,080 classified customer reviews (2020–2026) into MySQL database
 * and updates product ratings and review counts.
 */
const seedAllCustomerReviews = async (customPool = null) => {
  const db = customPool || pool;
  await createReviewTable(db);
  const [pRows] = await db.query('SELECT id, slug FROM products');
  const productSlugToDbId = new Map();
  const seededProductSlugs = new Set(INITIAL_REVIEWS_SEED.map(review => review.product_slug));
  for (const row of pRows || []) {
    if (seededProductSlugs.has(row.slug)) productSlugToDbId.set(row.slug, row.id);
  }
  const missingProductSlugs = [...seededProductSlugs].filter(slug => !productSlugToDbId.has(slug));
  if (missingProductSlugs.length > 0) {
    throw new Error(`Cannot seed customer reviews; catalog products are missing: ${missingProductSlugs.join(', ')}.`);
  }

  let defaultUserId = null;
  const [uRows] = await db.query('SELECT id FROM users ORDER BY id LIMIT 1');
  if (uRows?.[0]?.id) {
    defaultUserId = uRows[0].id;
  }
  const orderNumbers = INITIAL_REVIEWS_SEED.map(review => review.order_number);
  const placeholders = orderNumbers.map(() => '?').join(', ');
  const [existingSeedRows] = await db.query(
    `SELECT order_number FROM reviews WHERE order_number IN (${placeholders})`,
    orderNumbers
  );
  const existingOrderNumbers = new Set((existingSeedRows || []).map(row => row.order_number));

  for (const r of INITIAL_REVIEWS_SEED) {
    if (existingOrderNumbers.has(r.order_number)) continue;
    const targetProdId = productSlugToDbId.get(r.product_slug);
    const mysqlDate = new Date(r.created_at).toISOString().slice(0, 19).replace('T', ' ');
    await db.query(
      `INSERT IGNORE INTO reviews
            (product_id, user_id, order_id, order_number, reviewer_name, reviewer_location,
             category_tag, is_combo_review, combo_name, rating, title, body, images, videos,
             helpful_count, public_story_consent, is_approved, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        targetProdId,
        defaultUserId,
        null,
        r.order_number,
        r.reviewer_name || r.user_name,
        r.reviewer_location || 'India',
        r.category_tag || 'Quick & Everyday Impressions',
        r.is_combo_review ? 1 : 0,
        r.combo_name || null,
        r.rating,
        r.title,
        r.body,
        JSON.stringify(r.images || []),
        JSON.stringify(r.videos || []),
        r.helpful_count || 5,
        r.public_story_consent ? 1 : 0,
        1,
        mysqlDate,
        mysqlDate
      ]
    );
  }

  for (const productId of new Set(productSlugToDbId.values())) {
    await syncProductStats(productId, db);
  }
  return INITIAL_REVIEWS_SEED.length - existingOrderNumbers.size;
};

const createReview = async (data) => {
  const {
    product_id,
    user_id,
    order_id,
    rating,
    title,
    body,
    images = [],
    videos = [],
    category_tag = 'Quick & Everyday Impressions',
    user_name = 'Verified Patron',
    reviewer_location = 'India',
    public_story_consent = false
  } = data;

  const nowIso = data.created_at ? new Date(data.created_at).toISOString() : new Date().toISOString();
  const [result] = await pool.query(
    'INSERT INTO reviews (product_id, user_id, order_id, reviewer_name, reviewer_location, category_tag, rating, title, body, images, videos, public_story_consent, is_approved, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)',
    [
      product_id,
      user_id || null,
      order_id || null,
      user_name,
      reviewer_location,
      category_tag,
      rating,
      title || null,
      body || null,
      JSON.stringify(images),
      JSON.stringify(videos),
      public_story_consent && (images.length > 0 || videos.length > 0) ? 1 : 0,
      nowIso.slice(0, 19).replace('T', ' ')
    ]
  );
  await syncProductStats(product_id);
  return result.insertId;
};

const createReviewAsAdmin = async (data) => {
  let productRows = [];
  if (data.product_slug) {
    [productRows] = await pool.query('SELECT id, name, slug FROM products WHERE slug = ? LIMIT 1', [data.product_slug]);
  }
  if (!productRows.length && Number.isInteger(Number(data.product_id)) && Number(data.product_id) > 0) {
    [productRows] = await pool.query('SELECT id, name, slug FROM products WHERE id = ? LIMIT 1', [Number(data.product_id)]);
  }
  const product = productRows[0];
  if (!product) throw new Error('The selected product does not exist in the database.');
  const productId = product.id;
  const createdAt = data.created_at ? new Date(data.created_at).toISOString() : new Date().toISOString();
  const categoryTag = data.category_tag || (Number(data.rating) === 1 ? 'Shipping & Packaging Feedback' : 'Quick & Everyday Impressions');
  const isCombo = Boolean(data.is_combo_review || categoryTag === 'Combo Pack Ritual');
  const userName = (data.user_name || data.reviewer_name || 'Verified Patron').trim();
  const reviewerLocation = (data.reviewer_location || 'India').trim();
  const title = (data.title || '').trim();
  const body = (data.body || data.comment || '').trim();
  const images = Array.isArray(data.images) ? data.images : [];
  const videos = Array.isArray(data.videos) ? data.videos : [];
  const helpfulCount = Number(data.helpful_count) || 0;
  const publicStoryConsent = (Array.isArray(data.images) && data.images.length > 0) ||
    (Array.isArray(data.videos) && data.videos.length > 0) ? 1 : 0;
  const isApproved = data.is_approved !== undefined ? (data.is_approved ? 1 : 0) : 1;
  const mysqlDate = createdAt.slice(0, 19).replace('T', ' ');
  const [result] = await pool.query(
    `INSERT INTO reviews
      (product_id, reviewer_name, reviewer_location, category_tag, is_combo_review, combo_name,
       order_number, rating, title, body, images, videos, helpful_count, public_story_consent, is_approved, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      productId,
      userName,
      reviewerLocation,
      categoryTag,
      isCombo ? 1 : 0,
      isCombo ? (data.combo_name || 'The Complete Botanical Daily Regimen (Combo Pack)') : null,
      data.order_number || null,
      Number(data.rating) || 5,
      title || null,
      body || null,
      JSON.stringify(images),
      JSON.stringify(videos),
      helpfulCount,
      publicStoryConsent,
      isApproved,
      mysqlDate
    ]
  );
  await syncProductStats(productId);

  return parseReview({
    id: result.insertId,
    product_id: productId,
    product_slug: product.slug,
    product_name: product.name,
    reviewer_name: userName,
    reviewer_location: reviewerLocation,
    order_number: data.order_number || null,
    rating: Number(data.rating) || 5,
    category_tag: categoryTag,
    is_combo_review: isCombo,
    combo_name: isCombo ? (data.combo_name || 'The Complete Botanical Daily Regimen (Combo Pack)') : null,
    title: title || null,
    body,
    images,
    videos,
    helpful_count: helpfulCount,
    public_story_consent: publicStoryConsent,
    is_approved: isApproved,
    created_at: createdAt,
    updated_at: new Date().toISOString()
  });
};

const getPublicCustomerStories = async () => {
  const [rows] = await pool.query(`
    SELECT r.*, COALESCE(r.reviewer_name, u.name, 'Verified Patron') AS user_name
    FROM reviews r
    LEFT JOIN users u ON r.user_id = u.id
    WHERE r.is_approved = 1
      AND (JSON_LENGTH(r.images) > 0 OR JSON_LENGTH(r.videos) > 0)
    ORDER BY r.created_at DESC
    LIMIT 24
  `);
  return (rows || []).map(row => {
    const review = parseReview(row);
    return { ...review, first_name: String(review.user_name || 'Patron').split(' ')[0] };
  });
};

const getReviewsByProduct = async (productIdOrSlug, approvedOnly = true) => {
  const approvalClause = approvedOnly ? 'AND r.is_approved = 1' : '';
  const [rows] = await pool.query(
    `SELECT r.*, COALESCE(r.reviewer_name, u.name, 'Verified Patron') AS user_name
     FROM reviews r
     LEFT JOIN users u ON r.user_id = u.id
     LEFT JOIN products p ON p.id = r.product_id
     WHERE (r.product_id = ? OR p.slug = ?) ${approvalClause}
     ORDER BY r.created_at DESC`,
    [productIdOrSlug, productIdOrSlug]
  );
  return (rows || []).map(parseReview);
};

const getProductRatingSummary = async (productIdOrSlug) => {
  const reviews = await getReviewsByProduct(productIdOrSlug, true);
  const total = reviews.length;
  if (total === 0) {
    return { total: 0, average: 0, five: 0, four: 0, three: 0, two: 0, one: 0, with_photos: 0, with_videos: 0, categories: {} };
  }
  const sum = reviews.reduce((acc, r) => acc + (Number(r.rating) || 0), 0);
  const average = Number((sum / total).toFixed(2));
  const comboMatches = reviews.filter(r => r.is_combo_review || r.category_tag === 'Combo Pack Ritual');
  const comboAverage = comboMatches.length > 0
    ? Number((comboMatches.reduce((a, r) => a + (Number(r.rating) || 5), 0) / comboMatches.length).toFixed(2))
    : 0;

  const categories = {};
  for (const r of reviews) {
    const c = r.category_tag || 'Quick & Everyday Impressions';
    categories[c] = (categories[c] || 0) + 1;
  }

  return {
    total,
    average,
    combo_total: comboMatches.length,
    combo_average: comboAverage,
    five: reviews.filter(r => Math.round(Number(r.rating)) === 5).length,
    four: reviews.filter(r => Math.round(Number(r.rating)) === 4).length,
    three: reviews.filter(r => Math.round(Number(r.rating)) === 3).length,
    two: reviews.filter(r => Math.round(Number(r.rating)) === 2).length,
    one: reviews.filter(r => Math.round(Number(r.rating)) === 1).length,
    with_photos: reviews.filter(r => Array.isArray(r.images) && r.images.length > 0).length,
    with_videos: reviews.filter(r => Array.isArray(r.videos) && r.videos.length > 0).length,
    categories,
  };
};

const getAllReviews = async (approved = null) => {
  let query = `SELECT r.*, COALESCE(r.reviewer_name, u.name, 'Verified Patron') AS user_name,
      u.email AS user_email, p.name AS product_name, p.slug AS product_slug,
      COALESCE(r.order_number, o.id) AS order_number
    FROM reviews r
    LEFT JOIN users u ON r.user_id = u.id
    LEFT JOIN products p ON r.product_id = p.id
    LEFT JOIN orders o ON r.order_id = o.id`;
  const params = [];
  if (approved !== null) {
    query += ' WHERE r.is_approved = ?';
    params.push(approved);
  }
  query += ' ORDER BY r.created_at DESC';
  const [rows] = await pool.query(query, params);
  return (rows || []).map(parseReview);
};

const updateReviewAsAdmin = async (id, data) => {
  const [rows] = await pool.query(
    `SELECT r.*, p.name AS product_name, p.slug AS product_slug
     FROM reviews r
     LEFT JOIN products p ON p.id = r.product_id
     WHERE r.id = ?`,
    [id]
  );
  if (!rows?.length) return false;
  const existing = parseReview(rows[0]);
  const previousImages = Array.isArray(existing.images) ? existing.images : [];
  let nextProductId = existing.product_id;
  let product = { id: existing.product_id, name: existing.product_name, slug: existing.product_slug };
  if (data.product_slug) {
    const [productRows] = await pool.query('SELECT id, name, slug FROM products WHERE slug = ? LIMIT 1', [data.product_slug]);
    if (!productRows?.length) throw new Error('The selected product does not exist in the database.');
    product = productRows[0];
    nextProductId = product.id;
  } else if (data.product_id !== undefined) {
    const [productRows] = await pool.query('SELECT id, name, slug FROM products WHERE id = ? LIMIT 1', [Number(data.product_id)]);
    if (!productRows?.length) throw new Error('The selected product does not exist in the database.');
    product = productRows[0];
    nextProductId = product.id;
  }
  const nextCategory = data.category_tag !== undefined ? data.category_tag : existing.category_tag;
  const updateFields = {
    rating: data.rating,
    title: data.title,
    body: data.body,
    reviewer_name: data.user_name,
    reviewer_location: data.reviewer_location,
    category_tag: data.category_tag,
    is_combo_review: data.is_combo_review !== undefined
      ? (data.is_combo_review ? 1 : 0)
      : data.category_tag !== undefined
        ? (nextCategory === 'Combo Pack Ritual' ? 1 : 0)
        : undefined,
    is_approved: data.is_approved !== undefined ? (data.is_approved ? 1 : 0) : undefined,
    product_id: data.product_id !== undefined || data.product_slug ? nextProductId : undefined,
    created_at: data.created_at ? new Date(data.created_at).toISOString().slice(0, 19).replace('T', ' ') : undefined,
    images: data.images !== undefined ? JSON.stringify(data.images) : undefined,
    videos: data.videos !== undefined ? JSON.stringify(data.videos) : undefined,
  };
  const fields = [];
  const values = [];
  for (const [field, value] of Object.entries(updateFields)) {
    if (value !== undefined) {
      fields.push(`${field} = ?`);
      values.push(value);
    }
  }
  if (data.is_combo_review !== undefined || data.category_tag !== undefined) {
    updateFields.combo_name = data.is_combo_review || nextCategory === 'Combo Pack Ritual'
      ? (data.combo_name || existing.combo_name || 'The Complete Botanical Daily Regimen (Combo Pack)')
      : null;
    fields.push('combo_name = ?');
    values.push(updateFields.combo_name);
  }
  if (fields.length) {
    values.push(id);
    await pool.query(`UPDATE reviews SET ${fields.join(', ')} WHERE id = ?`, values);
  }

  if (existing.product_id !== nextProductId) {
    await syncProductStats(existing.product_id);
  }
  await syncProductStats(nextProductId);

  const updatedRecord = parseReview({
    ...existing,
    ...data,
    product_id: nextProductId,
    product_name: product?.name || existing.product_name,
    product_slug: product?.slug || existing.product_slug,
    user_name: data.user_name ?? existing.user_name,
    reviewer_name: data.user_name ?? existing.reviewer_name,
    comment: data.body ?? existing.body,
    category_tag: nextCategory,
    is_combo_review: updateFields.is_combo_review ?? existing.is_combo_review,
    combo_name: updateFields.combo_name ?? existing.combo_name,
    updated_at: new Date().toISOString(),
  });
  const retainedImages = Array.isArray(updatedRecord.images) ? updatedRecord.images : [];
  const removedImages = previousImages.filter(
    image => !retainedImages.includes(image) && typeof image === 'string' && image.startsWith('reviews/')
  );
  return { review: updatedRecord, removedImages };
};

const approveReview = async (id) => {
  const [rows] = await pool.query('SELECT product_id FROM reviews WHERE id = ?', [id]);
  if (!rows?.length) return false;
  await pool.query('UPDATE reviews SET is_approved = 1 WHERE id = ?', [id]);
  await syncProductStats(rows[0].product_id);
  return true;
};

const rejectReview = async (id) => {
  const [rows] = await pool.query('SELECT product_id, images FROM reviews WHERE id = ?', [id]);
  if (!rows?.length) return false;
  await pool.query('DELETE FROM reviews WHERE id = ?', [id]);
  await syncProductStats(rows[0].product_id);
  return parseJsonArray(rows[0].images).filter(image => typeof image === 'string' && image.startsWith('reviews/'));
};

const getUserReviews = async (userId) => {
  const [rows] = await pool.query(
    `SELECT r.*, p.name AS product_name FROM reviews r
    LEFT JOIN products p ON r.product_id = p.id
    WHERE r.user_id = ? ORDER BY r.created_at DESC`,
    [userId]
  );
  return (rows || []).map(parseReview);
};

module.exports = { 
  createReviewTable, 
  seedAllCustomerReviews,
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
