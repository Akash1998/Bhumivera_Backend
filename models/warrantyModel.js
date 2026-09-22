const pool = require("../config/db");
require('dotenv').config();

const CLOUDFRONT_BASE_URL = process.env.CLOUDFRONT_BASE_URL || "";

const getISTDateString = () => {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(now.getTime() + istOffset);
  return istDate.toISOString().split('T')[0];
};

const daysDiff = (dateStrA, dateStrB) => {
  const a = new Date(dateStrA);
  const b = new Date(dateStrB);
  return Math.round((a - b) / (1000 * 60 * 60 * 24));
};

const addMonths = (dateStr, months) => {
  const d = new Date(dateStr);
  d.setMonth(d.getMonth() + months);
  return d.toISOString().split('T')[0];
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

  try {
    await pool.query(`ALTER TABLE warranty_registrations DROP FOREIGN KEY fk_warranty_serial`);
  } catch (e) {}

  const addCol = async (table, sql) => {
    try { await pool.query(`ALTER TABLE ${table} ADD COLUMN ${sql}`); } catch (e) {}
  };

  await addCol('warranty_registrations', 'serial_number_id INT AFTER registered_serial');
  await addCol('warranty_registrations', 'user_name VARCHAR(255) AFTER product_id');
  await addCol('warranty_registrations', 'user_email VARCHAR(255) AFTER user_name');
  await addCol('warranty_registrations', 'user_phone VARCHAR(50) AFTER user_email');
  await addCol('warranty_registrations', 'purchase_date DATE AFTER user_phone');
  await addCol('warranty_registrations', 'invoice_number VARCHAR(100) AFTER purchase_date');
  await addCol('warranty_registrations', 'shop_name VARCHAR(255) AFTER invoice_number');
  await addCol('warranty_registrations', 'registration_date DATE NULL DEFAULT NULL AFTER shop_name');
  await addCol('warranty_registrations', 'warranty_end_date DATE NULL DEFAULT NULL AFTER registration_date');
  await addCol('warranty_registrations', 'invoice_url VARCHAR(500) NULL DEFAULT NULL AFTER warranty_end_date');
  await addCol('warranty_registrations', 'is_legacy TINYINT(1) NOT NULL DEFAULT 1 AFTER invoice_url');
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
  await initWarrantyTable();

  const { serialNumber, serial, productId, customerName, email, phone,
          purchaseDate, shopName, invoiceUrl } = data;
  const targetSerial = serialNumber || serial;

  if (!targetSerial) throw { status: 400, message: "Serial number is required." };
  if (!productId) throw { status: 400, message: "Product ID is required." };

  const rec = await validateSerial(targetSerial);

  if (Number(rec.product_id) !== Number(productId))
    throw { status: 400, message: "Product mismatch for given serial number." };
  if (rec.status === 'registered' || rec.status === 'sold')
    throw { status: 400, message: "This serial number is already registered for warranty." };

  const isLegacySerial = rec.is_legacy === 1 || rec.is_legacy === true;
  let registrationDate = null;
  let warrantyEndDate = null;

  if (!isLegacySerial) {
    if (!purchaseDate) throw { status: 400, message: "Purchase date is required for e-warranty registration." };

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

    const [result] = await conn.query(
      `INSERT INTO warranty_registrations
        (registered_serial, serial_number_id, product_id, user_name, user_email,
         user_phone, purchase_date, shop_name, registration_date, warranty_end_date,
         invoice_url, is_legacy, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted')`,
      [
        rec.serial_number, rec.serial_id, productId,
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
  await initWarrantyTable();
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
