const fs = require('fs');
const path = require('path');
let pool;
try {
  pool = require('../config/db');
} catch (_) {
  pool = { query: async () => [[]] };
}
const { LUXURY_CATALOG } = require('../data/luxuryCatalog');
const { INITIAL_REVIEWS_SEED } = require('../data/bhumiveraReviewsData');

const PRODUCT_SLUGS = {
  1: 'activated-charcoal-luxury-face-wash',
  2: 'himalayan-seabuckthorn-luxury-face-wash',
  3: 'luxury-2-in-1-botanical-shampoo-conditioner',
  4: 'artisanal-charcoal-handmade-soap',
  5: 'artisanal-aloe-vera-handmade-soap',
  6: 'kalpvriksh-satva-tulsi-7-tulsi-extract',
  10: 'activated-charcoal-luxury-face-wash',
  11: 'himalayan-seabuckthorn-luxury-face-wash',
  12: 'luxury-2-in-1-botanical-shampoo-conditioner',
  13: 'artisanal-charcoal-handmade-soap',
  14: 'artisanal-aloe-vera-handmade-soap',
  15: 'kalpvriksh-satva-tulsi-7-tulsi-extract',
};

const PRODUCT_NAMES = {
  1: 'Bhumivera Activated Charcoal Purifying Luxury Face Wash',
  2: 'Bhumivera Himalayan Sea Buckthorn Cellular Radiance Face Wash',
  3: 'Bhumivera Royal Botanical 2-in-1 Luxury Shampoo with Conditioner',
  4: 'Bhumivera Charcoal Deep Cleansing Bar (Handmade Ayurvedic Luxury Soap)',
  5: 'Bhumivera Soothing Bar (Aloe Vera, Neem & Tulsi Handmade Ayurvedic Soap)',
  6: 'Bhumivera Kalpvriksh Satva Tulsi (Liquid Extract of 7 Types of Tulsi)',
  10: 'Bhumivera Activated Charcoal Purifying Luxury Face Wash',
  11: 'Bhumivera Himalayan Sea Buckthorn Cellular Radiance Face Wash',
  12: 'Bhumivera Royal Botanical 2-in-1 Luxury Shampoo with Conditioner',
  13: 'Bhumivera Charcoal Deep Cleansing Bar (Handmade Ayurvedic Luxury Soap)',
  14: 'Bhumivera Soothing Bar (Aloe Vera, Neem & Tulsi Handmade Ayurvedic Soap)',
  15: 'Bhumivera Kalpvriksh Satva Tulsi (Liquid Extract of 7 Types of Tulsi)',
};

const STORE_FILE_PATH = path.join(__dirname, '../data/reviewsDatabaseStore.json');

function loadPersistedStore() {
  try {
    if (fs.existsSync(STORE_FILE_PATH)) {
      const raw = fs.readFileSync(STORE_FILE_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length >= 1000) return parsed;
    }
  } catch (err) {
    console.warn('[REVIEWS_STORE_LOAD_WARN]', err.message);
  }
  return (INITIAL_REVIEWS_SEED || []).map(r => ({ ...r }));
}

function savePersistedStore(reviews) {
  try {
    fs.writeFileSync(STORE_FILE_PATH, JSON.stringify(reviews, null, 2), 'utf8');
  } catch (err) {
    console.warn('[REVIEWS_STORE_SAVE_WARN]', err.message);
  }
}

let memoryReviewsStore = loadPersistedStore();

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
  const pid = Number(review.product_id) || 10;
  const prodSlug = review.product_slug || PRODUCT_SLUGS[pid] || '';
  const prodName = review.product_name || PRODUCT_NAMES[pid] || 'Bhumivera Product';
  return {
    ...review,
    product_id: pid,
    product_slug: prodSlug,
    product_name: prodName,
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

const createReviewTable = async (customPool = null) => {
  const db = customPool || pool;
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
    ['product_slug', 'VARCHAR(255) DEFAULT NULL'],
    ['product_name', 'VARCHAR(255) DEFAULT NULL'],
  ];

  for (const [col, def] of extraCols) {
    try {
      const [exists] = await db.query(`SHOW COLUMNS FROM reviews LIKE '${col}'`);
      if (!exists.length) {
        await db.query(`ALTER TABLE reviews ADD COLUMN ${col} ${def}`);
      }
    } catch (_) {}
  }
};

const syncProductStats = async (productId, customPool = null) => {
  const db = customPool || pool;
  try {
    await db.query(`
      UPDATE products p
      SET rating = (SELECT IFNULL(ROUND(AVG(rating), 2), 4.6) FROM reviews WHERE product_id = p.id AND is_approved = 1),
          review_count = (SELECT COUNT(*) FROM reviews WHERE product_id = p.id AND is_approved = 1)
      WHERE p.id = ?
    `, [productId]);
  } catch (_) {}
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

  const newId = Math.max(3000, ...memoryReviewsStore.map(r => Number(r.id) || 0)) + 1;
  const prod = LUXURY_CATALOG.find(p => Number(p.id) === Number(product_id)) || {};
  const nowIso = data.created_at ? new Date(data.created_at).toISOString() : new Date().toISOString();

  const newRecord = {
    id: newId,
    product_id: Number(product_id),
    product_slug: prod.slug || '',
    product_name: prod.name || `Product #${product_id}`,
    user_id: Number(user_id) || 5000 + newId,
    user_name,
    reviewer_name: user_name,
    reviewer_location,
    order_id: order_id || (80000 + newId),
    order_number: `BV-${nowIso.slice(0, 4)}-${80000 + newId}`,
    rating: Number(rating),
    category_tag,
    is_combo_review: category_tag === 'Combo Pack Ritual',
    title: title || null,
    body: body || null,
    comment: body || null,
    images: Array.isArray(images) ? images : [],
    videos: Array.isArray(videos) ? videos : [],
    helpful_count: 1,
    public_story_consent: public_story_consent && (images.length > 0 || videos.length > 0) ? 1 : 0,
    is_approved: 1,
    verified_purchase: true,
    status: 'approved',
    created_at: nowIso,
    updated_at: nowIso
  };

  memoryReviewsStore.unshift(newRecord);
  savePersistedStore(memoryReviewsStore);

  try {
    const [result] = await pool.query(
      'INSERT INTO reviews (product_id, user_id, order_id, reviewer_name, reviewer_location, category_tag, rating, title, body, images, videos, public_story_consent, is_approved) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
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
        public_story_consent && (images.length > 0 || videos.length > 0) ? 1 : 0
      ]
    );
    await syncProductStats(product_id);
    if (result?.insertId) return result.insertId;
  } catch (_) {}

  return newId;
};

const createReviewAsAdmin = async (data) => {
  const newId = Math.max(3000, ...memoryReviewsStore.map(r => Number(r.id) || 0)) + 1;
  const productId = Number(data.product_id) || 10;
  const prodSlug = data.product_slug || PRODUCT_SLUGS[productId] || '';
  const prod = LUXURY_CATALOG.find(p => Number(p.id) === productId || p.slug === prodSlug) || {};
  const prodName = data.product_name || PRODUCT_NAMES[productId] || prod.name || `Product #${productId}`;
  const createdAt = data.created_at ? new Date(data.created_at).toISOString() : new Date().toISOString();
  const categoryTag = data.category_tag || (Number(data.rating) === 1 ? 'Shipping & Packaging Feedback' : 'Quick & Everyday Impressions');
  const isCombo = Boolean(data.is_combo_review || categoryTag === 'Combo Pack Ritual');

  const newReview = {
    id: newId,
    product_id: productId,
    product_slug: prodSlug || prod.slug || '',
    product_name: prodName,
    user_id: 5000 + newId,
    user_name: (data.user_name || data.reviewer_name || 'Verified Patron').trim(),
    reviewer_name: (data.user_name || data.reviewer_name || 'Verified Patron').trim(),
    reviewer_location: (data.reviewer_location || 'India').trim(),
    user_email: data.user_email || `patron.${newId}@bhumivera.com`,
    order_id: data.order_id || (90000 + newId),
    order_number: data.order_number || `BV-${createdAt.slice(0, 4)}-${90000 + newId}`,
    rating: Number(data.rating) || 5,
    category_tag: categoryTag,
    is_combo_review: isCombo,
    combo_name: isCombo ? (data.combo_name || 'The Complete Botanical Daily Regimen (Combo Pack)') : null,
    title: (data.title || '').trim(),
    body: (data.body || data.comment || '').trim(),
    comment: (data.body || data.comment || '').trim(),
    images: Array.isArray(data.images) ? data.images : [],
    videos: Array.isArray(data.videos) ? data.videos : [],
    helpful_count: Number(data.helpful_count) || 8,
    public_story_consent: (Array.isArray(data.images) && data.images.length > 0) || (Array.isArray(data.videos) && data.videos.length > 0) ? 1 : 0,
    is_approved: data.is_approved !== undefined ? (data.is_approved ? 1 : 0) : 1,
    verified_purchase: data.verified_purchase !== false,
    status: data.is_approved === 0 || data.is_approved === false ? 'pending' : 'approved',
    created_at: createdAt,
    updated_at: new Date().toISOString()
  };

  memoryReviewsStore.unshift(newReview);
  savePersistedStore(memoryReviewsStore);

  try {
    const mysqlDate = createdAt.slice(0, 19).replace('T', ' ');
    await pool.query(
      `INSERT INTO reviews
        (id, product_id, product_slug, product_name, reviewer_name, reviewer_location, category_tag, is_combo_review, combo_name,
         order_number, rating, title, body, images, videos, helpful_count, public_story_consent, is_approved, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newReview.id,
        newReview.product_id,
        newReview.product_slug,
        newReview.product_name,
        newReview.reviewer_name,
        newReview.reviewer_location,
        newReview.category_tag,
        newReview.is_combo_review ? 1 : 0,
        newReview.combo_name,
        newReview.order_number,
        newReview.rating,
        newReview.title,
        newReview.body,
        JSON.stringify(newReview.images),
        JSON.stringify(newReview.videos),
        newReview.helpful_count,
        newReview.public_story_consent,
        newReview.is_approved,
        mysqlDate
      ]
    );
    await syncProductStats(newReview.product_id);
  } catch (_) {}

  return newReview;
};

const getPublicCustomerStories = async () => {
  return memoryReviewsStore
    .filter(r => Number(r.is_approved) === 1 && ((Array.isArray(r.images) && r.images.length > 0) || (Array.isArray(r.videos) && r.videos.length > 0)))
    .slice(0, 24)
    .map(r => ({
      ...parseReview(r),
      first_name: String(r.user_name || 'Patron').split(' ')[0]
    }));
};

const getReviewsByProduct = async (productIdOrSlug, approvedOnly = true) => {
  let dbRows = [];
  try {
    const whereClause = approvedOnly ? 'AND r.is_approved = 1' : '';
    let resolvedSlug = '';
    let resolvedId = null;

    if (typeof productIdOrSlug === 'string' && !/^\d+$/.test(productIdOrSlug)) {
      resolvedSlug = productIdOrSlug;
    } else {
      const num = Number(productIdOrSlug);
      resolvedId = num;
      resolvedSlug = PRODUCT_SLUGS[num] || '';
    }

    const [rows] = await pool.query(
      `SELECT r.*,
              COALESCE(r.product_slug, p.slug) AS product_slug,
              COALESCE(r.product_name, p.name) AS product_name,
              COALESCE(r.reviewer_name, u.name, 'Verified Patron') AS user_name
       FROM reviews r
       LEFT JOIN users u ON r.user_id = u.id
       LEFT JOIN products p ON r.product_id = p.id
       WHERE (r.product_id = ? OR r.product_slug = ? OR p.slug = ?) ${whereClause}
       ORDER BY r.created_at DESC`,
      [resolvedId || -1, resolvedSlug || '', resolvedSlug || '']
    );
    dbRows = (rows || []).map(parseReview);
  } catch (_) {}

  const memRows = memoryReviewsStore
    .filter(r =>
      (String(r.product_id) === String(productIdOrSlug) ||
       String(r.product_slug) === String(productIdOrSlug) ||
       PRODUCT_SLUGS[r.product_id] === String(productIdOrSlug)) &&
      (!approvedOnly || Number(r.is_approved) === 1)
    )
    .map(parseReview);

  const combined = [...dbRows, ...memRows];
  const seenIds = new Set();
  return combined.filter(r => {
    if (seenIds.has(String(r.id))) return false;
    seenIds.add(String(r.id));
    return true;
  }).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
};

const getReviewsByComboName = async comboName => {
  const [rows] = await pool.query(
    `SELECT r.*, COALESCE(r.reviewer_name, u.name, 'Verified Patron') as user_name,
            p.name as product_name
     FROM reviews r
     LEFT JOIN users u ON r.user_id = u.id
     LEFT JOIN products p ON r.product_id = p.id
     WHERE r.combo_name = ? AND r.is_approved = 1
     ORDER BY r.created_at DESC`,
    [comboName]
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
    : 4.88;

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
  let dbRows = [];
  try {
    let query = `SELECT r.*,
      COALESCE(r.product_slug, p.slug) AS product_slug,
      COALESCE(r.product_name, p.name) AS product_name,
      COALESCE(r.reviewer_name, u.name, 'Verified Patron') AS user_name,
      u.email AS user_email,
      COALESCE(r.order_number, o.id) AS order_number
      FROM reviews r
      LEFT JOIN users u ON r.user_id = u.id
      LEFT JOIN products p ON r.product_id = p.id
      LEFT JOIN orders o ON r.order_id = o.id`;
    const params = [];
    if (approved !== null) { query += ' WHERE r.is_approved = ?'; params.push(approved); }
    query += ' ORDER BY r.created_at DESC';
    const [rows] = await pool.query(query, params);
    dbRows = (rows || []).map(parseReview);
  } catch (_) {}

  const memRows = memoryReviewsStore
    .filter(r => approved === null || Number(r.is_approved) === Number(approved))
    .map(parseReview);

  const combined = [...dbRows, ...memRows];
  const seenIds = new Set();
  return combined.filter(r => {
    if (seenIds.has(String(r.id))) return false;
    seenIds.add(String(r.id));
    return true;
  }).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
};

const updateReviewAsAdmin = async (id, data) => {
  const memIdx = memoryReviewsStore.findIndex(r => String(r.id) === String(id));
  let updatedRecord = null;
  let removedImages = [];

  const nextProductId = data.product_id !== undefined ? Number(data.product_id) : undefined;
  const prodSlug = nextProductId ? (PRODUCT_SLUGS[nextProductId] || '') : undefined;
  const prodName = nextProductId ? (PRODUCT_NAMES[nextProductId] || '') : undefined;

  if (memIdx !== -1) {
    const existing = memoryReviewsStore[memIdx];
    const previousImages = Array.isArray(existing.images) ? existing.images : [];
    const targetProdId = nextProductId !== undefined ? nextProductId : existing.product_id;
    const nextCat = data.category_tag !== undefined ? data.category_tag : existing.category_tag;
    updatedRecord = {
      ...existing,
      ...(data.rating !== undefined ? { rating: Number(data.rating) } : {}),
      ...(data.title !== undefined ? { title: data.title } : {}),
      ...(data.body !== undefined ? { body: data.body, comment: data.body } : {}),
      ...(data.user_name !== undefined ? { user_name: data.user_name, reviewer_name: data.user_name } : {}),
      ...(data.reviewer_location !== undefined ? { reviewer_location: data.reviewer_location } : {}),
      ...(data.category_tag !== undefined ? {
        category_tag: nextCat,
        is_combo_review: Boolean(data.is_combo_review ?? (nextCat === 'Combo Pack Ritual'))
      } : {}),
      ...(data.is_combo_review !== undefined ? { is_combo_review: Boolean(data.is_combo_review) } : {}),
      ...(data.created_at !== undefined ? { created_at: new Date(data.created_at).toISOString() } : {}),
      ...(nextProductId !== undefined ? {
        product_id: targetProdId,
        product_name: prodName || existing.product_name,
        product_slug: prodSlug || existing.product_slug
      } : {}),
      ...(data.images !== undefined ? { images: data.images } : {}),
      ...(data.videos !== undefined ? { videos: data.videos } : {}),
      ...(data.is_approved !== undefined ? {
        is_approved: data.is_approved ? 1 : 0,
        status: data.is_approved ? 'approved' : 'pending'
      } : {}),
      updated_at: new Date().toISOString()
    };
    memoryReviewsStore[memIdx] = updatedRecord;
    savePersistedStore(memoryReviewsStore);
    const retained = Array.isArray(updatedRecord.images) ? updatedRecord.images : [];
    removedImages = previousImages.filter(image => !retained.includes(image) && typeof image === 'string' && image.startsWith('reviews/'));
  }

  try {
    const fields = [];
    const values = [];
    const mapFields = {
      rating: data.rating,
      title: data.title,
      body: data.body,
      reviewer_name: data.user_name,
      reviewer_location: data.reviewer_location,
      category_tag: data.category_tag,
      is_approved: data.is_approved !== undefined ? (data.is_approved ? 1 : 0) : undefined,
      product_id: nextProductId,
      product_slug: prodSlug,
      product_name: prodName,
      created_at: data.created_at ? new Date(data.created_at).toISOString().slice(0, 19).replace('T', ' ') : undefined,
    };
    for (const [k, v] of Object.entries(mapFields)) {
      if (v !== undefined) {
        fields.push(`${k} = ?`);
        values.push(v);
      }
    }
    if (data.images !== undefined) {
      fields.push('images = ?');
      values.push(JSON.stringify(data.images));
    }
    if (data.videos !== undefined) {
      fields.push('videos = ?');
      values.push(JSON.stringify(data.videos));
    }
    if (fields.length) {
      values.push(id);
      await pool.query(`UPDATE reviews SET ${fields.join(', ')} WHERE id = ?`, values);
    }
    if (updatedRecord?.product_id) await syncProductStats(updatedRecord.product_id);
    else if (nextProductId) await syncProductStats(nextProductId);
  } catch (_) {}

  if (!updatedRecord) {
    try {
      const [rows] = await pool.query('SELECT * FROM reviews WHERE id = ?', [id]);
      if (rows?.[0]) updatedRecord = parseReview(rows[0]);
    } catch (_) {}
  }

  if (!updatedRecord) return false;
  return { review: updatedRecord, removedImages };
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
    savePersistedStore(memoryReviewsStore);
  }
  try {
    await pool.query('UPDATE reviews SET is_approved = 1 WHERE id = ?', [id]);
  } catch (_) {}
  return true;
};

const archiveReview = async (id) => {
  const [rows] = await pool.query('SELECT id, product_id FROM reviews WHERE id = ?', [id]);
  if (!rows?.[0]) return false;

  await pool.query('UPDATE reviews SET is_approved = 0 WHERE id = ?', [id]);
  const memIdx = memoryReviewsStore.findIndex(r => String(r.id) === String(id));
  if (memIdx !== -1) {
    memoryReviewsStore[memIdx] = {
      ...memoryReviewsStore[memIdx],
      is_approved: 0,
      status: 'pending',
      updated_at: new Date().toISOString(),
    };
    savePersistedStore(memoryReviewsStore);
  }
  await syncProductStats(rows[0].product_id);
  return true;
};

const getUserReviews = async (userId) => {
  try {
    const [rows] = await pool.query(
      `SELECT r.*, p.name as product_name FROM reviews r
      LEFT JOIN products p ON r.product_id = p.id
      WHERE r.user_id = ? ORDER BY r.created_at DESC`,
      [userId]
    );
    if (rows?.length) return rows.map(parseReview);
  } catch (_) {}
  return memoryReviewsStore.filter(r => Number(r.user_id) === Number(userId)).map(parseReview);
};

const deleteReviewPermanently = async (id) => {
  let targetProductId = null;
  try {
    const [rows] = await pool.query('SELECT id, product_id FROM reviews WHERE id = ?', [id]);
    if (rows?.[0]) {
      targetProductId = rows[0].product_id;
    }
    await pool.query('DELETE FROM reviews WHERE id = ?', [id]);
  } catch (_) {}

  const memIdx = memoryReviewsStore.findIndex(r => String(r.id) === String(id));
  if (memIdx !== -1) {
    if (!targetProductId) targetProductId = memoryReviewsStore[memIdx].product_id;
    memoryReviewsStore.splice(memIdx, 1);
    savePersistedStore(memoryReviewsStore);
  }

  if (targetProductId) {
    await syncProductStats(targetProductId);
  }
  return true;
};

const seed1080AuthenticReviews = async (customPool = null) => {
  const db = customPool || pool;
  await createReviewTable(db);

  // Map product slugs to actual DB product IDs
  const productSlugToDbId = new Map();
  try {
    const [pRows] = await db.query('SELECT id, slug FROM products');
    for (const row of (pRows || [])) {
      if (row.slug) productSlugToDbId.set(row.slug, row.id);
    }
  } catch (_) {}

  // Delete legacy/dummy bot reviews
  try {
    await db.query("DELETE FROM reviews WHERE order_number LIKE 'BV-ORD-%' OR id <= 2500");
  } catch (_) {}

  // Find a default user_id if users table exists
  let defaultUserId = null;
  try {
    const [uRows] = await db.query('SELECT id FROM users ORDER BY id LIMIT 1');
    if (uRows?.[0]?.id) defaultUserId = uRows[0].id;
  } catch (_) {}

  // Insert all 1,080 reviews
  const BATCH_SIZE = 100;
  for (let i = 0; i < INITIAL_REVIEWS_SEED.length; i += BATCH_SIZE) {
    const batch = INITIAL_REVIEWS_SEED.slice(i, i + BATCH_SIZE);
    const valuePlaceholders = batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
    const params = [];

    for (const r of batch) {
      const targetProdId = productSlugToDbId.get(r.product_slug) || r.product_id;
      const targetProdName = r.product_name || PRODUCT_NAMES[targetProdId] || 'Bhumivera Product';
      const mysqlDate = new Date(r.created_at).toISOString().slice(0, 19).replace('T', ' ');
      params.push(
        r.id,
        targetProdId,
        r.product_slug,
        targetProdName,
        defaultUserId,
        null, // order_id
        r.order_number,
        r.reviewer_name || r.user_name || 'Verified Patron',
        r.reviewer_location || 'India',
        r.category_tag || 'Quick & Everyday Impressions',
        r.is_combo_review ? 1 : 0,
        r.combo_name || null,
        r.rating,
        r.title || '',
        r.body || r.comment || '',
        JSON.stringify(r.images || []),
        JSON.stringify(r.videos || []),
        r.helpful_count || 5,
        r.public_story_consent ? 1 : 0,
        1, // is_approved
        mysqlDate
      );
    }

    await db.query(
      `INSERT INTO reviews
        (id, product_id, product_slug, product_name, user_id, order_id, order_number, reviewer_name, reviewer_location,
         category_tag, is_combo_review, combo_name, rating, title, body, images, videos,
         helpful_count, public_story_consent, is_approved, created_at)
       VALUES ${valuePlaceholders}
       ON DUPLICATE KEY UPDATE
         product_id = VALUES(product_id),
         product_slug = VALUES(product_slug),
         product_name = VALUES(product_name),
         reviewer_name = VALUES(reviewer_name),
         reviewer_location = VALUES(reviewer_location),
         category_tag = VALUES(category_tag),
         is_combo_review = VALUES(is_combo_review),
         combo_name = VALUES(combo_name),
         rating = VALUES(rating),
         title = VALUES(title),
         body = VALUES(body),
         images = VALUES(images),
         videos = VALUES(videos),
         helpful_count = VALUES(helpful_count),
         is_approved = VALUES(is_approved),
         created_at = VALUES(created_at)`,
      params
    );
  }

  // Update memoryReviewsStore
  memoryReviewsStore = INITIAL_REVIEWS_SEED.map(r => {
    const targetProdId = productSlugToDbId.get(r.product_slug) || r.product_id;
    return {
      ...r,
      product_id: targetProdId,
      product_name: r.product_name || PRODUCT_NAMES[targetProdId] || 'Bhumivera Product'
    };
  });
  savePersistedStore(memoryReviewsStore);

  // Sync stats for all products
  const productIdsToSync = productSlugToDbId.size > 0
    ? [...new Set([...productSlugToDbId.values(), 1, 2, 3, 4, 5, 6])]
    : [1, 2, 3, 4, 5, 6, 10, 11, 12, 13, 14, 15];

  for (const pid of productIdsToSync) {
    await syncProductStats(pid, db);
  }

  return INITIAL_REVIEWS_SEED.length;
};

module.exports = {
  createReviewTable,
  createReview,
  createReviewAsAdmin,
  getReviewsByProduct,
  getReviewsByComboName,
  getPublicCustomerStories,
  getProductRatingSummary,
  getAllReviews,
  approveReview,
  archiveReview,
  deleteReviewPermanently,
  getUserReviews,
  updateReviewAsAdmin,
  syncProductStats,
  seed1080AuthenticReviews,
  PRODUCT_SLUGS,
  PRODUCT_NAMES,
};
