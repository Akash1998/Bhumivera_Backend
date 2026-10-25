const crypto = require('crypto');
const pool = require('../config/db');

const MAX_BATCH_SIZE = 1000;
const MAX_BATCH_DETAILS = 40;
const MAX_DETAIL_VALUE_LENGTH = 2000;

const isIsoDate = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

const normalizeDetails = details => {
  if (!Array.isArray(details) || details.length > MAX_BATCH_DETAILS) {
    throw Object.assign(new Error(`Batch details must contain at most ${MAX_BATCH_DETAILS} entries.`), { status: 400 });
  }

  const labels = new Set();
  return details.reduce((normalized, item) => {
    if (!item || typeof item.label !== 'string' || typeof item.value !== 'string') {
      throw Object.assign(new Error('Each batch detail requires a text label and value.'), { status: 400 });
    }
    const label = item.label.trim();
    const value = item.value.trim();
    if (!label || label.length > 100 || value.length > MAX_DETAIL_VALUE_LENGTH) {
      throw Object.assign(new Error('Batch detail labels must be 1–100 characters and values at most 2000 characters.'), { status: 400 });
    }
    if (!value) return normalized;

    const normalizedLabel = label.toLowerCase();
    if (labels.has(normalizedLabel)) {
      throw Object.assign(new Error(`Duplicate batch detail label: ${label}.`), { status: 400 });
    }
    labels.add(normalizedLabel);
    normalized.push({ label, value, visible: item.visible !== false });
    return normalized;
  }, []);
};

const createProductBatch = async ({ productId, count, prefix = 'BHMV', manufactureDate, expiryDate, details = [] }) => {
  const normalizedProductId = Number(productId);
  const normalizedCount = Number(count);
  const normalizedPrefix = String(prefix).trim().toUpperCase();

  if (!Number.isSafeInteger(normalizedProductId) || normalizedProductId < 1) {
    throw Object.assign(new Error('Choose a valid product.'), { status: 400 });
  }
  if (!Number.isSafeInteger(normalizedCount) || normalizedCount < 1 || normalizedCount > MAX_BATCH_SIZE) {
    throw Object.assign(new Error(`Batch quantity must be between 1 and ${MAX_BATCH_SIZE}.`), { status: 400 });
  }
  if (!/^[A-Z0-9]{2,8}$/.test(normalizedPrefix)) {
    throw Object.assign(new Error('Batch prefix must be 2–8 letters or numbers.'), { status: 400 });
  }
  if (!isIsoDate(manufactureDate) || !isIsoDate(expiryDate) || expiryDate <= manufactureDate) {
    throw Object.assign(new Error('Enter valid manufacture and expiry dates; expiry must be after manufacture.'), { status: 400 });
  }

  const normalizedDetails = normalizeDetails(details);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [products] = await connection.query(
      'SELECT id, name, sku FROM products WHERE id = ? FOR UPDATE',
      [normalizedProductId]
    );
    if (!products.length) {
      throw Object.assign(new Error('Product not found.'), { status: 404 });
    }

    const dateStamp = manufactureDate.slice(2, 4) + manufactureDate.slice(5, 7);
    let batchNumber;
    let batchResult;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      batchNumber = `${normalizedPrefix}-${dateStamp}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
      try {
        [batchResult] = await connection.query(
          `INSERT INTO product_batches
            (product_id, batch_number, manufacture_date, expiry_date, unit_count, details)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            normalizedProductId,
            batchNumber,
            manufactureDate,
            expiryDate,
            normalizedCount,
            JSON.stringify(normalizedDetails),
          ]
        );
        break;
      } catch (error) {
        if (error.code !== 'ER_DUP_ENTRY' || attempt === 4) throw error;
      }
    }

    const serials = new Set();
    while (serials.size < normalizedCount) {
      serials.add(`${normalizedPrefix}-${dateStamp}-${crypto.randomBytes(8).toString('hex').toUpperCase()}`);
    }

    const rows = [...serials].map(serial => [normalizedProductId, batchResult.insertId, serial, 0]);
    for (let offset = 0; offset < rows.length; offset += 500) {
      await connection.query(
        'INSERT INTO product_serials (product_id, batch_id, serial_number, is_legacy) VALUES ?',
        [rows.slice(offset, offset + 500)]
      );
    }

    await connection.commit();
    return {
      id: batchResult.insertId,
      productId: normalizedProductId,
      productName: products[0].name,
      sku: products[0].sku,
      batchNumber,
      manufactureDate,
      expiryDate,
      unitCount: normalizedCount,
      details: normalizedDetails,
      serials: [...serials],
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
};

const parseDetails = value => {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const details = JSON.parse(value);
    return Array.isArray(details) ? details : [];
  } catch {
    return [];
  }
};

const listProductBatches = async () => {
  const [rows] = await pool.query(`
    SELECT b.id, b.product_id, b.batch_number, b.manufacture_date, b.expiry_date,
           b.unit_count, b.details, b.created_at, p.name AS product_name, p.sku,
           (SELECT COUNT(*) FROM product_serials ps WHERE ps.batch_id = b.id) AS generated_count
    FROM product_batches b
    JOIN products p ON p.id = b.product_id
    ORDER BY b.created_at DESC, b.id DESC
  `);
  return rows.map(row => ({
    ...row,
    details: parseDetails(row.details),
    unit_count: Number(row.unit_count),
    generated_count: Number(row.generated_count),
  }));
};

const getProductBatch = async batchId => {
  const [batches] = await pool.query(
    `SELECT b.id, b.product_id, b.batch_number, b.manufacture_date, b.expiry_date,
            b.unit_count, b.details, b.created_at, p.name AS product_name, p.sku
     FROM product_batches b
     JOIN products p ON p.id = b.product_id
     WHERE b.id = ?`,
    [batchId]
  );
  if (!batches.length) return null;

  const [serialRows] = await pool.query(
    'SELECT serial_number, status FROM product_serials WHERE batch_id = ? ORDER BY id',
    [batchId]
  );
  return {
    ...batches[0],
    details: parseDetails(batches[0].details),
    serials: serialRows,
  };
};

const updateProductBatchDetails = async (batchId, details) => {
  const normalizedDetails = normalizeDetails(details);
  const [result] = await pool.query(
    'UPDATE product_batches SET details = ? WHERE id = ?',
    [JSON.stringify(normalizedDetails), batchId]
  );
  if (!result.affectedRows) {
    throw Object.assign(new Error('Batch not found.'), { status: 404 });
  }
  return normalizedDetails;
};

const getPublicProductVerification = async serial => {
  const cleanSerial = String(serial || '').trim().toUpperCase();
  if (!cleanSerial || cleanSerial.length > 255) {
    throw Object.assign(new Error('Enter a valid product code.'), { status: 400 });
  }

  const [rows] = await pool.query(
    `SELECT ps.serial_number, ps.status, b.id AS batch_id, b.batch_number,
            b.manufacture_date, b.expiry_date, b.unit_count, b.details,
            p.name AS product_name, p.sku,
            (SELECT pi.file_path FROM product_images pi
             WHERE pi.product_id = p.id ORDER BY pi.sort_order, pi.id LIMIT 1) AS image
     FROM product_serials ps
     JOIN product_batches b ON b.id = ps.batch_id
     JOIN products p ON p.id = ps.product_id
     WHERE ps.serial_number = ?
     LIMIT 1`,
    [cleanSerial]
  );
  if (!rows.length) return null;

  const row = rows[0];
  const expiryDate = typeof row.expiry_date === 'string'
    ? row.expiry_date.slice(0, 10)
    : new Date(row.expiry_date).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const cloudfrontBase = process.env.CLOUDFRONT_BASE_URL || '';
  const image = row.image
    ? (/^https?:\/\//i.test(row.image) || !cloudfrontBase
      ? row.image
      : `${cloudfrontBase.replace(/\/+$/, '')}/${row.image.replace(/^\/+/, '')}`)
    : null;

  return {
    verified: true,
    serialNumber: row.serial_number,
    productName: row.product_name,
    sku: row.sku,
    image,
    batchNumber: row.batch_number,
    manufactureDate: typeof row.manufacture_date === 'string'
      ? row.manufacture_date.slice(0, 10)
      : new Date(row.manufacture_date).toISOString().slice(0, 10),
    expiryDate,
    expired: expiryDate < today,
    batchQuantity: Number(row.unit_count),
    itemStatus: row.status,
    details: parseDetails(row.details).filter(detail => detail.visible !== false),
  };
};

module.exports = {
  MAX_BATCH_SIZE,
  createProductBatch,
  getProductBatch,
  getPublicProductVerification,
  listProductBatches,
  updateProductBatchDetails,
};
