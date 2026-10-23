const express = require('express');
const router = express.Router();

const { LUXURY_CATALOG, MAISON_REGIMEN_BUNDLES, BATCH_COA_REGISTRY, HOSPITALITY_BACKBAR_PROGRAM } = require('../data/luxuryCatalog');

router.get('/regimen-bundles', (req, res) => {
  res.json({
    success: true,
    positioning: 'The Synchronized Inside-Out Gut-Skin Biotic Protocol — 100% Active Disclosure in Sub-28°C Cold-Extracted Botanicals',
    bundles: MAISON_REGIMEN_BUNDLES || [],
    hospitalityProgram: HOSPITALITY_BACKBAR_PROGRAM || {},
    sampleBatchCoas: Object.values(BATCH_COA_REGISTRY || {})
  });
});

router.post('/gut-skin-quiz', (req, res) => {
  const { digestion = 'bloating_stress', breakoutZone = 'jawline_cheeks', cleanserHistory = 'acid_sulfate_stripping', stressSleep = 'high_cortisol', skinFeel = 'tight_yet_oily' } = req.body || {};
  const isCongestedOily = breakoutZone === 'tzone_comedones' || skinFeel === 'congested_pm25';
  const recommendedBundle = isCongestedOily ? MAISON_REGIMEN_BUNDLES[1] : MAISON_REGIMEN_BUNDLES[0];
  res.json({
    success: true,
    assessment: {
      dysbiosisIndex: 86,
      acidMantleEstimatedPh: cleanserHistory === 'acid_sulfate_stripping' ? '6.4 – 7.1 (Alkaline-Disrupted)' : '5.9 – 6.3 (Sub-Optimal)',
      primaryPathway: 'Intestinal LPS Endotoxemia (TNF-α / IL-6 Surge) + Stratum Corneum Lipid Depletion',
      protocolTitle: recommendedBundle.name,
      bundle: recommendedBundle,
      step1Prescription: '4 concentrated drops of Kalpvriksh Satva 7-Tulsi Cellular Reset Drops in 100 ml lukewarm water every morning on an empty stomach to downregulate intestinal COX-2 and seal gut tight junctions.',
      step2Prescription: isCongestedOily
        ? '2 pumps of 3% Activated Charcoal Postbiotic Cellular Emulsion (PM) + 4% Sea Buckthorn Postbiotic Emulsion (AM) massaged for 45s onto damp skin to restore pH 5.42 barrier homeostasis.'
        : '2 pumps of 4% Himalayan Sea Buckthorn Postbiotic Cellular Emulsion morning and night massaged for 45s onto damp skin to replenish Omega-7 lipids and Lactobacillus postbiotics at pH 5.42.'
    }
  });
});


const pool = require('../config/db');
const { authenticateAdmin } = require('../middleware/authMiddleware');
const { generateUploadUrl, deleteProductImage } = require('../config/s3Upload');
const { generateGoogleMerchantFeed } = require('../utils/merchantFeed');
const { findLuxurySkuBySlugOrId, buildProductJsonLd } = require('../middleware/seoPrerender');
const {
  cleanProductMarketingFields,
  validateProductMarketingFields,
} = require('../utils/productMarketingClaims');

const normalizeUrlList = (value, allowedHosts) => {
  if (value === undefined || value === null || value === '') return { value: null };
  if (typeof value !== 'string' || value.length > 5000) return { error: true };
  const urls = value.split(/\r?\n/).map(url => url.trim()).filter(Boolean);
  if (urls.length > 10) return { error: true };
  for (const url of urls) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || (allowedHosts && !allowedHosts.some(host => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`)))) {
        return { error: true };
      }
    } catch {
      return { error: true };
    }
  }
  return { value: urls.length ? urls.join('\n') : null };
};

const VIDEO_HOSTS = ['youtube.com', 'youtu.be', 'instagram.com'];

/**
 * Utility: Robustly parse and sanitize image parameters across all variations
 */
const parseImages = (rows) => {
    const baseUrl = process.env.CLOUDFRONT_BASE_URL || 'https://pub-70fdb5d94df347c4bed417c28b066c02.r2.dev/bhumivera';
  return rows.map(row => {
    let parsedImages = [];
    if (row.images) {
      try {
        let imgsData = row.images;
        if (Buffer.isBuffer(imgsData)) {
          imgsData = imgsData.toString('utf8');
        }
        
        if (typeof imgsData === 'string') {
          parsedImages = JSON.parse(imgsData);
        } else {
          parsedImages = imgsData;
        }
      } catch (e) { 
        parsedImages = []; 
      }
    }
    
    if (!Array.isArray(parsedImages)) {
      if (parsedImages && typeof parsedImages === 'object') {
        parsedImages = [parsedImages];
      } else {
        parsedImages = [];
      }
    }

    parsedImages = parsedImages.filter(img => img && (typeof img === 'string' || img.file_path || img.url || img.path));

    // Normalize image schemas to resolve both backend/frontend rendering requirements simultaneously
    const normalizedImages = parsedImages.map(img => {
      let path = '';
      if (typeof img === 'string') {
        path = img;
      } else if (img && typeof img === 'object') {
        path = img.file_path || img.url || img.path || '';
      }
      const fullUrl = path.startsWith('http') ? path : `${baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
      return {
        id: (img && typeof img === 'object' ? img.id : null) || null,
        file_path: path,
        url: fullUrl,
        media_type: (img && typeof img === 'object' ? img.media_type : 'image') || 'image',
        sort_order: (img && typeof img === 'object' ? Number(img.sort_order) || 0 : 0)
      };
    });
    normalizedImages.sort((a, b) => a.sort_order - b.sort_order);

    return { 
      ...cleanProductMarketingFields(row),
      images: normalizedImages.map(({ sort_order, ...image }) => image),
      image_url: normalizedImages.length > 0 ? normalizedImages[0].url : null
    };
  });
};

// ==========================================
// 1. GOOGLE MERCHANT CENTER FEED (Public)
// ==========================================
router.get('/feed/google-merchant', async (req, res) => {
  try {
    const xmlFeed = await generateGoogleMerchantFeed();
    res.set('Content-Type', 'application/xml');
    res.status(200).send(xmlFeed);
  } catch (error) {
    console.error("Merchant Feed Error:", error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to generate product feed', 
      error: error.message 
    });
  }
});

// ==========================================
// 2. GET ALL ACTIVE PRODUCTS (Public)
// ==========================================
router.get('/active', async (req, res) => {
  try {
    const { category, subcategory, search, sort, min_price, max_price } = req.query;
    let query = `
      SELECT p.*, 
      (SELECT JSON_ARRAYAGG(JSON_OBJECT('id', id, 'file_path', file_path, 'media_type', media_type, 'sort_order', sort_order)) FROM product_images WHERE product_id = p.id) as images
      FROM products p WHERE p.status = "active"
    `;
    const params = [];
    
    if (category) { query += ' AND p.category_id = ?'; params.push(category); }
    if (subcategory) { query += ' AND p.subcategory_id = ?'; params.push(subcategory); }
    if (search) { query += ' AND p.name LIKE ?'; params.push(`%${search}%`); }
    if (min_price) { query += ' AND p.price >= ?'; params.push(min_price); }
    if (max_price) { query += ' AND p.price <= ?'; params.push(max_price); }
    
    if (sort === 'price_asc') query += ' ORDER BY p.price ASC';
    else if (sort === 'price_desc') query += ' ORDER BY p.price DESC';
    else if (sort === 'newest') query += ' ORDER BY p.created_at DESC';
    else if (sort === 'rating') query += ' ORDER BY p.rating DESC';
    else query += ' ORDER BY p.created_at DESC';
    
    const [rows] = await pool.query(query, params);
    if (!rows || rows.length === 0) {
      return res.json({ success: true, data: LUXURY_CATALOG });
    }
    res.json({ success: true, data: parseImages(rows) });
  } catch (error) {
    res.json({ success: true, data: LUXURY_CATALOG });
  }
});

// ==========================================
// 3. GET ALL PRODUCTS (Admin)
// ==========================================
router.get('/', authenticateAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT p.*, c.name as category_name,
      (SELECT JSON_ARRAYAGG(JSON_OBJECT('id', id, 'file_path', file_path, 'media_type', media_type, 'sort_order', sort_order)) FROM product_images WHERE product_id = p.id) as images
      FROM products p 
      LEFT JOIN categories c ON p.category_id = c.id 
      ORDER BY p.created_at DESC
    `);
    res.json({ success: true, data: parseImages(rows) });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Database query failed' });
  }
});

// ==========================================
// 4. CREATE PRODUCT (Admin)
// ==========================================
router.post('/', authenticateAdmin, async (req, res) => {
  try {
    const { name, slug, description, price, discount_price, category_id, subcategory_id, quantity, status, sku, brand, warranty_period, meta_title, meta_description, tags, is_featured, is_trending, is_new_arrival, model_3d_url, video_urls, product_links, specifications } = req.body;
    if (validateProductMarketingFields({ name, description, meta_title, meta_description, tags })) {
      return res.status(400).json({
        success: false,
        message: 'Remove unsupported absolute or composition claims from product name, description, SEO fields, and tags. Use only claims documented for this exact product.',
      });
    }
    const videoLinks = normalizeUrlList(video_urls, VIDEO_HOSTS);
    const externalLinks = normalizeUrlList(product_links);
    if (videoLinks.error) {
      return res.status(400).json({ success: false, message: 'Add up to 10 secure YouTube or Instagram URLs, one per line.' });
    }
    if (externalLinks.error) {
      return res.status(400).json({ success: false, message: 'Add up to 10 valid HTTPS product links, one per line.' });
    }
    
    if (!name || !price || !category_id) {
      return res.status(400).json({ success: false, message: 'Name, price, and category are mandatory fields.' });
    }
    
    const finalSlug = slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const specData = typeof specifications === 'object' ? JSON.stringify(specifications) : (specifications || null);

    const safeCat = category_id === '' ? null : category_id;
    const safeSubCat = subcategory_id === '' ? null : subcategory_id;
    const safeDiscount = discount_price === '' ? null : discount_price;
    const safeWarranty = warranty_period === '' ? null : warranty_period;
    const safeQuantity = quantity === '' ? 0 : quantity || 0;

    const [result] = await pool.query(
      `INSERT INTO products (name, slug, description, price, discount_price, category_id, subcategory_id, quantity, status, sku, brand, warranty_period, meta_title, meta_description, tags, is_featured, is_trending, is_new_arrival, model_3d_url, video_urls, product_links, specifications) 
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [name, finalSlug, description || '', price, safeDiscount, safeCat, safeSubCat, safeQuantity, status || 'active', sku || null, brand || 'Bhumivera', safeWarranty, meta_title || null, meta_description || null, tags || null, is_featured || 0, is_trending || 0, is_new_arrival || 0, model_3d_url || null, videoLinks.value, externalLinks.value, specData]
    );
    
    const [newProduct] = await pool.query(`
      SELECT p.*,
      (SELECT JSON_ARRAYAGG(JSON_OBJECT('id', id, 'file_path', file_path, 'media_type', media_type, 'sort_order', sort_order)) FROM product_images WHERE product_id = p.id) as images
      FROM products p WHERE p.id = ?
    `, [result.insertId]);
    res.status(201).json({ success: true, message: 'Product created', data: parseImages(newProduct)[0] });
  } catch (error) {
    console.error("Insert Error:", error);
    res.status(500).json({ success: false, message: error.message || 'Failed to create product' });
  }
});

// ==========================================
// 5. UPDATE PRODUCT (Admin)
// ==========================================
router.put('/:id', authenticateAdmin, async (req, res) => {
  try {
    const productId = parseInt(req.params.id, 10);
    if (isNaN(productId)) return res.status(400).json({ success: false, message: 'Invalid ID format' });
    
    const fields = req.body;
    if (validateProductMarketingFields(fields)) {
      return res.status(400).json({
        success: false,
        message: 'Remove unsupported absolute or composition claims from product name, description, SEO fields, and tags. Use only claims documented for this exact product.',
      });
    }
    const allowedFields = ['name','slug','description','price','discount_price','category_id','subcategory_id','quantity','status','sku','brand','warranty_period','meta_title','meta_description','tags','is_featured','is_trending','is_new_arrival','model_3d_url','video_urls','product_links', 'specifications'];
    const videoLinks = fields.video_urls === undefined ? null : normalizeUrlList(fields.video_urls, VIDEO_HOSTS);
    const externalLinks = fields.product_links === undefined ? null : normalizeUrlList(fields.product_links);
    if (videoLinks?.error) {
      return res.status(400).json({ success: false, message: 'Add up to 10 secure YouTube or Instagram URLs, one per line.' });
    }
    if (externalLinks?.error) {
      return res.status(400).json({ success: false, message: 'Add up to 10 valid HTTPS product links, one per line.' });
    }
    
    const updates = [];
    const values = [];
    
    for (const key of allowedFields) {
      if (fields[key] !== undefined) {
        updates.push(`${key} = ?`);
        let val = key === 'video_urls' ? videoLinks.value : key === 'product_links' ? externalLinks.value : fields[key];
        
        if (key === 'specifications' && typeof val === 'object') {
          val = JSON.stringify(val);
        }
        
        if (val === '' && ['category_id', 'subcategory_id', 'price', 'discount_price', 'quantity', 'warranty_period'].includes(key)) {
          val = null;
        }

        values.push(val);
      }
    }
    
    if (updates.length === 0) return res.status(400).json({ success: false, message: 'No valid fields to update' });
    
    values.push(productId);
    await pool.query(`UPDATE products SET ${updates.join(', ')} WHERE id = ?`, values);
    
    const [updated] = await pool.query(`
      SELECT p.*,
      (SELECT JSON_ARRAYAGG(JSON_OBJECT('id', id, 'file_path', file_path, 'media_type', media_type, 'sort_order', sort_order)) FROM product_images WHERE product_id = p.id) as images
      FROM products p WHERE p.id = ?
    `, [productId]);
    res.json({ success: true, message: 'Product updated', data: parseImages(updated)[0] });
  } catch (error) {
    console.error("Update Error:", error);
    res.status(500).json({ success: false, message: 'Failed to update product' });
  }
});

// ==========================================
// 6. TOGGLE PRODUCT STATUS (Admin)
// ==========================================
router.patch('/:id/status', authenticateAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    if (!['active', 'inactive', 'draft'].includes(status)) return res.status(400).json({ success: false, message: 'Invalid status' });
    await pool.query('UPDATE products SET status = ? WHERE id = ?', [status, req.params.id]);
    res.json({ success: true, message: `Product status set to ${status}` });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to update status' });
  }
});

// ==========================================
// 7. MEDIA: GET PRE-SIGNED S3 URL (Admin)
// ==========================================
router.post('/presign', authenticateAdmin, async (req, res) => {
  try {
    let filename = req.body.filename || req.body.name || req.body.fileName;
    let fileType = req.body.fileType || req.body.type || req.body.file_type;
    
    if (typeof req.body === 'string') {
      filename = req.body;
    } else if (req.body && Object.keys(req.body).length > 0 && !filename) {
      const firstKey = Object.keys(req.body)[0];
      if (firstKey && firstKey.includes('.')) {
        filename = firstKey;
      }
    }

    if (filename && !fileType) {
      const ext = filename.split('.').pop().toLowerCase();
      if (['jpg', 'jpeg'].includes(ext)) fileType = 'image/jpeg';
      else if (ext === 'png') fileType = 'image/png';
      else if (ext === 'webp') fileType = 'image/webp';
      else if (ext === 'gif') fileType = 'image/gif';
      else fileType = 'application/octet-stream';
    }

    if (!filename || !['image/jpeg', 'image/png', 'image/webp'].includes(fileType)) {
      return res.status(400).json({ success: false, message: 'Choose a JPEG, PNG, or WebP product image.' });
    }
    
    const { uploadUrl, key } = await generateUploadUrl(filename, fileType);
    res.json({ success: true, uploadUrl, key });
  } catch (error) {
    console.error("Presign Handling Exception Catch Block:", error);
    res.status(500).json({ success: false, message: 'Failed to generate secure upload link' });
  }
});

// ==========================================
// 8. MEDIA: SAVE IMAGE LINKS (Admin)
// ==========================================
router.post('/:id/images/save', authenticateAdmin, async (req, res) => {
  try {
    const productId = parseInt(req.params.id, 10);
    const { imageKeys } = req.body; 
    
    if (!Number.isSafeInteger(productId) || productId < 1 ||
        !Array.isArray(imageKeys) || imageKeys.length === 0 || imageKeys.length > 20 ||
        imageKeys.some(key => typeof key !== 'string' || !/^products\/[a-zA-Z0-9/_-]+\.(jpg|jpeg|png|webp)$/i.test(key))) {
      return res.status(400).json({ success: false, message: 'Provide up to 20 valid uploaded product image keys.' });
    }
    
    const values = imageKeys.map(key => [productId, key, 'image']);
    await pool.query('INSERT INTO product_images (product_id, file_path, media_type) VALUES ?', [values]);
    
    res.json({ success: true, message: 'Images linked to product' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to link images to database' });
  }
});

// ==========================================
// 9. MEDIA: DELETE ALL IMAGES (Admin)
// ==========================================
router.delete('/:id/images/all', authenticateAdmin, async (req, res) => {
  try {
    const productId = parseInt(req.params.id, 10);
    await pool.query('DELETE FROM product_images WHERE product_id = ?', [productId]);
    res.json({ success: true, message: 'All images purged from database' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to purge images' });
  }
});

// ==========================================
// 10. MEDIA: DELETE SINGLE IMAGE (Admin)
// ==========================================
router.delete('/:id/images', authenticateAdmin, async (req, res) => {
  let connection;
  try {
    const productId = Number(req.params.id);
    const { imageId, imagePath } = req.body || {};
    if (!Number.isSafeInteger(productId) || productId < 1 || (!imageId && !imagePath)) {
      return res.status(400).json({ success: false, message: 'A valid product and image are required.' });
    }

    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [rows] = imageId
      ? await connection.query('SELECT id, file_path FROM product_images WHERE id = ? AND product_id = ? FOR UPDATE', [imageId, productId])
      : await connection.query('SELECT id, file_path FROM product_images WHERE file_path = ? AND product_id = ? FOR UPDATE', [imagePath, productId]);
    if (!rows.length) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Image was not found on this product.' });
    }

    const image = rows[0];
    if (typeof image.file_path === 'string' && image.file_path.startsWith('products/')) {
      await deleteProductImage(image.file_path);
    }
    const [result] = await connection.query('DELETE FROM product_images WHERE id = ? AND product_id = ?', [image.id, productId]);
    if (!result.affectedRows) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Image was not found on this product.' });
    }
    await connection.commit();
    res.json({ success: true, message: 'Product image deleted successfully.' });
  } catch (error) {
    if (connection) await connection.rollback().catch(rollbackError => {
      console.error('[PRODUCT_IMAGE_DELETE_ROLLBACK]', rollbackError);
    });
    console.error('[PRODUCT_IMAGE_DELETE]', error);
    const storageUnavailable = error.message?.includes('Object storage deletion is not configured.');
    res.status(storageUnavailable ? 503 : 500).json({
      success: false,
      message: storageUnavailable
        ? 'Image deletion is unavailable because object storage is not configured.'
        : 'Could not delete the image. The product image record was not removed.',
    });
  } finally {
    connection?.release();
  }
});

// ==========================================
// 11. INVENTORY: ADD SERIAL NUMBERS (Admin)
// ==========================================
router.post('/:id/serials', authenticateAdmin, async (req, res) => {
  try {
    const { serials } = req.body;
    if (!serials || !Array.isArray(serials)) return res.status(400).json({ success: false, message: 'Serials array required' });
    const values = serials.map(s => [req.params.id, s, 'available']);
    await pool.query('INSERT IGNORE INTO product_serials (product_id, serial_number, status) VALUES ?', [values]);
    res.json({ success: true, message: `${serials.length} serial(s) added` });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to add serials' });
  }
});

// ==========================================
// 12. DELETE PRODUCT (Admin)
// ==========================================
router.delete('/:id', authenticateAdmin, async (req, res) => {
  try {
    const productId = parseInt(req.params.id, 10);
    if (isNaN(productId)) return res.status(400).json({ success: false, message: 'Invalid ID format' });
    await pool.query('DELETE FROM products WHERE id = ?', [productId]);
    res.json({ success: true, message: 'Product deleted' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to delete product' });
  }
});

// ==========================================
// 13. SMART IDENTIFIER (ID or Slug) (Public)
// ==========================================

// GET /api/products/:productId/qa (Public Q&A list)
router.get('/:productId/qa', async (req, res) => {
  try {
    const productId = parseInt(req.params.productId, 10);
    if (!productId || isNaN(productId)) {
      return res.json([]);
    }
    const [rows] = await pool.query(
      'SELECT id, product_id, user_name, question, answer, helpful_count, created_at FROM product_questions WHERE product_id = ? AND is_approved = 1 ORDER BY created_at DESC LIMIT 50',
      [productId]
    );
    res.json(rows);
  } catch (err) {
    console.error('[PRODUCT_QA_GET_ERROR]', err);
    res.json([]);
  }
});

// POST /api/products/:productId/qa (Submit question)
router.post('/:productId/qa', async (req, res) => {
  try {
    const productId = parseInt(req.params.productId, 10);
    const { question } = req.body || {};
    if (!productId || isNaN(productId)) {
      return res.status(400).json({ success: false, message: 'Valid product ID is required.' });
    }
    if (!question || typeof question !== 'string' || !question.trim()) {
      return res.status(400).json({ success: false, message: 'Question text is required.' });
    }
    const userName = req.user?.name || req.body?.userName || 'Customer';
    const userId = req.user?.id || null;

    const [result] = await pool.query(
      'INSERT INTO product_questions (product_id, user_id, user_name, question) VALUES (?, ?, ?, ?)',
      [productId, userId, userName.slice(0, 100), question.trim().slice(0, 1000)]
    );
    res.status(201).json({ success: true, message: 'Question submitted successfully.', id: result.insertId });
  } catch (err) {
    console.error('[PRODUCT_QA_POST_ERROR]', err);
    res.status(500).json({ success: false, message: 'Failed to submit question.' });
  }
});

// GET /api/products/slug/:slug (Explicit slug lookup)
router.get('/slug/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const query = `
      SELECT p.*, 
      (SELECT JSON_ARRAYAGG(JSON_OBJECT('id', id, 'file_path', file_path, 'media_type', media_type, 'sort_order', sort_order)) FROM product_images WHERE product_id = p.id) as images
      FROM products p
      WHERE p.slug = ? AND p.status = 'active'
    `;
    const matchedCatalog = findLuxurySkuBySlugOrId(slug);
    const canonicalSlug = matchedCatalog ? matchedCatalog.slug : slug;
    const [rows] = await pool.query(query, [canonicalSlug]);
    if (rows.length === 0) {
      if (matchedCatalog) {
        return res.json({ success: true, data: matchedCatalog, schema_markup: buildProductJsonLd(matchedCatalog) });
      }
      return res.status(404).json({ success: false, message: 'Product not found' });
    }
    const product = { ...(matchedCatalog || {}), ...parseImages(rows)[0] };
    res.json({ success: true, data: product, schema_markup: buildProductJsonLd(product) });
  } catch (error) {
    console.error('[PRODUCT_BY_SLUG_ERROR]', error);
    res.status(500).json({ success: false, message: 'Database query failed' });
  }
});

router.get('/:identifier', async (req, res) => {
  try {
    const { identifier } = req.params;
    const isNumeric = /^\d+$/.test(identifier);

    let query = `
      SELECT p.*, 
      (SELECT JSON_ARRAYAGG(JSON_OBJECT('id', id, 'file_path', file_path, 'media_type', media_type, 'sort_order', sort_order)) FROM product_images WHERE product_id = p.id) as images
      FROM products p
    `;
    let params = [identifier];

    if (isNumeric) {
      query += ` WHERE p.id = ?`;
    } else {
      query += ` WHERE p.slug = ? AND p.status = 'active'`;
    }

    const matchedCatalog = findLuxurySkuBySlugOrId(identifier);
    if (matchedCatalog && !isNumeric) {
      params = [matchedCatalog.slug];
    }
    let [rows] = await pool.query(query, params);

    if (rows.length === 0 && isNumeric && matchedCatalog) {
      const aliasQuery = query.replace('WHERE p.id = ?', 'WHERE p.sku = ?');
      [rows] = await pool.query(aliasQuery, [matchedCatalog.sku]);
    }

    if (rows.length === 0) {
      if (matchedCatalog) {
        const unavailableLegacyProduct = isNumeric
          ? { ...matchedCatalog, id: Number(identifier), quantity: 0, status: 'inactive' }
          : matchedCatalog;
        return res.json({
          success: true,
          data: unavailableLegacyProduct,
          schema_markup: buildProductJsonLd(unavailableLegacyProduct)
        });
      }
      return res.status(404).json({ success: false, message: 'Product not found' });
    }
    
    const product = { ...(matchedCatalog || {}), ...parseImages(rows)[0] };

    // SEO ENGINE: Compile Google structured JSON-LD data dynamically
    const schemaMarkup = {
      "@context": "https://schema.org/",
      "@type": "Product",
      "name": product.name,
      "image": product.images && product.images.length > 0 ? product.images.map(img => {
        const path = typeof img === 'object' ? (img.file_path || img.url || img.path) : img;
        return `https://pub-70fdb5d94df347c4bed417c28b066c02.r2.dev/${path}`;
      }) : [],
      "description": product.meta_description || product.description,
      "sku": product.sku || `BHUMI-${product.id}`,
      "brand": {
        "@type": "Brand",
        "name": product.brand || "Bhumivera"
      },
      "offers": {
        "@type": "Offer",
        "url": `https://www.bhumivera.com/product/${product.slug}`,
        "priceCurrency": "INR",
        "price": product.discount_price || product.price,
        "availability": product.quantity > 0 ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
        "itemCondition": "https://schema.org/NewCondition"
      }
    };

    if (product.rating && product.review_count) {
      schemaMarkup.aggregateRating = {
        "@type": "AggregateRating",
        "ratingValue": product.rating,
        "reviewCount": product.review_count
      };
    }
    
    res.json({ 
      success: true, 
      data: product,
      schema_markup: schemaMarkup
    });
  } catch (error) {
    console.error("Smart Identifier Route Error:", error);
    res.status(500).json({ success: false, message: 'Database query failed' });
  }
});

module.exports = router;
