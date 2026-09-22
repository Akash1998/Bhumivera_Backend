const pool = require('../config/db');
require('dotenv').config();
const CLOUDFRONT_BASE_URL = process.env.CLOUDFRONT_BASE_URL;

const addColIfMissing = async (table, column, definition) => {
  try {
    const [cols] = await pool.query(`SHOW COLUMNS FROM ${table} LIKE '${column}'`);
    if (cols.length === 0) {
      await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      console.log(`[DB] Added column ${column} to ${table}`);
    }
  } catch (err) {
    console.error(`[DB] Error adding column ${column} to ${table}:`, err.message);
  }
};

const initProductsTable = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      slug VARCHAR(255) UNIQUE,
      sku VARCHAR(100) UNIQUE,
      brand VARCHAR(100),
      warranty_period VARCHAR(100),
      description TEXT,
      price DECIMAL(10,2) NOT NULL,
      discount_price DECIMAL(10,2),
      quantity INT DEFAULT 0,
      status ENUM('active', 'inactive') DEFAULT 'active',
      is_featured BOOLEAN DEFAULT FALSE,
      is_trending BOOLEAN DEFAULT FALSE,
      is_new_arrival BOOLEAN DEFAULT FALSE,
      rating DECIMAL(3,2) DEFAULT 0,
      review_count INT DEFAULT 0,
      category_id INT,
      subcategory_id INT,
      meta_title VARCHAR(255),
      meta_description TEXT,
      tags VARCHAR(500),
      video_urls TEXT,
      product_links TEXT,
      model_3d_url VARCHAR(500),
      specifications JSON,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL,
      FOREIGN KEY (subcategory_id) REFERENCES subcategories(id) ON DELETE SET NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS product_images (
      id INT AUTO_INCREMENT PRIMARY KEY,
      product_id INT,
      file_path VARCHAR(500) NOT NULL,
      media_type ENUM('image','video','3d') DEFAULT 'image',
      sort_order INT DEFAULT 0,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
    )
  `);

  // Migrations for existing tables
  await addColIfMissing('products', 'quantity', "INT DEFAULT 0");
  await addColIfMissing('products', 'status', "ENUM('active', 'inactive') DEFAULT 'active'");
  await addColIfMissing('products', 'is_featured', "BOOLEAN DEFAULT FALSE");
  await addColIfMissing('products', 'is_trending', "BOOLEAN DEFAULT FALSE");
  await addColIfMissing('products', 'is_new_arrival', "BOOLEAN DEFAULT FALSE");
  await addColIfMissing('products', 'rating', "DECIMAL(3,2) DEFAULT 0");
  await addColIfMissing('products', 'review_count', "INT DEFAULT 0");
  await addColIfMissing('products', 'video_urls', 'TEXT DEFAULT NULL');
  await addColIfMissing('products', 'product_links', 'TEXT DEFAULT NULL');
  await addColIfMissing('products', 'model_3d_url', 'VARCHAR(500) DEFAULT NULL');
  await addColIfMissing('products', 'specifications', 'JSON');
};

const attachImages = async (rows) => {
  for (const product of rows) {
    const [imgs] = await pool.query(
      'SELECT file_path, media_type, sort_order FROM product_images WHERE product_id = ? ORDER BY sort_order ASC',
      [product.id]
    );
    product.images = imgs.map((r) => ({
      url: r.file_path.startsWith('http') ? r.file_path : `${CLOUDFRONT_BASE_URL}/${r.file_path}`,
      type: r.media_type || 'image'
    }));
    // Also set a primary image_url for easy acces
    product.image_url = product.images.length > 0 ? product.images[0].url : null;
  }
  return rows;
};

const getAllProducts = async () => {
  const [rows] = await pool.query(`
    SELECT p.*, c.name AS category_name, sc.name AS subcategory_name
    FROM products p
    LEFT JOIN categories c ON p.category_id = c.id
    LEFT JOIN subcategories sc ON p.subcategory_id = sc.id
    ORDER BY p.created_at DESC
  `); 
  return attachImages(rows);
};

const getActiveProducts = async ({ category_id, subcategory_id, min_price, max_price, search, sort, featured, trending, new_arrival } = {}) => {
  let sql = `
    SELECT p.*, c.name AS category_name, sc.name AS subcategory_name
    FROM products p
    LEFT JOIN categories c ON p.category_id = c.id
    LEFT JOIN subcategories sc ON p.subcategory_id = sc.id
    WHERE p.status = 'active'
  `; 
  const params = [];

  if (category_id) { sql += ' AND p.category_id = ?'; params.push(category_id); }
  if (subcategory_id) { sql += ' AND p.subcategory_id = ?'; params.push(subcategory_id); }
  if (min_price) { sql += ' AND (IFNULL(p.discount_price, p.price)) >= ?'; params.push(min_price); }
  if (max_price) { sql += ' AND (IFNULL(p.discount_price, p.price)) <= ?'; params.push(max_price); }
  if (featured) { sql += ' AND p.is_featured = 1'; }
  if (trending) { sql += ' AND p.is_trending = 1'; }
  if (new_arrival) { sql += ' AND p.is_new_arrival = 1'; }

  if (search) {
    sql += ' AND (p.name LIKE ? OR p.sku LIKE ? OR p.tags LIKE ? OR p.brand LIKE ?)';
    const term = `%${search}%`;
    params.push(term, term, term, term);
  }
  
  const sortOptions = {
    price_asc: 'IFNULL(p.discount_price, p.price) ASC',
    price_desc: 'IFNULL(p.discount_price, p.price) DESC',
    newest: 'p.created_at DESC',
    name_asc: 'p.name ASC',
    rating: 'p.rating DESC'
  };
  sql += ` ORDER BY ${sortOptions[sort] || 'p.created_at DESC'}`;
  
  const [rows] = await pool.query(sql, params);
  return attachImages(rows);
};

const getProductById = async (id) => {
  const [[product]] = await pool.query(
    'SELECT p.*, c.name AS category_name FROM products p LEFT JOIN categories c ON p.category_id = c.id WHERE p.id = ?',
    [id]
  );
  if (!product) return null;
  const [images] = await attachImages([product]);
  return images[0];
};

const getProductBySlug = async (slug) => {
  const [[product]] = await pool.query(
    'SELECT id FROM products WHERE slug = ? AND status = "active"',
    [slug]
  );
  if (!product) return null;
  return getProductById(product.id);
};

const createProduct = async (data) => {
  const {
    name, slug, sku, brand, warranty_period, description,
    price, discount_price, quantity,
    category_id, subcategory_id,
    meta_title, meta_description, tags,
    video_urls, product_links, model_3d_url, specifications,
    status = 'active',
  } = data;
  
  const specData = typeof specifications === 'object' ? JSON.stringify(specifications) : (specifications || null);

  const [result] = await pool.query(
    `INSERT INTO products 
    (name, slug, sku, brand, warranty_period, description, price, discount_price, quantity, status, category_id, subcategory_id, meta_title, meta_description, tags, video_urls, product_links, model_3d_url, specifications)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [name, slug || null, sku || null, brand || null, warranty_period || null, description || null,
    price, discount_price || null, quantity || 0, status,
    category_id, subcategory_id || null,
    meta_title || null, meta_description || null, tags || null,
    video_urls || null, product_links || null, model_3d_url || null, specData]
  );
  return result.insertId;
};

const updateProduct = async (id, data) => {
  const fields = Object.keys(data).filter(f => !['id', 'images', 'serials'].includes(f));
  if (fields.length === 0) return;
  const sql = `UPDATE products SET ${fields.map(f => `${f}=?`).join(', ')} WHERE id=?`;
  
  // Ensure objects are stringified before SQL execution
  const params = fields.map(f => {
    if (f === 'specifications' && typeof data[f] === 'object') {
      return JSON.stringify(data[f]);
    }
    return data[f];
  });
  
  params.push(id);
  await pool.query(sql, params);
};

const deleteProduct = async (id) => {
  const [product] = await pool.query('SELECT name FROM products WHERE id = ?', [id]);
  if (product.length === 0) throw { status: 404, message: 'Product not found' };
  await pool.query('DELETE FROM product_images WHERE product_id = ?', [id]);
  await pool.query('DELETE FROM products WHERE id = ?', [id]);
  return { deleted: true, productName: product[0].name };
};

const updateProductStock = async (id, quantityChange, operation = 'set') => {
  let query = '';
  if (operation === 'set') query = 'UPDATE products SET quantity = ? WHERE id = ?';
  else if (operation === 'add') query = 'UPDATE products SET quantity = quantity + ? WHERE id = ?';
  else if (operation === 'subtract') query = 'UPDATE products SET quantity = GREATEST(0, quantity - ?) WHERE id = ?';
  
  await pool.query(query, [quantityChange, id]);
  const [[updatedProduct]] = await pool.query('SELECT quantity FROM products WHERE id = ?', [id]);
  return updatedProduct.quantity;
};

initProductsTable().catch(err => console.error('[DB] productModel migration error:', err));

module.exports = {
  initProductsTable,
  getAllProducts,
  getActiveProducts,
  getProductById,
  getProductBySlug,
  createProduct,
  updateProduct,
  deleteProduct,
  updateProductStock,
  addProductImage: async (productId, filePath, mediaType = 'image') => {
    await pool.query('INSERT INTO product_images (product_id, file_path, media_type) VALUES (?, ?, ?)', [productId, filePath, mediaType]);
  },
  deleteProductImage: async (imageId) => {
    await pool.query('DELETE FROM product_images WHERE id = ?', [imageId]);
  }
};
