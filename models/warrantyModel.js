const pool = require("../config/db");
require('dotenv').config();

const CLOUDFRONT_BASE_URL = process.env.CLOUDFRONT_BASE_URL || "";

const getISTDateString = () => {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(now.getTime() + istOffset);
  return istDate.toISOString().split('T')[0];
};

const parseDate = dateString => {
  if (typeof dateString !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateString)) return null;
  const date = new Date(`${dateString}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === dateString
    ? date
    : null;
};

const daysDiff = (dateStrA, dateStrB) => {
  const a = parseDate(dateStrA);
  const b = parseDate(dateStrB);
  if (!a || !b) return NaN;
  return Math.round((a - b) / (1000 * 60 * 60 * 24));
};

const addMonths = (dateStr, months) => {
  const date = parseDate(dateStr);
  if (!date) throw new Error('Cannot calculate warranty expiry from an invalid purchase date.');
  const targetMonth = date.getUTCMonth() + months;
  const firstOfTargetMonth = new Date(Date.UTC(date.getUTCFullYear(), targetMonth, 1));
  const lastDay = new Date(Date.UTC(
    firstOfTargetMonth.getUTCFullYear(),
    firstOfTargetMonth.getUTCMonth() + 1,
    0
  )).getUTCDate();
  firstOfTargetMonth.setUTCDate(Math.min(date.getUTCDate(), lastDay));
  return firstOfTargetMonth.toISOString().slice(0, 10);
};

const initWarrantyTable = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS warranty_registrations (
      id INT AUTO_INCREMENT PRIMARY KEY,
      registered_serial VARCHAR(255) NOT NULL,
      product_id INT NOT NULL,
      status ENUM('pending', 'accepted', 'rejected') DEFAULT 'pending',
      registered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const [foreignKeys] = await pool.query(
    `SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
       AND CONSTRAINT_NAME = ? AND CONSTRAINT_TYPE = 'FOREIGN KEY'`,
    ['warranty_registrations', 'fk_warranty_serial']
  );
  if (foreignKeys.length > 0) {
    await pool.query('ALTER TABLE warranty_registrations DROP FOREIGN KEY fk_warranty_serial');
  }

  const addCol = async (table, column, definition) => {
    const [columns] = await pool.query(`SHOW COLUMNS FROM \`${table}\` LIKE ?`, [column]);
    if (columns.length === 0) {
      await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
    }
  };

  await addCol('warranty_registrations', 'serial_number_id', 'INT AFTER registered_serial');
  await addCol('warranty_registrations', 'user_name', 'VARCHAR(255) AFTER product_id');
  await addCol('warranty_registrations', 'user_email', 'VARCHAR(255) AFTER user_name');
  await addCol('warranty_registrations', 'user_phone', 'VARCHAR(50) AFTER user_email');
  await addCol('warranty_registrations', 'purchase_date', 'DATE AFTER user_phone');
  await addCol('warranty_registrations', 'invoice_number', 'VARCHAR(100) AFTER purchase_date');
  await addCol('warranty_registrations', 'shop_name', 'VARCHAR(255) AFTER invoice_number');
  await addCol('warranty_registrations', 'registration_date', 'DATE NULL DEFAULT NULL AFTER shop_name');
  await addCol('warranty_registrations', 'warranty_end_date', 'DATE NULL DEFAULT NULL AFTER registration_date');
  await addCol('warranty_registrations', 'invoice_url', 'VARCHAR(500) NULL DEFAULT NULL AFTER warranty_end_date');
  await addCol('warranty_registrations', 'is_legacy', 'TINYINT(1) NOT NULL DEFAULT 1 AFTER invoice_url');
  await addCol('warranty_registrations', 'user_id', 'INT NULL AFTER id');
};

const validateSerial = async (serial) => {
  if (!serial) throw { status: 400, message: "Serial number is missing." };
  const s = String(serial).trim().toUpperCase();

  const [rows] = await pool.query(
    `SELECT ps.id AS serial_id, ps.product_id, ps.serial_number, ps.status,
            ps.base_warranty_months, ps.is_legacy,
            p.name AS product_name, p.brand, p.warranty_period,
            p.video_urls, p.product_links, p.model_3d_url, 
            c.id AS category_id, c.name AS category_name,
            wr.id AS registration_id, wr.user_name, wr.warranty_end_date, wr.shop_name, wr.purchase_date
     FROM product_serials ps
     JOIN products p ON ps.product_id = p.id
     JOIN categories c ON p.category_id = c.id
     LEFT JOIN warranty_registrations wr ON ps.serial_number = wr.registered_serial
     WHERE ps.serial_number = ?`,
    [s]
  ); 

  if (rows.length === 0) throw { status: 404, message: "Serial number not found in our database." };
  const rec = rows[0];
  const [imageRows] = await pool.query('SELECT file_path FROM product_images WHERE product_id = ?', [rec.product_id]);
  
  const cloudfront = process.env.CLOUDFRONT_BASE_URL || '';
  rec.images = imageRows.map((img) => cloudfront ? `${cloudfront}/${img.file_path}` : img.file_path);
  
  return rec;
};

const registerWarranty = async (data) => {
  const { serialNumber, serial, productId, userId, customerName, email, phone,
          purchaseDate, shopName, invoiceUrl } = data;
  const targetSerial = serialNumber || serial;
  const customerId = userId === undefined || userId === null ? null : Number(userId);

  if (!targetSerial) throw { status: 400, message: "Serial number is required." };
  if (!productId) throw { status: 400, message: "Product ID is required." };
  if (customerId !== null && (!Number.isSafeInteger(customerId) || customerId < 1)) {
    throw { status: 400, message: "User ID must be a positive integer." };
  }

  const rec = await validateSerial(targetSerial);

  if (Number(rec.product_id) !== Number(productId))
    throw { status: 400, message: "Product mismatch for given serial number." };
  if (rec.status === 'registered' || rec.status === 'sold')
    throw { status: 400, message: "This serial number is already registered for warranty." };

  const isLegacySerial = rec.is_legacy === 1 || rec.is_legacy === true;
  let registrationDate = null;
  let warrantyEndDate = null;

  if (!isLegacySerial) {
    if (!parseDate(purchaseDate)) {
      throw { status: 400, message: "Enter a valid purchase date using YYYY-MM-DD." };
    }

    registrationDate = getISTDateString();
    const diff = daysDiff(registrationDate, purchaseDate);

    if (diff < 0) throw { status: 400, message: "Purchase date cannot be in the future." };

    if (diff > 14) {
      throw {
        status: 400,
        message: "E-warranty has not been done within 14 days. Only a hard copy of the warranty will be eligible for this product."
      };
    }

    const totalMonths = (rec.base_warranty_months || rec.warranty_period || 12) + 1;
    warrantyEndDate = addMonths(purchaseDate, totalMonths);
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [serialRows] = await conn.query(
      'SELECT status FROM product_serials WHERE id = ? FOR UPDATE',
      [rec.serial_id]
    );
    if (!serialRows.length) {
      throw { status: 404, message: "Serial number not found in our database." };
    }
    if (serialRows[0].status === 'registered' || serialRows[0].status === 'sold') {
      throw { status: 409, message: "This serial number is already registered for warranty." };
    }

    const [result] = await conn.query(
      `INSERT INTO warranty_registrations
        (user_id, registered_serial, serial_number_id, product_id, user_name, user_email,
         user_phone, purchase_date, shop_name, registration_date, warranty_end_date,
         invoice_url, is_legacy, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted')`,
      [
        customerId, rec.serial_number, rec.serial_id, productId,
        customerName || null, email || null, phone || null,
        purchaseDate || null, shopName || null,
        registrationDate, warrantyEndDate,
        invoiceUrl || null,
        isLegacySerial ? 1 : 0
      ]
    );

    await conn.query(`UPDATE product_serials SET status = 'registered' WHERE serial_number = ?`, [rec.serial_number]);
    await conn.commit();

    return {
      registration_id: result.insertId,
      warranty_end_date: warrantyEndDate,
      registration_date: registrationDate,
      is_legacy: isLegacySerial
    };
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
};

const getAllRegistrations = async () => {
  const [rows] = await pool.query(
    `SELECT wr.*, p.name AS product_name
     FROM warranty_registrations wr
     JOIN products p ON wr.product_id = p.id
     ORDER BY wr.registered_at DESC`
  );
  return rows;
};

const updatGenuiine_testStatus = async (id, status) => {
  await pool.query('UPDATE warranty_registrations SET status = ? WHERE id = ?', [status, id]);
};

const deletGenuiine_test = async (id) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query('SELECT registered_serial FROM warranty_registrations WHERE id = ?', [id]);
    if (rows.length > 0)
      await conn.query("UPDATE product_serials SET status = 'available' WHERE serial_number = ?", [rows[0].registered_serial]);
    await conn.query('DELETE FROM warranty_registrations WHERE id = ?', [id]);
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
};

module.exports = {
  validateSerial,
  registerWarranty,
  getAllRegistrations,
  updatGenuiine_testStatus,
  deletGenuiine_test,
  initWarrantyTable
};
