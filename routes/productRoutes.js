const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { authenticateAdmin } = require('../middleware/authMiddleware');
const { generateUploadUrl } = require('../config/s3Upload');
const { generateGoogleMerchantFeed } = require('../utils/merchantFeed');

/**
 * Utility: Parse image results from JSON_ARRAYAGG or stringified columns
 */
const parseImages = (rows) => {
  return rows.map(row => {
    let parsedImages = [];
    if (row.images) {
      try {
        parsedImages = typeof row.images === 'string' ? JSON.parse(row.images) : row.images;
        if (Array.isArray(parsedImages)) {
          parsedImages = parsedImages.filter(img => img !== null);
        }
      } catch (e) { 
        parsedImages = []; 
      }
    }
    return { ...row, images: parsedImages || [] };
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
      (SELECT JSON_ARRAYAGG(file_path) FROM product_images WHERE product_id = p.id) as images 
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
    res.json({ success: true, data: parseImages(rows) });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Database query failed' });
  }
});

// ==========================================
// 3. GET ALL PRODUCTS (Admin)
// ==========================================
router.get('/', authenticateAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT p.*, c.name as category_name,
      (SELECT JSON_ARRAYAGG(file_path) FROM product_images WHERE product_id = p.id) as images
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
    
    // STRICT VALIDATION: Prevent DB Null constraint crashes
    if (!name || !price || !category_id) {
      return res.status(400).json({ success: false, message: 'Name, price, and category are mandatory fields.' });
    }
    
    const finalSlug = slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const specData = typeof specifications === 'object' ? JSON.stringify(specifications) : (specifications || null);

    // SANITIZATION: Force empty strings to NULL or 0 for MySQL Strict Mode
    const safeCat = category_id === '' ? null : category_id;
    const safeSubCat = subcategory_id === '' ? null : subcategory_id;
    const safeDiscount = discount_price === '' ? null : discount_price;
    const safeWarranty = warranty_period === '' ? null : warranty_period;
    const safeQuantity = quantity === '' ? 0 : quantity || 0;

    const [result] = await pool.query(
      `INSERT INTO products (name, slug, description, price, discount_price, category_id, subcategory_id, quantity, status, sku, brand, warranty_period, meta_title, meta_description, tags, is_featured, is_trending, is_new_arrival, model_3d_url, video_urls, product_links, specifications) 
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [name, finalSlug, description || '', price, safeDiscount, safeCat, safeSubCat, safeQuantity, status || 'active', sku || null, brand || 'Bhumivera', safeWarranty, meta_title || null, meta_description || null, tags || null, is_featured || 0, is_trending || 0, is_new_arrival || 0, model_3d_url || null, video_urls || null, product_links || null, specData]
    );
    
    const [newProduct] = await pool.query('SELECT * FROM products WHERE id = ?', [result.insertId]);
    res.status(201).json({ success: true, message: 'Product created', data: newProduct[0] });
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
    const allowedFields = ['name','slug','description','price','discount_price','category_id','subcategory_id','quantity','status','sku','brand','warranty_period','meta_title','meta_description','tags','is_featured','is_trending','is_new_arrival','model_3d_url','video_urls','product_links', 'specifications'];
    
    const updates = [];
    const values = [];
    
    for (const key of allowedFields) {
      if (fields[key] !== undefined) {
        updates.push(`${key} = ?`);
        let val = fields[key];
        
        if (key === 'specifications' && typeof val === 'object') {
          val = JSON.stringify(val);
        }
        
        // SANITIZATION: Prevent MySQL "Incorrect integer value: ''" crash
        if (val === '' && ['category_id', 'subcategory_id', 'price', 'discount_price', 'quantity', 'warranty_period'].includes(key)) {
          val = null;
        }

        values.push(val);
      }
    }
    
    if (updates.length === 0) return res.status(400).json({ success: false, message: 'No valid fields to update' });
    
    values.push(productId);
    await pool.query(`UPDATE products SET ${updates.join(', ')} WHERE id = ?`, values);
    
    const [updated] = await pool.query('SELECT * FROM products WHERE id = ?', [productId]);
    res.json({ success: true, message: 'Product updated', data: updated[0] });
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
    const { filename, fileType } = req.body;
    if (!filename || !fileType) return res.status(400).json({ success: false, message: 'Filename and type required' });
    
    const { uploadUrl, key } = await generateUploadUrl(filename, fileType);
    res.json({ success: true, uploadUrl, key });
  } catch (error) {
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
    
    if (!imageKeys || imageKeys.length === 0) return res.status(400).json({ success: false, message: 'No image keys provided' });
    
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
  try {
    const { imageId } = req.body;
    await pool.query('DELETE FROM product_images WHERE id = ? AND product_id = ?', [imageId, req.params.id]);
    res.json({ success: true, message: 'Image removed' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to delete image' });
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
router.get('/:identifier', async (req, res) => {
  try {
    const { identifier } = req.params;
    const isNumeric = /^\d+$/.test(identifier);

    let query = `
      SELECT p.*, 
      (SELECT JSON_ARRAYAGG(file_path) FROM product_images WHERE product_id = p.id) as images
      FROM products p
    `;
    let params = [identifier];

    if (isNumeric) {
      query += ` WHERE p.id = ?`;
    } else {
      query += ` WHERE p.slug = ? AND p.status = 'active'`;
    }

    const [rows] = await pool.query(query, params);

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }
    
    const product = parseImages(rows)[0];

    // SEO ENGINE: Compile Google structured JSON-LD data dynamically
    const schemaMarkup = {
      "@context": "https://schema.org/",
      "@type": "Product",
      "name": product.name,
      "image": product.images && product.images.length > 0 ? product.images.map(img => `https://pub-22cd43cce9bc475680ad496e199706c4.r2.dev/${img}`) : [],
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
      schema_markup: schemaMarkup // Ready for injection in the public frontend React <head>
    });
  } catch (error) {
    console.error("Smart Identifier Route Error:", error);
    res.status(500).json({ success: false, message: 'Database query failed' });
  }
});

module.exports = router;
