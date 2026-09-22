// backend/models/shippingModel
const pool = require('../config/db');

const createShippingTable = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shipping_zones (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      regions TEXT NOT NULL COMMENT 'Comma separated states/pincodes/zones',
      base_charge DECIMAL(10,2) NOT NULL DEFAULT 0,
      per_kg_charge DECIMAL(10,2) DEFAULT 0,
      free_above DECIMAL(10,2) DEFAULT NULL COMMENT 'Free shipping if order >= this amount',
      estimated_days VARCHAR(50) DEFAULT '3-5 days',
      is_active TINYINT(1) DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Seed a default zone
  await pool.query(`
    INSERT IGNORE INTO shipping_zones (id, name, regions, base_charge, free_above, estimated_days)
    VALUES (1, 'All India', 'All', 50.00, 500.00, '3-7 business days')
  `);
};

const getAllZones = async () => {
  const [rows] = await pool.query('SELECT * FROM shipping_zones ORDER BY name');
  return rows;
};

const getActiveZones = async () => {
  const [rows] = await pool.query('SELECT * FROM shipping_zones WHERE is_active = 1 ORDER BY name');
  return rows;
};

const getZoneById = async (id) => {
  const [rows] = await pool.query('SELECT * FROM shipping_zones WHERE id = ?', [id]);
  return rows[0];
};

const createZone = async (data) => {
  const { name, regions, base_charge, per_kg_charge, free_above, estimated_days } = data;
  const [result] = await pool.query(
    'INSERT INTO shipping_zones (name, regions, base_charge, per_kg_charge, free_above, estimated_days) VALUES (?, ?, ?, ?, ?, ?)',
    [name, regions, base_charge || 0, per_kg_charge || 0, free_above || null, estimated_days || '3-5 days']
  );
  return result.insertId;
};

const updateZone = async (id, data) => {
  const fields = Object.keys(data).map(k => `${k} = ?`).join(', ');
  const values = [...Object.values(data), id];
  await pool.query(`UPDATE shipping_zones SET ${fields} WHERE id = ?`, values);
};

const deleteZone = async (id) => {
  await pool.query('DELETE FROM shipping_zones WHERE id = ?', [id]);
};

// Calculate shipping charge for an order total
const calculateShipping = async (orderTotal, zoneId = 1) => {
  const zone = await getZoneById(zoneId);
  if (!zone || !zone.is_active) return { charge: 0, zone: null, message: 'No shipping zone found' };
  if (zone.free_above && orderTotal >= zone.free_above) {
    return { charge: 0, zone, message: 'Free shipping' };
  }
  return { charge: parseFloat(zone.base_charge), zone, message: `Standard shipping (${zone.estimated_days})` };
};

module.exports = { createShippingTable, getAllZones, getActiveZones, getZoneById, createZone, updateZone, deleteZone, calculateShipping };
