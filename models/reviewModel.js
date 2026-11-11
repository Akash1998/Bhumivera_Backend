let pool;
try {
  pool = require('../config/db');
} catch (_) {
  pool = { query: async () => [[]] };
}
const { LUXURY_CATALOG, MAISON_REGIMEN_BUNDLES } = require('../data/luxuryCatalog');

const PRODUCT_SLUGS = {
  1: 'activated-charcoal-luxury-face-wash',
  2: 'himalayan-seabuckthorn-luxury-face-wash',
  3: 'luxury-2-in-1-botanical-shampoo-conditioner',
  4: 'artisanal-charcoal-handmade-soap',
  5: 'artisanal-aloe-vera-handmade-soap',
  6: 'kalpvriksh-satva-tulsi-7-tulsi-extract',
  7: 'bundle-daily-regimen',
  8: 'bundle-inside-out-ritual',
  9: 'bundle-grand-maison-vault',
  10: 'activated-charcoal-luxury-face-wash',
  11: 'himalayan-seabuckthorn-luxury-face-wash',
  12: 'luxury-2-in-1-botanical-shampoo-conditioner',
  13: 'artisanal-charcoal-handmade-soap',
  14: 'artisanal-aloe-vera-handmade-soap',
  15: 'kalpvriksh-satva-tulsi-7-tulsi-extract',
  16: 'bundle-daily-regimen',
  17: 'bundle-inside-out-ritual',
  18: 'bundle-grand-maison-vault',
};

const PRODUCT_NAMES = {
  1: 'Bhumivera Activated Charcoal Purifying Luxury Face Wash',
  2: 'Bhumivera Himalayan Sea Buckthorn Cellular Radiance Face Wash',
  3: 'Bhumivera Royal Botanical 2-in-1 Luxury Shampoo with Conditioner',
  4: 'Bhumivera Charcoal Deep Cleansing Bar (Handmade Ayurvedic Luxury Soap)',
  5: 'Bhumivera Soothing Bar (Aloe Vera, Neem & Tulsi Handmade Ayurvedic Soap)',
  6: 'Bhumivera Kalpvriksh Satva Tulsi (Liquid Extract of 7 Types of Tulsi)',
  7: 'The Complete Botanical Daily Regimen',
  8: 'The Inside-Out Skin-Clearing & Cortisol Ritual',
  9: 'The Grand Maison 6-Piece Apothecary Vault',
  10: 'Bhumivera Activated Charcoal Purifying Luxury Face Wash',
  11: 'Bhumivera Himalayan Sea Buckthorn Cellular Radiance Face Wash',
  12: 'Bhumivera Royal Botanical 2-in-1 Luxury Shampoo with Conditioner',
  13: 'Bhumivera Charcoal Deep Cleansing Bar (Handmade Ayurvedic Luxury Soap)',
  14: 'Bhumivera Soothing Bar (Aloe Vera, Neem & Tulsi Handmade Ayurvedic Soap)',
  15: 'Bhumivera Kalpvriksh Satva Tulsi (Liquid Extract of 7 Types of Tulsi)',
  16: 'The Complete Botanical Daily Regimen',
  17: 'The Inside-Out Skin-Clearing & Cortisol Ritual',
  18: 'The Grand Maison 6-Piece Apothecary Vault',
};

const COMBO_BY_KEY = {
  'bundle-daily-regimen': {
    id: 'bundle-daily-regimen',
    sku: 'BV-BND-DAILY-01',
    name: 'The Complete Botanical Daily Regimen',
  },
  'BV-BND-DAILY-01': {
    id: 'bundle-daily-regimen',
    sku: 'BV-BND-DAILY-01',
    name: 'The Complete Botanical Daily Regimen',
  },
  'The Complete Botanical Daily Regimen': {
    id: 'bundle-daily-regimen',
    sku: 'BV-BND-DAILY-01',
    name: 'The Complete Botanical Daily Regimen',
  },
  'bundle-royal-crown-trio': {
    id: 'bundle-royal-crown-trio',
    sku: 'BV-BND-ROYAL-03',
    name: 'The Royal Skin & Scalp Stewardship Trio',
  },
  'BV-BND-ROYAL-03': {
    id: 'bundle-royal-crown-trio',
    sku: 'BV-BND-ROYAL-03',
    name: 'The Royal Skin & Scalp Stewardship Trio',
  },
  'The Royal Skin & Scalp Stewardship Trio': {
    id: 'bundle-royal-crown-trio',
    sku: 'BV-BND-ROYAL-03',
    name: 'The Royal Skin & Scalp Stewardship Trio',
  },
  'bundle-inside-out-ritual': {
    id: 'bundle-inside-out-ritual',
    sku: 'BV-BND-INSIDEOUT-02',
    name: 'The Inside-Out Skin-Clearing & Cortisol Ritual',
  },
  'BV-BND-INSIDEOUT-02': {
    id: 'bundle-inside-out-ritual',
    sku: 'BV-BND-INSIDEOUT-02',
    name: 'The Inside-Out Skin-Clearing & Cortisol Ritual',
  },
  'The Inside-Out Skin-Clearing & Cortisol Ritual': {
    id: 'bundle-inside-out-ritual',
    sku: 'BV-BND-INSIDEOUT-02',
    name: 'The Inside-Out Skin-Clearing & Cortisol Ritual',
  },
  'bundle-grand-maison-vault': {
    id: 'bundle-grand-maison-vault',
    sku: 'BV-BND-VAULT-06',
    name: 'The Grand Maison 6-Piece Apothecary Vault',
  },
  'BV-BND-VAULT-06': {
    id: 'bundle-grand-maison-vault',
    sku: 'BV-BND-VAULT-06',
    name: 'The Grand Maison 6-Piece Apothecary Vault',
  },
  'The Grand Maison 6-Piece Apothecary Vault': {
    id: 'bundle-grand-maison-vault',
    sku: 'BV-BND-VAULT-06',
    name: 'The Grand Maison 6-Piece Apothecary Vault',
  },
};

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
  const name = review.reviewer_name || review.user_name || '';
  const pid = Number(review.product_id) || null;
  return {
    ...review,
    product_id: pid,
    product_slug: review.product_slug || '',
    product_name: review.product_name || '',
    user_name: name,
    reviewer_name: name,
    reviewer_location: review.reviewer_location || '',
    category_tag: review.category_tag || '',
    is_combo_review: Boolean(review.is_combo_review || review.combo_name || review.category_tag === 'Combo Pack Ritual'),
    combo_name: review.combo_name || null,
    combo_slug: review.combo_slug || null,
    combo_sku: review.combo_sku || null,
    body: review.body || review.comment || '',
    comment: review.comment || review.body || '',
    images,
    videos,
    helpful_count: Number(review.helpful_count) || 0,
    is_approved: Number(review.is_approved ?? 0),
    status: Number(review.is_approved ?? 0) === 1 ? 'approved' : 'pending'
  };
};

const createReviewTable = async (customPool = null) => {
  const db = customPool || pool;
  await db.query(`
    CREATE TABLE IF NOT EXISTS reviews (
      id INT AUTO_INCREMENT PRIMARY KEY,
      product_id INT NOT NULL,
      product_slug VARCHAR(255) DEFAULT NULL,
      product_name VARCHAR(255) DEFAULT NULL,
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
      SET rating = (SELECT IFNULL(ROUND(AVG(rating), 2), 0) FROM reviews WHERE (product_id = p.id OR product_slug = p.slug OR combo_name = p.name) AND is_approved = 1),
          review_count = (SELECT COUNT(*) FROM reviews WHERE (product_id = p.id OR product_slug = p.slug OR combo_name = p.name) AND is_approved = 1)
      WHERE p.id = ?
    `, [productId]);
  } catch (error) {
    console.error('[REVIEW_PRODUCT_STATS_SYNC]', error);
  }
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
    combo_name = null,
    public_story_consent = false
  } = data;

  const newId = Date.now() % 1000000;
  const prod = LUXURY_CATALOG.find(p => Number(p.id) === Number(product_id)) || {};
  const nowIso = data.created_at ? new Date(data.created_at).toISOString() : new Date().toISOString();
  const comboMatch = combo_name ? COMBO_BY_KEY[combo_name] : null;
  const isCombo = Boolean(data.is_combo_review || comboMatch || category_tag === 'Combo Pack Ritual');

  const newRecord = {
    id: newId,
    product_id: Number(product_id) || 1,
    product_slug: prod.slug || PRODUCT_SLUGS[Number(product_id)] || '',
    product_name: prod.name || PRODUCT_NAMES[Number(product_id)] || `Product #${product_id}`,
    user_id: Number(user_id) || 5000 + newId,
    user_name,
    reviewer_name: user_name,
    reviewer_location,
    order_id: order_id || (80000 + newId),
    order_number: data.order_number || `BV-${nowIso.slice(0, 4)}-${80000 + newId}`,
    rating: Number(rating),
    category_tag,
    is_combo_review: isCombo,
    combo_name: isCombo ? (comboMatch?.name || combo_name || 'The Complete Botanical Daily Regimen') : null,
    combo_slug: isCombo ? (comboMatch?.id || null) : null,
    combo_sku: isCombo ? (comboMatch?.sku || null) : null,
    title: title || null,
    body: body || null,
    comment: body || null,
    images: Array.isArray(images) ? images : [],
    videos: Array.isArray(videos) ? videos : [],
    helpful_count: Number(data.helpful_count) || 1,
    public_story_consent: public_story_consent && (images.length > 0 || videos.length > 0) ? 1 : 0,
    is_approved: 1,
    verified_purchase: true,
    status: 'approved',
    created_at: nowIso,
    updated_at: nowIso
  };

  try {
    const [result] = await pool.query(
      'INSERT INTO reviews (product_id, product_slug, product_name, user_id, order_id, order_number, reviewer_name, reviewer_location, category_tag, is_combo_review, combo_name, rating, title, body, images, videos, public_story_consent, is_approved) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
      [
        newRecord.product_id,
        newRecord.product_slug,
        newRecord.product_name,
        user_id || null,
        order_id || null,
        newRecord.order_number,
        user_name,
        reviewer_location,
        category_tag,
        newRecord.is_combo_review ? 1 : 0,
        newRecord.combo_name,
        rating,
        title || null,
        body || null,
        JSON.stringify(images),
        JSON.stringify(videos),
        public_story_consent && (images.length > 0 || videos.length > 0) ? 1 : 0
      ]
    );
    await syncProductStats(product_id);
    return result.insertId;
  } catch (err) {
    console.error('[REVIEW_CREATE_FAILED]', err.message);
    throw err;
  }
};

const createReviewAsAdmin = async (data) => {
  const productId = Number(data.product_id);
  if (!Number.isSafeInteger(productId) || productId <= 0) {
    throw new Error('A valid catalog product is required.');
  }
  const [products] = await pool.query(
    'SELECT id, name, slug FROM products WHERE id = ? LIMIT 1',
    [productId]
  );
  const product = products?.[0];
  if (!product) throw new Error('The selected product was not found in the catalog.');
  const createdAt = data.created_at ? new Date(data.created_at).toISOString() : new Date().toISOString();
  const categoryTag = data.category_tag || null;
  const isCombo = Boolean(data.is_combo_review || data.combo_name);
  const resolvedComboName = isCombo ? (data.combo_name || null) : null;

  const newReview = {
    product_id: productId,
    product_slug: product.slug || '',
    product_name: product.name,
    user_name: String(data.user_name || data.reviewer_name || '').trim(),
    reviewer_name: String(data.user_name || data.reviewer_name || '').trim(),
    reviewer_location: String(data.reviewer_location || '').trim(),
    order_number: data.order_number || null,
    rating: Number(data.rating),
    category_tag: categoryTag,
    is_combo_review: isCombo,
    combo_name: resolvedComboName,
    combo_slug: isCombo ? (data.combo_slug || null) : null,
    combo_sku: isCombo ? (data.combo_sku || null) : null,
    title: (data.title || '').trim(),
    body: (data.body || data.comment || '').trim(),
    comment: (data.body || data.comment || '').trim(),
    images: Array.isArray(data.images) ? data.images : [],
    videos: Array.isArray(data.videos) ? data.videos : [],
    helpful_count: data.helpful_count !== undefined ? Number(data.helpful_count) : 0,
    public_story_consent: (Array.isArray(data.images) && data.images.length > 0) || (Array.isArray(data.videos) && data.videos.length > 0) ? 1 : 0,
    is_approved: data.is_approved ? 1 : 0,
    verified_purchase: data.verified_purchase === true,
    status: data.is_approved === 0 || data.is_approved === false ? 'pending' : 'approved',
    created_at: createdAt,
    updated_at: new Date().toISOString()
  };

  try {
    const mysqlDate = createdAt.slice(0, 19).replace('T', ' ');
    const [result] = await pool.query(
      `INSERT INTO reviews
        (product_id, product_slug, product_name, reviewer_name, reviewer_location, category_tag, is_combo_review, combo_name,
         order_number, rating, title, body, images, videos, helpful_count, public_story_consent, is_approved, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
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
    newReview.id = result.insertId;
    await syncProductStats(newReview.product_id);
  } catch (err) {
    console.error('[REVIEW_ADMIN_CREATE_FAILED]', err.message);
    throw err;
  }

  return newReview;
};

const getPublicCustomerStories = async () => {
  try {
    const [rows] = await pool.query(
      `SELECT * FROM reviews
       WHERE is_approved = 1 AND (JSON_LENGTH(images) > 0 OR JSON_LENGTH(videos) > 0)
       ORDER BY created_at DESC LIMIT 24`
    );
    return (rows || []).map(r => {
      const review = parseReview(r);
      return { ...review, first_name: String(review.user_name || 'Patron').split(' ')[0] };
    });
  } catch (error) {
    console.error('[PUBLIC_CUSTOMER_STORIES_LOAD]', error);
    throw error;
  }
};

const getReviewsByProduct = async (productIdOrSlug, approvedOnly = true) => {
  let dbRows = [];
  const comboMatch = COMBO_BY_KEY[String(productIdOrSlug)] ||
    (PRODUCT_SLUGS[Number(productIdOrSlug)] && COMBO_BY_KEY[PRODUCT_SLUGS[Number(productIdOrSlug)]]) ||
    null;

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

    const targetProductIds = [resolvedId].filter(id => id != null && id > 0);
    const targetSlugs = [resolvedSlug].filter(s => typeof s === 'string' && s.trim());

    try {
      const [prodRows] = await pool.query(
        'SELECT id, slug, specifications FROM products WHERE id = ? OR slug = ? LIMIT 1',
        [resolvedId || -1, resolvedSlug || '']
      );
      if (prodRows && prodRows[0]?.specifications) {
        let specs = prodRows[0].specifications;
        if (typeof specs === 'string') {
          try { specs = JSON.parse(specs); } catch {}
        }
        const items = specs?.combo_items || specs?.components || specs?.items;
        if (Array.isArray(items) && (specs?.is_combo || specs?.product_type === 'combo' || specs?.product_type === 'bundle')) {
          for (const it of items) {
            const cId = it.product_id != null ? Number(it.product_id) : (it.id != null ? Number(it.id) : null);
            if (cId && cId > 0 && !targetProductIds.includes(cId)) targetProductIds.push(cId);
            if (typeof it.slug === 'string' && it.slug.trim() && !targetSlugs.includes(it.slug.trim())) {
              targetSlugs.push(it.slug.trim());
            }
          }
        }
      }
    } catch {
      // Non-blocking combo component resolution
    }

    const idPlaceholders = targetProductIds.length > 0 ? targetProductIds.map(() => '?').join(', ') : 'NULL';
    const slugPlaceholders = targetSlugs.length > 0 ? targetSlugs.map(() => '?').join(', ') : "''";

    const [rows] = await pool.query(
      `SELECT r.*,
              COALESCE(r.product_slug, p.slug) AS product_slug,
              COALESCE(r.product_name, p.name) AS product_name,
              COALESCE(r.reviewer_name, u.name, 'Verified Patron') AS user_name
       FROM reviews r
       LEFT JOIN users u ON r.user_id = u.id
       LEFT JOIN products p ON r.product_id = p.id
       WHERE (r.product_id IN (${idPlaceholders}) OR r.product_slug IN (${slugPlaceholders}) OR p.slug IN (${slugPlaceholders}) OR (? <> '' AND r.combo_name = ?)) ${whereClause}
       ORDER BY r.created_at DESC`,
      [...targetProductIds, ...targetSlugs, ...targetSlugs, comboMatch?.name || '', comboMatch?.name || '']
    );
    const seen = new Set();
    const uniqueRows = (rows || []).filter(row => {
      if (seen.has(row.id)) return false;
      seen.add(row.id);
      return true;
    });
    dbRows = uniqueRows.map(parseReview);
  } catch (error) {
    console.error('[PRODUCT_REVIEWS_LOAD]', error);
    throw error;
  }

  return dbRows;
};

const getReviewsByComboName = async comboName => {
  try {
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
  } catch (error) {
    console.error('[COMBO_REVIEWS_LOAD]', error);
    throw error;
  }
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
  } catch (error) {
    console.error('[ADMIN_REVIEWS_LOAD]', error);
    throw error;
  }

  return dbRows;
};

const updateReviewAsAdmin = async (id, data) => {
  let updatedRecord = null;
  let removedImages = [];
  let existing = null;
  try {
    const [existingRows] = await pool.query('SELECT * FROM reviews WHERE id = ?', [id]);
    if (existingRows?.[0]) existing = parseReview(existingRows[0]);
  } catch (error) {
    console.error('[ADMIN_REVIEW_LOOKUP]', error);
    throw error;
  }
  if (!existing) return false;

  const nextProductId = data.product_id !== undefined ? Number(data.product_id) : undefined;
  const prodSlug = data.product_slug || (nextProductId ? (PRODUCT_SLUGS[nextProductId] || '') : undefined);
  const prodName = data.product_name || (nextProductId ? (PRODUCT_NAMES[nextProductId] || '') : undefined);

  const comboKeyInput = data.combo_name !== undefined ? data.combo_name : data.combo_slug;
  const comboMatch = comboKeyInput ? COMBO_BY_KEY[comboKeyInput] : null;

  {
    const previousImages = Array.isArray(existing.images) ? existing.images : [];
    const targetProdId = nextProductId !== undefined ? nextProductId : existing.product_id;
    const nextCat = data.category_tag !== undefined ? data.category_tag : existing.category_tag;
    const nextIsCombo = data.is_combo_review !== undefined
      ? Boolean(data.is_combo_review)
      : (data.combo_name !== undefined ? Boolean(data.combo_name) : (nextCat === 'Combo Pack Ritual' || existing.is_combo_review));
    const nextComboName = nextIsCombo
      ? (comboMatch?.name || data.combo_name || existing.combo_name || 'The Complete Botanical Daily Regimen')
      : null;
    const nextComboInfo = nextComboName ? COMBO_BY_KEY[nextComboName] : null;

    updatedRecord = {
      ...existing,
      ...(data.rating !== undefined ? { rating: Number(data.rating) } : {}),
      ...(data.title !== undefined ? { title: data.title } : {}),
      ...(data.body !== undefined ? { body: data.body, comment: data.body } : {}),
      ...(data.user_name !== undefined ? { user_name: data.user_name, reviewer_name: data.user_name } : {}),
      ...(data.reviewer_location !== undefined ? { reviewer_location: data.reviewer_location } : {}),
      ...(data.order_number !== undefined ? { order_number: data.order_number } : {}),
      ...(data.helpful_count !== undefined ? { helpful_count: Number(data.helpful_count) || 0 } : {}),
      category_tag: nextCat,
      is_combo_review: nextIsCombo,
      combo_name: nextComboName,
      combo_slug: nextComboInfo?.id || (nextIsCombo ? existing.combo_slug : null),
      combo_sku: nextComboInfo?.sku || (nextIsCombo ? existing.combo_sku : null),
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
      is_combo_review: data.is_combo_review !== undefined ? (data.is_combo_review ? 1 : 0) : undefined,
      combo_name: data.combo_name !== undefined ? (data.combo_name || null) : undefined,
      order_number: data.order_number,
      helpful_count: data.helpful_count !== undefined ? Number(data.helpful_count) : undefined,
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
    if (nextProductId && Number(existing.product_id) !== nextProductId) await syncProductStats(existing.product_id);
  } catch (error) {
    console.error('[ADMIN_REVIEW_UPDATE]', error);
    throw error;
  }

  return { review: updatedRecord, removedImages };
};

const approveReview = async (id) => {
  try {
    await pool.query('UPDATE reviews SET is_approved = 1 WHERE id = ?', [id]);
  } catch (_) {}
  return true;
};

const archiveReview = async (id) => {
  const [rows] = await pool.query('SELECT id, product_id FROM reviews WHERE id = ?', [id]);
  if (!rows?.[0]) return false;

  await pool.query('UPDATE reviews SET is_approved = 0 WHERE id = ?', [id]);
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
    return (rows || []).map(parseReview);
  } catch (_) {
    return [];
  }
};

const deleteReviewPermanently = async (id) => {
  const [rows] = await pool.query('SELECT id, product_id FROM reviews WHERE id = ?', [id]);
  if (!rows?.[0]) return false;
  const [result] = await pool.query('DELETE FROM reviews WHERE id = ?', [id]);
  if (!result.affectedRows) return false;
  await syncProductStats(rows[0].product_id);
  return true;
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
  PRODUCT_SLUGS,
  PRODUCT_NAMES,
  COMBO_BY_KEY,
};
