const pool = require('../config/db');

const toSlug = str => String(str || '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/(^-|-$)/g, '');

const DEFAULT_CATEGORY_METADATA = {
  'Artisanal Ayurvedic Cleansing Bars': {
    slug: 'artisanal-ayurvedic-cleansing-bars',
    description: 'Handcrafted 100% natural Ayurvedic luxury bathing bars formulated with pure Activated Charcoal, Aloe Vera, Neem, and Sacred Tulsi. Free from sulfates, parabens, and harsh synthetic detergents.'
  },
  'Luxury Facial Cleansers': {
    slug: 'luxury-facial-cleansers',
    description: 'Sulfate-free, pH 5.5 skin-barrier calibrated luxury facial cleansers. Formulated with 4% Himalayan Sea Buckthorn, 3% Activated Charcoal, Hyaluronic Acid, and Niacinamide with 100% label-disclosed potencies.'
  },
  'Luxury Hair Care': {
    slug: 'luxury-hair-care',
    description: 'Royal Ayurvedic 2-in-1 conditioning shampoos and restorative botanical hair rituals formulated with natural saponin extracts of Reetha, Amla, Bhringraj, Rosemary Oil, and Shikakai.'
  },
  'Luxury Ayurvedic Wellness & Immunity Drops': {
    slug: 'luxury-ayurvedic-wellness-immunity-drops',
    description: 'High-potency 90% liquid distillate of 7 sacred Tulsi varieties (Van, Sweet, Marua, Bisva, Kala, Rama & Lemon Tulsi) designed to balance stress, enhance vitality, and promote healthy radiant skin from within.'
  }
};

const CATEGORY_AUDIT_FIELDS = ['id', 'name', 'description', 'image_url', 'is_active'];

const createCategoryError = (code, message) => Object.assign(new Error(message), { code });

const normalizeCategory = category => {
  const name = String(category.name || '').trim();
  const rawSlug = category.slug ? String(category.slug).trim() : '';
  const meta = DEFAULT_CATEGORY_METADATA[name] || {};
  const slug = rawSlug || meta.slug || toSlug(name);
  const rawDesc = category.description ? String(category.description).trim() : '';
  const description = rawDesc || meta.description || null;
  return {
    name,
    slug,
    description,
    image_url: category.image_url ? String(category.image_url).trim() : null,
    is_active: category.is_active !== undefined ? Number(category.is_active) : 1,
  };
};

const validateCategory = category => {
  if (!category.name || category.name.length > 100) {
    throw createCategoryError('INVALID_CATEGORY', 'Category name is required and must be at most 100 characters.');
  }
  if (category.slug && category.slug.length > 120) {
    throw createCategoryError('INVALID_CATEGORY', 'Category slug must be at most 120 characters.');
  }
  if (category.description && category.description.length > 10000) {
    throw createCategoryError('INVALID_CATEGORY', 'Category description must be at most 10000 characters.');
  }
  if (category.image_url && category.image_url.length > 500) {
    throw createCategoryError('INVALID_CATEGORY', 'Category image URL must be at most 500 characters.');
  }
  if (![0, 1].includes(category.is_active)) {
    throw createCategoryError('INVALID_CATEGORY', 'Category active status must be 0 or 1.');
  }
};

const toCategorySnapshot = row => row
  ? Object.fromEntries(CATEGORY_AUDIT_FIELDS.map(field => [field, row[field]]))
  : null;

const withCategoryAudit = async (action, categoryId, actor, operation) => {
  const connection = await pool.getConnection();
  let transactionStarted = false;
  try {
    await connection.beginTransaction();
    transactionStarted = true;
    const result = await operation(connection);
    const before = toCategorySnapshot(result.before);
    const after = toCategorySnapshot(result.after);
    await connection.query(
      `INSERT INTO category_audit_log
        (actor_admin_id, actor_email, action, category_id, before_state, after_state)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        actor?.id || null,
        actor?.email || null,
        action,
        categoryId || result.after?.id || result.before?.id || null,
        before ? JSON.stringify(before) : null,
        after ? JSON.stringify(after) : null,
      ]
    );
    await connection.commit();
    return result.value;
  } catch (error) {
    if (transactionStarted) await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
};

// Helper: add column if it doesn't exist
const addColumnIfMissing = async (table, column, definition) => {
  const [cols] = await pool.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = ?
     AND COLUMN_NAME = ?`,
    [table, column]
  );
  if (cols.length === 0) {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
};

const initCategoriesTable = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS categories (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      slug VARCHAR(120),
      description TEXT,
      image_url VARCHAR(500),
      is_active TINYINT(1) DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await addColumnIfMissing('categories', 'slug', 'VARCHAR(120) AFTER name');
  await addColumnIfMissing('categories', 'description', 'TEXT AFTER slug');
  await addColumnIfMissing('categories', 'image_url', 'VARCHAR(500) AFTER description');
  await addColumnIfMissing('categories', 'is_active', 'TINYINT(1) DEFAULT 1 AFTER image_url');
};

const initCategoryAuditTable = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS category_audit_log (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      actor_admin_id BIGINT UNSIGNED NULL,
      actor_email VARCHAR(255) NULL,
      action VARCHAR(20) NOT NULL,
      category_id INT NULL,
      before_state JSON NULL,
      after_state JSON NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_category_audit_created (created_at),
      INDEX idx_category_audit_category (category_id),
      INDEX idx_category_audit_actor (actor_admin_id)
    ) ENGINE=InnoDB
  `);
};

const getAllCategories = async () => {
  let rows = [];
  try {
    const [dbRows] = await pool.query(
      'SELECT id, name, slug, description, image_url, is_active, created_at FROM categories ORDER BY name'
    );
    rows = dbRows;
  } catch (err) {
    if (err.message && (err.message.includes("Unknown column 'slug'") || err.message.includes("doesn't exist"))) {
      const [legacyRows] = await pool.query(
        'SELECT id, name, description, image_url, is_active, created_at FROM categories ORDER BY name'
      );
      rows = legacyRows;
    } else {
      throw err;
    }
  }

  return rows.map(row => {
    const meta = DEFAULT_CATEGORY_METADATA[row.name] || {};
    return {
      ...row,
      slug: row.slug || meta.slug || toSlug(row.name),
      description: row.description || meta.description || `Formulations and luxury ritual products in ${row.name} by Bhumivera Organics.`
    };
  });
};

const getCategoryById = async id => {
  let row = null;
  try {
    const [rows] = await pool.query(
      'SELECT id, name, slug, description, image_url, is_active, created_at FROM categories WHERE id = ?',
      [id]
    );
    row = rows[0];
  } catch (err) {
    if (err.message && err.message.includes("Unknown column 'slug'")) {
      const [legacyRows] = await pool.query(
        'SELECT id, name, description, image_url, is_active, created_at FROM categories WHERE id = ?',
        [id]
      );
      row = legacyRows[0];
    } else {
      throw err;
    }
  }
  if (!row) return null;
  const meta = DEFAULT_CATEGORY_METADATA[row.name] || {};
  return {
    ...row,
    slug: row.slug || meta.slug || toSlug(row.name),
    description: row.description || meta.description || null
  };
};

const createCategory = async ({ name, slug, description, image_url, is_active }, actor) => {
  const category = normalizeCategory({ name, slug, description, image_url, is_active });
  validateCategory(category);
  return withCategoryAudit('created', null, actor, async connection => {
    let insertId;
    try {
      const [result] = await connection.query(
        'INSERT INTO categories (name, slug, description, image_url, is_active) VALUES (?, ?, ?, ?, ?)',
        [category.name, category.slug, category.description, category.image_url, category.is_active]
      );
      insertId = result.insertId;
    } catch (err) {
      if (err.message && err.message.includes("Unknown column 'slug'")) {
        const [result] = await connection.query(
          'INSERT INTO categories (name, description, image_url, is_active) VALUES (?, ?, ?, ?)',
          [category.name, category.description, category.image_url, category.is_active]
        );
        insertId = result.insertId;
      } else {
        throw err;
      }
    }
    return { value: insertId, after: { id: insertId, ...category } };
  });
};

const updateCategory = async (id, { name, slug, description, image_url, is_active }, actor) => {
  const category = normalizeCategory({ name, slug, description, image_url, is_active });
  validateCategory(category);
  return withCategoryAudit('updated', id, actor, async connection => {
    const [rows] = await connection.query(
      'SELECT id, name, description, image_url, is_active FROM categories WHERE id = ? FOR UPDATE',
      [id]
    );
    if (!rows[0]) throw createCategoryError('CATEGORY_NOT_FOUND', 'Category not found.');
    try {
      await connection.query(
        'UPDATE categories SET name = ?, slug = ?, description = ?, image_url = ?, is_active = ? WHERE id = ?',
        [category.name, category.slug, category.description, category.image_url, category.is_active, id]
      );
    } catch (err) {
      if (err.message && err.message.includes("Unknown column 'slug'")) {
        await connection.query(
          'UPDATE categories SET name = ?, description = ?, image_url = ?, is_active = ? WHERE id = ?',
          [category.name, category.description, category.image_url, category.is_active, id]
        );
      } else {
        throw err;
      }
    }
    return {
      value: undefined,
      before: rows[0],
      after: { id: Number(id), ...category },
    };
  });
};

const deleteCategory = async (id, actor) => withCategoryAudit('deleted', id, actor, async connection => {
  const [rows] = await connection.query(
    'SELECT id, name, description, image_url, is_active FROM categories WHERE id = ? FOR UPDATE',
    [id]
  );
  if (!rows[0]) throw createCategoryError('CATEGORY_NOT_FOUND', 'Category not found.');
  await connection.query('DELETE FROM categories WHERE id = ?', [id]);
  return { value: undefined, before: rows[0] };
});

const getCategoryAuditHistory = async limit => {
  const [rows] = await pool.query(
    `SELECT id, actor_admin_id, actor_email, action, category_id, before_state, after_state, created_at
     FROM category_audit_log
     ORDER BY id DESC
     LIMIT ?`,
    [limit]
  );
  return rows;
};

module.exports = {
  getAllCategories,
  getCategoryById,
  createCategory,
  updateCategory,
  deleteCategory,
  getCategoryAuditHistory,
  initCategoriesTable,
  initCategoryAuditTable,
};
