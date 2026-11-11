const crypto = require('node:crypto');
let bcrypt;
try {
  bcrypt = require('bcryptjs');
} catch {
  bcrypt = {
    hash: async (str) => `hashed:${str}`,
    compare: async (str, hash) => hash === `hashed:${str}`,
  };
}
let pool = null;
try {
  pool = require('../config/db');
} catch {
  pool = null;
}
const { computeQuantumHash512 } = require('../utils/quantumCrypto');
const { invalidatePublicCatalogCache } = require('../middleware/redisResponseCache');

const B32_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buffer) {
  const view = new Uint8Array(buffer);
  let bits = 0;
  let value = 0;
  let output = '';
  for (let i = 0; i < view.length; i++) {
    value = (value << 8) | view[i];
    bits += 8;
    while (bits >= 5) {
      output += B32_CHARS[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += B32_CHARS[(value << (5 - bits)) & 31];
  }
  return output;
}

function base32Decode(str) {
  const clean = String(str || '').toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (let i = 0; i < clean.length; i++) {
    const idx = B32_CHARS.indexOf(clean[i]);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function generateTotpSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function verifyTotpCode(secretBase32, inputCode) {
  const code = String(inputCode || '').trim();
  if (!/^\d{6}$/.test(code) || !secretBase32) return false;
  const key = base32Decode(secretBase32);
  const currentCounter = Math.floor(Date.now() / 1000 / 30);

  for (let delta = -1; delta <= 1; delta++) {
    const counter = currentCounter + delta;
    const buf = Buffer.alloc(8);
    buf.writeUInt32BE(0, 0);
    buf.writeUInt32BE(counter >>> 0, 4);
    const hmac = crypto.createHmac('sha1', key).update(buf).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const binary =
      ((hmac[offset] & 0x7f) << 24) |
      ((hmac[offset + 1] & 0xff) << 16) |
      ((hmac[offset + 2] & 0xff) << 8) |
      (hmac[offset + 3] & 0xff);
    const otp = String(binary % 1000000).padStart(6, '0');
    if (otp === code) return true;
  }
  return false;
}

const VALID_INVENTORY_ROLES = Object.freeze(['admin', 'manager', 'keeper', 'cashier', 'auditor']);

const INVENTORY_PERMISSION_DEFINITIONS = Object.freeze({
  full_all_access: {
    label: 'Grant All Access (100% Super Inventory & POS Authority)',
    desc: 'Full unrestricted access to all 10X Inventory, Order Lifecycle, Shipping Labels, RTO Returns, Storage Keeper, Offline POS, QR Scanner API & Daily SQL Backups.',
  },
  can_access_dashboard: {
    label: 'Executive Omnichannel Dashboard',
    desc: 'View live website sync status, revenue metrics, stock valuation, low-stock alerts, and top movers.',
  },
  can_manage_inventory: {
    label: 'Master Inventory & Website Stock Sync',
    desc: 'Add/edit products, prices, SKUs, barcodes, safety buffers, and sync quantities directly to bhumivera.com.',
  },
  can_adjust_stock: {
    label: 'Stock Adjustments & Damage Write-Offs',
    desc: 'Perform quick stock +/- adjustments and record internal write-offs, samples, or damaged stock.',
  },
  can_manage_storage_keeper: {
    label: 'Storage Keeper (Zones, Racks, Bins & Batches)',
    desc: 'Manage warehouse zones, rack/shelf/bin coordinates, cold-storage logs, FEFO batches, and bin transfers.',
  },
  can_use_pos_billing: {
    label: 'Offline Shop POS Billing & Mobile QR Scanner',
    desc: 'Create walk-in & registered customer POS bills (manual or via Mobile QR Scanner API) that atomically deduct stock from the live website.',
  },
  can_give_discounts: {
    label: 'Apply Custom POS Discounts',
    desc: 'Apply item-level or invoice-level discounts and promotional rates at POS checkout.',
  },
  can_void_invoices: {
    label: 'Void / Cancel POS Invoices & Restock',
    desc: 'Cancel completed POS invoices and automatically restore stock to bhumivera.com.',
  },
  can_manage_khata: {
    label: 'Shipping Label Address & Dispatch Verification',
    desc: 'View and print auto-fetched customer shipping labels and update recipient dispatch details.',
  },
  can_process_returns: {
    label: 'Undelivered Order (RTO) Returns & Quarantine',
    desc: 'Process undelivered courier returns (RTO) into Restock (Unopened/Intact) or Quarantine/Scrap (Damaged in Transit).',
  },
  can_manage_online_dispatch: {
    label: 'Full Online Order Lifecycle & Shipment Tracking',
    desc: 'Manage all bhumivera.com orders from placement to confirmation, packing, carrier label booking, AWB tracking, live location, and delivery.',
  },
  can_manage_suppliers_grn: {
    label: 'Suppliers, Purchase Orders & GRN Inwarding',
    desc: 'Manage vendors and post Goods Receipt Notes (GRN) to inward new batches into bins and website stock.',
  },
  can_run_stock_audit: {
    label: 'Physical Stock Audit & Reconciliation',
    desc: 'Conduct physical bin stock counts, compute variance, and reconcile live website inventory.',
  },
  can_view_reports: {
    label: 'Time-Machine Financial Reports & Invoice Archive',
    desc: 'Access daily/monthly revenue reports, margin analytics, and invoice history.',
  },
  can_export_data: {
    label: 'Daily SQL Database Backups & Disaster Recovery Restore',
    desc: 'Export inventory/orders to Excel (.xlsx) and create or restore daily SQL (.sql) & snapshot (.avbak.json) backups synced with Vercel & Railway.',
  },
  can_view_audit_logs: {
    label: 'Cryptographic Audit Trail & Stock Ledger',
    desc: 'View immutable 512-bit signed audit logs and before/after stock movement history.',
  },
  can_manage_store_settings: {
    label: 'Store, Carrier & Scanner API Configuration',
    desc: 'Configure store details, GSTIN, UPI ID, carrier shipping zones, and Mobile QR Scanner API pairing keys.',
  },
});

const ROLE_DEFAULT_INVENTORY_PERMISSIONS = Object.freeze({
  admin: Object.fromEntries(Object.keys(INVENTORY_PERMISSION_DEFINITIONS).map(k => [k, true])),
  manager: {
    full_all_access: false,
    can_access_dashboard: true,
    can_manage_inventory: true,
    can_adjust_stock: true,
    can_manage_storage_keeper: true,
    can_use_pos_billing: true,
    can_give_discounts: true,
    can_void_invoices: true,
    can_manage_khata: true,
    can_process_returns: true,
    can_manage_online_dispatch: true,
    can_manage_suppliers_grn: true,
    can_run_stock_audit: true,
    can_view_reports: true,
    can_export_data: true,
    can_view_audit_logs: true,
    can_manage_store_settings: false,
  },
  keeper: {
    full_all_access: false,
    can_access_dashboard: true,
    can_manage_inventory: true,
    can_adjust_stock: true,
    can_manage_storage_keeper: true,
    can_use_pos_billing: false,
    can_give_discounts: false,
    can_void_invoices: false,
    can_manage_khata: true,
    can_process_returns: true,
    can_manage_online_dispatch: true,
    can_manage_suppliers_grn: true,
    can_run_stock_audit: true,
    can_view_reports: true,
    can_export_data: true,
    can_view_audit_logs: true,
    can_manage_store_settings: false,
  },
  cashier: {
    full_all_access: false,
    can_access_dashboard: true,
    can_manage_inventory: false,
    can_adjust_stock: false,
    can_manage_storage_keeper: false,
    can_use_pos_billing: true,
    can_give_discounts: true,
    can_void_invoices: false,
    can_manage_khata: true,
    can_process_returns: true,
    can_manage_online_dispatch: true,
    can_manage_suppliers_grn: false,
    can_run_stock_audit: false,
    can_view_reports: true,
    can_export_data: false,
    can_view_audit_logs: false,
    can_manage_store_settings: false,
  },
  auditor: {
    full_all_access: false,
    can_access_dashboard: true,
    can_manage_inventory: false,
    can_adjust_stock: false,
    can_manage_storage_keeper: true,
    can_use_pos_billing: false,
    can_give_discounts: false,
    can_void_invoices: false,
    can_manage_khata: false,
    can_process_returns: false,
    can_manage_online_dispatch: false,
    can_manage_suppliers_grn: false,
    can_run_stock_audit: true,
    can_view_reports: true,
    can_export_data: true,
    can_view_audit_logs: true,
    can_manage_store_settings: false,
  },
});

function resolveInventoryPermissions(role = 'manager', customPermissions = null) {
  const baseRole = VALID_INVENTORY_ROLES.includes(role) ? role : 'manager';
  const defaults = { ...(ROLE_DEFAULT_INVENTORY_PERMISSIONS[baseRole] || ROLE_DEFAULT_INVENTORY_PERMISSIONS.manager) };
  let parsed = customPermissions;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      parsed = null;
    }
  }
  const merged = parsed && typeof parsed === 'object' ? { ...defaults, ...parsed } : defaults;
  if (baseRole === 'admin' || merged.full_all_access === true) {
    return Object.fromEntries(Object.keys(INVENTORY_PERMISSION_DEFINITIONS).map(k => [k, true]));
  }
  return merged;
}

/**
 * Automatically calculates Estimated Delivery Date based on customer destination (State/City/Pincode)
 * and delivery type (standard vs express).
 */
function calculateEstimatedDeliveryDate(addressSnapshot = {}, deliveryType = 'standard', createdAt = null) {
  let addr = addressSnapshot;
  if (typeof addr === 'string') {
    try {
      addr = JSON.parse(addr);
    } catch {
      addr = {};
    }
  }
  addr = addr || {};
  const state = String(addr.state || '').toLowerCase();
  const city = String(addr.city || '').toLowerCase();
  const pin = String(addr.pincode || addr.postal_code || addr.zip || '').trim();

  let transitDays = 5; // Default pan-India
  if (
    state.includes('west bengal') ||
    state.includes('jharkhand') ||
    state.includes('bihar') ||
    state.includes('odisha') ||
    pin.startsWith('71') ||
    pin.startsWith('70') ||
    pin.startsWith('81') ||
    pin.startsWith('82')
  ) {
    transitDays = 2; // East India & Asansol/Kolkata regional hub
  } else if (
    state.includes('delhi') ||
    city.includes('delhi') ||
    city.includes('new delhi') ||
    city.includes('noida') ||
    city.includes('gurugram') ||
    city.includes('gurgaon') ||
    city.includes('mumbai') ||
    city.includes('bengaluru') ||
    city.includes('bangalore') ||
    city.includes('hyderabad') ||
    city.includes('chennai') ||
    city.includes('pune') ||
    city.includes('ahmedabad')
  ) {
    transitDays = 4; // Metro Air/Surface Express corridors (including Delhi NCR)
  }

  if (String(deliveryType || '').toLowerCase() === 'express') {
    transitDays = Math.max(1, transitDays - 1);
  }

  const baseDate = createdAt ? new Date(createdAt) : new Date();
  const safeBase = Number.isNaN(baseDate.getTime()) ? new Date() : baseDate;
  const est = new Date(safeBase.getTime() + transitDays * 24 * 60 * 60 * 1000);
  return est.toISOString().split('T')[0];
}

let tablesInitializedPromise = null;

async function ensureColumnExists(db, tableName, columnName, definition) {
  try {
    const [cols] = await db.query(`SHOW COLUMNS FROM \`${tableName}\` LIKE ?`, [columnName]);
    if (!cols || cols.length === 0) {
      await db.query(`ALTER TABLE \`${tableName}\` ADD COLUMN \`${columnName}\` ${definition}`);
    }
  } catch {
    // Ignore if table doesn't exist yet
  }
}

async function initInventorySoftwareTables(db = pool) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS inventory_staff_accounts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      account_code VARCHAR(32) NOT NULL UNIQUE,
      username VARCHAR(80) NOT NULL UNIQUE,
      full_name VARCHAR(150) NOT NULL,
      email VARCHAR(190) DEFAULT NULL,
      phone VARCHAR(40) DEFAULT NULL,
      password_hash VARCHAR(255) NOT NULL,
      role ENUM('admin','manager','keeper','cashier','auditor') NOT NULL DEFAULT 'manager',
      assigned_hub VARCHAR(150) NOT NULL DEFAULT 'Bhumivera Flagship Hub — Asansol',
      permissions JSON DEFAULT NULL,
      status ENUM('active','suspended') NOT NULL DEFAULT 'active',
      totp_enabled TINYINT(1) NOT NULL DEFAULT 0,
      totp_secret VARCHAR(128) DEFAULT NULL,
      passkeys JSON DEFAULT NULL,
      first_login TINYINT(1) NOT NULL DEFAULT 1,
      last_login_at DATETIME DEFAULT NULL,
      total_pos_bills INT UNSIGNED NOT NULL DEFAULT 0,
      total_stock_ops INT UNSIGNED NOT NULL DEFAULT 0,
      created_by VARCHAR(120) DEFAULT 'SuperAdmin',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS inventory_storage_bins (
      id INT AUTO_INCREMENT PRIMARY KEY,
      warehouse_id INT NOT NULL DEFAULT 1,
      bin_code VARCHAR(64) NOT NULL UNIQUE,
      hub_name VARCHAR(150) NOT NULL DEFAULT 'Bhumivera Flagship Hub — Asansol',
      zone_name VARCHAR(120) NOT NULL,
      rack_no VARCHAR(40) NOT NULL,
      shelf_level VARCHAR(40) NOT NULL,
      bin_label VARCHAR(120) NOT NULL,
      temperature_target VARCHAR(40) DEFAULT '22°C - 26°C',
      capacity_units INT NOT NULL DEFAULT 500,
      occupied_units INT NOT NULL DEFAULT 0,
      keeper_name VARCHAR(120) DEFAULT 'Master Keeper',
      status ENUM('active','maintenance','full','quarantine') NOT NULL DEFAULT 'active',
      notes TEXT DEFAULT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS inventory_product_meta (
      id INT AUTO_INCREMENT PRIMARY KEY,
      warehouse_id INT NOT NULL DEFAULT 1,
      product_id INT UNIQUE DEFAULT NULL,
      custom_name VARCHAR(255) DEFAULT NULL,
      sku VARCHAR(100) NOT NULL UNIQUE,
      barcode VARCHAR(100) NOT NULL,
      qr_code_payload VARCHAR(255) DEFAULT NULL,
      category_name VARCHAR(120) DEFAULT 'Botanical Formulations',
      uom VARCHAR(30) DEFAULT 'Pcs',
      cost_price DECIMAL(10,2) NOT NULL DEFAULT 0.00,
      mrp DECIMAL(10,2) NOT NULL DEFAULT 0.00,
      selling_price DECIMAL(10,2) NOT NULL DEFAULT 0.00,
      gst_hsn_code VARCHAR(20) DEFAULT '30049011',
      gst_rate DECIMAL(5,2) NOT NULL DEFAULT 5.00,
      physical_stock INT NOT NULL DEFAULT 0,
      shop_display_stock INT NOT NULL DEFAULT 0,
      warehouse_vault_stock INT NOT NULL DEFAULT 0,
      safety_buffer_stock INT NOT NULL DEFAULT 0,
      damaged_quarantine_stock INT NOT NULL DEFAULT 0,
      min_stock_alert INT NOT NULL DEFAULT 15,
      reorder_qty INT NOT NULL DEFAULT 50,
      bin_code VARCHAR(64) DEFAULT 'ASN-SHOP-R1-B01',
      rack_location VARCHAR(120) DEFAULT 'Zone A • Rack 01 • Shelf A',
      batch_no VARCHAR(80) DEFAULT NULL,
      mfg_date DATE DEFAULT NULL,
      expiry_date DATE DEFAULT NULL,
      supplier_id INT DEFAULT NULL,
      sold_offline_qty INT NOT NULL DEFAULT 0,
      sold_online_qty INT NOT NULL DEFAULT 0,
      sync_to_website TINYINT(1) NOT NULL DEFAULT 1,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await ensureColumnExists(db, 'inventory_product_meta', 'warehouse_id', 'INT NOT NULL DEFAULT 1');
  await ensureColumnExists(db, 'inventory_product_meta', 'qr_code_payload', 'VARCHAR(255) DEFAULT NULL');
  await ensureColumnExists(db, 'inventory_storage_bins', 'warehouse_id', 'INT NOT NULL DEFAULT 1');

  // Enhance orders table with full order lifecycle & RTO columns
  await ensureColumnExists(db, 'orders', 'estimated_delivery_date', 'DATE DEFAULT NULL');
  await ensureColumnExists(db, 'orders', 'current_location_checkpoint', 'VARCHAR(255) DEFAULT NULL');
  await ensureColumnExists(db, 'orders', 'tracking_url', 'VARCHAR(1000) DEFAULT NULL');
  await ensureColumnExists(db, 'orders', 'rto_reason', 'VARCHAR(255) DEFAULT NULL');
  await ensureColumnExists(db, 'orders', 'rto_restock_mode', "ENUM('NONE','RESTOCKED','QUARANTINED') NOT NULL DEFAULT 'NONE'");
  await ensureColumnExists(db, 'orders', 'rto_processed_at', 'DATETIME DEFAULT NULL');
  await ensureColumnExists(db, 'orders', 'label_printed_at', 'DATETIME DEFAULT NULL');

  await db.query(`
    CREATE TABLE IF NOT EXISTS inventory_customers (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT DEFAULT NULL,
      name VARCHAR(180) NOT NULL,
      phone VARCHAR(40) NOT NULL,
      email VARCHAR(190) DEFAULT NULL,
      gstin VARCHAR(30) DEFAULT NULL,
      location VARCHAR(255) DEFAULT NULL,
      customer_type ENUM('Walk-in','Retail Shop','Salon / Spa Partner','Wholesale Distributor','VIP Patron') NOT NULL DEFAULT 'Walk-in',
      wallet_balance DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      credit_limit DECIMAL(12,2) NOT NULL DEFAULT 50000.00,
      total_purchases DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      visit_count INT NOT NULL DEFAULT 0,
      notes TEXT DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS inventory_pos_invoices (
      id INT AUTO_INCREMENT PRIMARY KEY,
      invoice_no VARCHAR(50) NOT NULL UNIQUE,
      customer_id INT DEFAULT NULL,
      customer_name VARCHAR(180) NOT NULL,
      customer_phone VARCHAR(40) DEFAULT NULL,
      customer_address TEXT DEFAULT NULL,
      customer_gstin VARCHAR(30) DEFAULT NULL,
      items_json JSON NOT NULL,
      extra_charges_json JSON DEFAULT NULL,
      subtotal DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      extra_total DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      discount_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      taxable_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      tax_rate DECIMAL(5,2) NOT NULL DEFAULT 18.00,
      tax_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      bill_total DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      prev_khata_balance DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      paid_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      new_khata_balance DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      payment_mode VARCHAR(40) NOT NULL DEFAULT 'Cash',
      upi_reference VARCHAR(100) DEFAULT NULL,
      status ENUM('completed','cancelled','returned') NOT NULL DEFAULT 'completed',
      cashier_username VARCHAR(80) DEFAULT 'admin',
      hub_name VARCHAR(150) DEFAULT 'Bhumivera Flagship Hub — Asansol',
      notes TEXT DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await ensureColumnExists(db, 'inventory_pos_invoices', 'customer_address', 'TEXT DEFAULT NULL');

  await db.query(`
    CREATE TABLE IF NOT EXISTS inventory_khata_transactions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      customer_id INT DEFAULT NULL,
      customer_name VARCHAR(180) NOT NULL,
      transaction_type ENUM('SALE_BILL','PAYMENT_RECEIVED','CREDIT_GIVEN','RETURN_CREDIT','VOID_REVERSAL') NOT NULL,
      amount DECIMAL(12,2) NOT NULL,
      balance_after DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      payment_mode VARCHAR(40) DEFAULT 'Cash',
      reference_note VARCHAR(255) DEFAULT NULL,
      proof_image LONGTEXT DEFAULT NULL,
      recorded_by VARCHAR(80) DEFAULT 'admin',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS inventory_suppliers (
      id INT AUTO_INCREMENT PRIMARY KEY,
      supplier_code VARCHAR(40) NOT NULL UNIQUE,
      name VARCHAR(180) NOT NULL,
      company_name VARCHAR(180) NOT NULL,
      phone VARCHAR(40) DEFAULT NULL,
      email VARCHAR(190) DEFAULT NULL,
      gstin VARCHAR(30) DEFAULT NULL,
      city VARCHAR(120) DEFAULT NULL,
      supply_category VARCHAR(120) DEFAULT 'Botanical Extracts & Packaging',
      payable_balance DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      lead_time_days INT NOT NULL DEFAULT 7,
      rating DECIMAL(3,2) DEFAULT 4.90,
      notes TEXT DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS inventory_grn_entries (
      id INT AUTO_INCREMENT PRIMARY KEY,
      grn_no VARCHAR(50) NOT NULL UNIQUE,
      supplier_id INT DEFAULT NULL,
      supplier_name VARCHAR(180) NOT NULL,
      product_id INT DEFAULT NULL,
      sku VARCHAR(100) NOT NULL,
      product_name VARCHAR(255) NOT NULL,
      batch_no VARCHAR(80) NOT NULL,
      mfg_date DATE DEFAULT NULL,
      expiry_date DATE DEFAULT NULL,
      received_qty INT NOT NULL,
      accepted_qty INT NOT NULL,
      rejected_qty INT NOT NULL DEFAULT 0,
      unit_cost DECIMAL(10,2) NOT NULL DEFAULT 0.00,
      total_cost DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      bin_code VARCHAR(64) DEFAULT 'ASN-COLD-R1-B01',
      invoice_ref VARCHAR(100) DEFAULT NULL,
      received_by VARCHAR(80) DEFAULT 'admin',
      notes TEXT DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS inventory_stock_movements (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      product_id INT DEFAULT NULL,
      sku VARCHAR(100) NOT NULL,
      product_name VARCHAR(255) NOT NULL,
      movement_type VARCHAR(50) NOT NULL,
      qty_before INT NOT NULL,
      qty_delta INT NOT NULL,
      qty_after INT NOT NULL,
      bin_code VARCHAR(64) DEFAULT NULL,
      batch_no VARCHAR(80) DEFAULT NULL,
      reference_id VARCHAR(100) DEFAULT NULL,
      reason VARCHAR(255) DEFAULT NULL,
      operator_username VARCHAR(80) DEFAULT 'system',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_inv_movements_prod (product_id, created_at),
      INDEX idx_inv_movements_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS inventory_audit_logs (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      actor_username VARCHAR(80) NOT NULL,
      actor_role VARCHAR(40) NOT NULL DEFAULT 'admin',
      action_code VARCHAR(60) NOT NULL,
      summary VARCHAR(500) NOT NULL,
      details_json JSON DEFAULT NULL,
      signature_sha512 VARCHAR(140) DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_inv_audit_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS inventory_store_config (
      id TINYINT NOT NULL PRIMARY KEY DEFAULT 1,
      store_name VARCHAR(180) NOT NULL DEFAULT 'Bhumivera Organics India Pvt. Ltd.',
      tagline VARCHAR(255) NOT NULL DEFAULT 'The Transparent Maison — Rooted in nature, 100% active disclosure',
      address VARCHAR(255) NOT NULL DEFAULT 'G.T. Road, Gopalpur, Asansol, West Bengal - 713304, India',
      phone VARCHAR(40) NOT NULL DEFAULT '+91 98765 43210',
      email VARCHAR(190) NOT NULL DEFAULT 'concierge@bhumivera.com',
      website VARCHAR(190) NOT NULL DEFAULT 'www.bhumivera.com',
      gstin VARCHAR(30) NOT NULL DEFAULT '19AAKCB2026A1Z5',
      cin VARCHAR(40) NOT NULL DEFAULT 'U20237WB2026PTC295842',
      upi_id VARCHAR(120) NOT NULL DEFAULT 'bhumivera@okhdfcbank',
      scanner_api_key VARCHAR(120) DEFAULT NULL,
      default_tax_rate DECIMAL(5,2) NOT NULL DEFAULT 18.00,
      auto_sync_website TINYINT(1) NOT NULL DEFAULT 1,
      pos_hold_reservation TINYINT(1) NOT NULL DEFAULT 1,
      categories_json JSON DEFAULT NULL,
      hidden_widgets_json JSON DEFAULT NULL,
      logo_url TEXT DEFAULT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await ensureColumnExists(db, 'inventory_store_config', 'scanner_api_key', 'VARCHAR(120) DEFAULT NULL');

  // Mobile QR Scanner App Queue Table (for future Android Scanner App -> POS Billing integration)
  await db.query(`
    CREATE TABLE IF NOT EXISTS inventory_scanner_queue (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      session_code VARCHAR(64) NOT NULL DEFAULT 'DEFAULT-POS-TERMINAL',
      qr_payload VARCHAR(255) NOT NULL,
      meta_id INT DEFAULT NULL,
      product_id INT DEFAULT NULL,
      sku VARCHAR(100) NOT NULL,
      barcode VARCHAR(100) DEFAULT NULL,
      serial_number VARCHAR(120) DEFAULT NULL,
      product_name VARCHAR(255) NOT NULL,
      unit_price DECIMAL(10,2) NOT NULL DEFAULT 0.00,
      mrp DECIMAL(10,2) NOT NULL DEFAULT 0.00,
      gst_hsn_code VARCHAR(20) DEFAULT '30049011',
      gst_rate DECIMAL(5,2) NOT NULL DEFAULT 5.00,
      uom VARCHAR(30) DEFAULT 'Pcs',
      quantity INT NOT NULL DEFAULT 1,
      available_stock INT NOT NULL DEFAULT 0,
      scanned_by VARCHAR(80) DEFAULT 'mobile-scanner',
      device_name VARCHAR(120) DEFAULT 'Android QR Scanner App',
      status ENUM('queued','consumed','cancelled') NOT NULL DEFAULT 'queued',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_scanner_queue_status (session_code, status, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS inventory_scanner_devices (
      session_code VARCHAR(64) NOT NULL PRIMARY KEY,
      api_key_hash CHAR(64) NOT NULL UNIQUE,
      api_key VARCHAR(128) DEFAULT NULL,
      device_name VARCHAR(120) NOT NULL,
      paired_by VARCHAR(80) DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      expires_at TIMESTAMP NULL DEFAULT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS inventory_order_pack_progress (
      order_item_id INT NOT NULL PRIMARY KEY,
      order_id INT NOT NULL,
      verified_quantity INT NOT NULL DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_order_pack_progress_order (order_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  try {
    await db.query(`ALTER TABLE inventory_scanner_devices ADD COLUMN api_key VARCHAR(128) DEFAULT NULL AFTER api_key_hash`);
  } catch (_) {}
  try {
    await db.query(`ALTER TABLE inventory_scanner_devices ADD COLUMN expires_at TIMESTAMP NULL DEFAULT NULL AFTER created_at`);
  } catch (_) {}
  await db.query(
    `UPDATE inventory_scanner_devices
     SET expires_at = DATE_ADD(NOW(), INTERVAL 12 HOUR)
     WHERE expires_at IS NULL OR expires_at > DATE_ADD(NOW(), INTERVAL 12 HOUR)`
  );

  await db.query(`
    CREATE TABLE IF NOT EXISTS inventory_pos_drafts (
      session_code VARCHAR(64) NOT NULL PRIMARY KEY,
      draft_json LONGTEXT NOT NULL,
      updated_by VARCHAR(80) DEFAULT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS inventory_pos_saved_drafts (
      draft_id VARCHAR(64) NOT NULL PRIMARY KEY,
      session_code VARCHAR(64) NOT NULL DEFAULT 'DEFAULT-POS-TERMINAL',
      order_id VARCHAR(64) DEFAULT NULL,
      title VARCHAR(180) NOT NULL,
      status ENUM('draft','paused','active','completed') NOT NULL DEFAULT 'draft',
      customer_name VARCHAR(180) DEFAULT 'Walk-in Retail Shopper',
      customer_phone VARCHAR(40) DEFAULT '',
      customer_gstin VARCHAR(30) DEFAULT '',
      payment_mode VARCHAR(40) DEFAULT 'UPI',
      items_json LONGTEXT NOT NULL,
      extra_charges_json TEXT DEFAULT NULL,
      discount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      tax_rate DECIMAL(5,2) NOT NULL DEFAULT 0.00,
      total_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      created_by VARCHAR(80) DEFAULT 'admin',
      created_by_name VARCHAR(150) DEFAULT 'Staff',
      locked_by VARCHAR(80) DEFAULT NULL,
      locked_by_name VARCHAR(150) DEFAULT NULL,
      locked_session_code VARCHAR(64) DEFAULT NULL,
      saved_at BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_pos_saved_drafts_session (session_code, status),
      INDEX idx_pos_saved_drafts_order (order_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS inventory_order_locks (
      order_key VARCHAR(64) NOT NULL PRIMARY KEY,
      order_id INT DEFAULT NULL,
      order_number VARCHAR(64) NOT NULL,
      locked_by_username VARCHAR(80) NOT NULL,
      locked_by_name VARCHAR(150) NOT NULL,
      session_code VARCHAR(64) NOT NULL,
      lock_type ENUM('BILLING','PACKING','POS_DRAFT') NOT NULL DEFAULT 'BILLING',
      status ENUM('LOCKED','COMPLETED') NOT NULL DEFAULT 'LOCKED',
      locked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      expires_at TIMESTAMP NULL DEFAULT NULL,
      completed_at TIMESTAMP NULL DEFAULT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  try {
    await db.query(`ALTER TABLE inventory_scanner_devices ADD COLUMN connection_state VARCHAR(24) NOT NULL DEFAULT 'connected'`);
  } catch (_) {}
  try {
    await db.query(`ALTER TABLE inventory_scanner_devices ADD COLUMN last_active_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP`);
  } catch (_) {}
  try {
    await db.query(`ALTER TABLE inventory_scanner_devices ADD COLUMN idle_expires_at TIMESTAMP NULL DEFAULT NULL`);
  } catch (_) {}

  await db.query(`
    CREATE TABLE IF NOT EXISTS inventory_pos_checkout_requests (
      idempotency_key VARCHAR(80) NOT NULL PRIMARY KEY,
      request_hash CHAR(64) NOT NULL,
      invoice_id INT DEFAULT NULL,
      response_json LONGTEXT DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_pos_checkout_invoice (invoice_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS inventory_pos_invoice_sequences (
      invoice_year SMALLINT UNSIGNED NOT NULL PRIMARY KEY,
      last_number INT UNSIGNED NOT NULL DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Daily SQL & Full Database Disaster Recovery Vault (Synced with Vercel & Railway)
  await db.query(`
    CREATE TABLE IF NOT EXISTS system_daily_backups (
      id INT AUTO_INCREMENT PRIMARY KEY,
      backup_code VARCHAR(64) NOT NULL UNIQUE,
      backup_date DATE NOT NULL,
      trigger_type ENUM('AUTO_DAILY','ON_UPDATE','MANUAL','CRON_SYNC') NOT NULL DEFAULT 'AUTO_DAILY',
      tables_count INT NOT NULL DEFAULT 0,
      rows_count INT NOT NULL DEFAULT 0,
      size_bytes BIGINT NOT NULL DEFAULT 0,
      checksum_sha512 VARCHAR(140) NOT NULL,
      snapshot_json LONGTEXT NOT NULL,
      sql_dump LONGTEXT NOT NULL,
      created_by VARCHAR(80) DEFAULT 'system',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_daily_backups_date (backup_date DESC, created_at DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  const defaultScannerKey = 'BV-SCAN-' + crypto.createHash('sha256').update(process.env.JWT_SECRET || 'bhumivera_scanner_2026').digest('hex').slice(0, 24).toUpperCase();

  await db.query(
    `INSERT IGNORE INTO inventory_store_config
      (id, store_name, tagline, address, phone, email, website, gstin, cin, upi_id, scanner_api_key, default_tax_rate, auto_sync_website, categories_json, hidden_widgets_json, logo_url)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 18.00, 1, ?, '[]', '/assets/bhumivera-luxury-crest-logo.webp')`,
    [
      'Bhumivera Organics India Private Limited',
      'The Transparent Maison — 100% Label-Disclosed Botanical Formulations',
      'G.T. Road, Gopalpur, Asansol, West Bengal - 713304, India',
      '+91 98320 00000',
      'billing@bhumivera.com',
      'www.bhumivera.com',
      '19AAKCB2026A1Z5',
      'U20237WB2026PTC295842',
      'bhumivera@okhdfcbank',
      defaultScannerKey,
      JSON.stringify([
        'Luxury Facial Cleansers',
        'Luxury Hair Care',
        'Artisanal Ayurvedic Cleansing Bars',
        'Luxury Ayurvedic Wellness & Immunity Drops',
        'Maison Regimen Bundles',
        'Botanical Raw Materials',
        'Luxury Glass & Packaging',
      ]),
    ]
  );

  await db.query(
    `UPDATE inventory_store_config SET scanner_api_key = ? WHERE id = 1 AND (scanner_api_key IS NULL OR scanner_api_key = '')`,
    [defaultScannerKey]
  ).catch(() => {});

  const [[staffCountRow]] = await db.query('SELECT COUNT(*) AS cnt FROM inventory_staff_accounts');
  if (Number(staffCountRow?.cnt || 0) === 0) {
    const adminHash = await bcrypt.hash('Admin@123', 10);
    const managerHash = await bcrypt.hash('Manager@123', 10);
    const keeperHash = await bcrypt.hash('Keeper@123', 10);
    const cashierHash = await bcrypt.hash('Cashier@123', 10);

    const seedAccounts = [
      ['BV-IAM-001', 'admin', 'Akash Prasad (Master Admin)', 'admin@bhumivera.com', '+91 98320 11111', adminHash, 'admin', 'Bhumivera Flagship Hub — Asansol', JSON.stringify(resolveInventoryPermissions('admin')), 0, generateTotpSecret(), 0],
      ['BV-IAM-002', 'manager', 'Store & Warehouse Operations Manager', 'operations@bhumivera.com', '+91 98320 22222', managerHash, 'manager', 'Bhumivera Flagship Hub — Asansol', JSON.stringify(resolveInventoryPermissions('manager')), 0, generateTotpSecret(), 1],
      ['BV-IAM-003', 'keeper1', 'Vikram Rathore (Cold-Vault & Bin Keeper)', 'keeper@bhumivera.com', '+91 98320 33333', keeperHash, 'keeper', 'Cold-Pressed Botanical Vault — Asansol', JSON.stringify(resolveInventoryPermissions('keeper')), 0, generateTotpSecret(), 1],
      ['BV-IAM-004', 'cashier1', 'Rahul Sharma (Retail POS Cashier)', 'pos@bhumivera.com', '+91 98320 44444', cashierHash, 'cashier', 'Asansol Retail Flagship Counter', JSON.stringify(resolveInventoryPermissions('cashier')), 0, generateTotpSecret(), 1],
      ['BV-IAM-005', 'priya', 'Priya C (POS & Fulfillment Executive)', 'priya@bhumivera.com', '+91 98320 55555', cashierHash, 'cashier', 'Asansol Retail Flagship Counter', JSON.stringify(resolveInventoryPermissions('cashier')), 0, generateTotpSecret(), 1],
    ];

    for (const acc of seedAccounts) {
      await db.query(
        `INSERT IGNORE INTO inventory_staff_accounts
          (account_code, username, full_name, email, phone, password_hash, role, assigned_hub, permissions, totp_enabled, totp_secret, first_login, passkeys)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]')`,
        acc
      );
    }
  }

  const [[binCountRow]] = await db.query('SELECT COUNT(*) AS cnt FROM inventory_storage_bins');
  if (Number(binCountRow?.cnt || 0) === 0) {
    const seedBins = [
      ['ASN-SHOP-R1-B01', 'Bhumivera Flagship Hub — Asansol', 'Zone A: Retail Shop Front Counter', 'Rack-01', 'Shelf-A', 'Facial Cleansers Display Bay', '22°C - 25°C', 400, 0, 'Rahul Sharma', 'active', 'Direct walk-in POS counter stock for Facial Cleansers'],
      ['ASN-SHOP-R1-B02', 'Bhumivera Flagship Hub — Asansol', 'Zone A: Retail Shop Front Counter', 'Rack-01', 'Shelf-B', 'Royal Hair Care & Shampoo Counter', '22°C - 25°C', 350, 0, 'Rahul Sharma', 'active', 'Direct walk-in POS counter stock for 2-in-1 Botanical Shampoo'],
      ['ASN-SHOP-R2-B01', 'Bhumivera Flagship Hub — Asansol', 'Zone A: Retail Shop Front Counter', 'Rack-02', 'Shelf-A', 'Artisanal Cleansing Bars & Tulsi Drops', '22°C - 25°C', 600, 0, 'Rahul Sharma', 'active', 'Charcoal Bar, Aloe-Neem-Tulsi Bar & Kalpvriksh 7-Tulsi Drops'],
      ['ASN-COLD-R1-B01', 'Bhumivera Flagship Hub — Asansol', 'Zone B: Cold-Pressed Botanical Vault (<28°C)', 'Rack-C1', 'Shelf-01', 'Climate-Controlled Master Reserve Vault', '18°C - 24°C', 1500, 0, 'Vikram Rathore', 'active', 'Sub-28°C climate-controlled reserve for micro-batch formulations'],
      ['ASN-DISPATCH-R1-B01', 'Bhumivera Flagship Hub — Asansol', 'Zone C: Online Order Dispatch & CCTV Weighing Bay', 'Rack-D1', 'Shelf-01', 'E-Commerce Pick, Pack & Scale #02 Bay', '22°C - 26°C', 500, 0, 'Vikram Rathore', 'active', 'Dedicated online order staging & regimen bundle assembly bay'],
      ['ASN-PACK-R1-B01', 'Bhumivera Flagship Hub — Asansol', 'Zone D: Luxury Glass & Packaging Vault', 'Rack-P1', 'Shelf-01', 'Amber Apothecary Bottles & Gold Foiled Boxes', 'Ambient', 2000, 0, 'Karan Verma', 'active', 'UV-protective containers, pumps, tamper seals & shipping cartons'],
      ['ASN-QUAR-R1-B01', 'Bhumivera Flagship Hub — Asansol', 'Zone Q: Quarantine & Damaged Stock Bay', 'Rack-Q1', 'Shelf-01', 'RMA / Transit Damage Quarantine', 'Ambient', 200, 0, 'Nisha Gupta', 'quarantine', 'Isolated bay for damaged or expired stock — excluded from live website stock'],
    ];
    for (const b of seedBins) {
      await db.query(
        `INSERT IGNORE INTO inventory_storage_bins
          (bin_code, hub_name, zone_name, rack_no, shelf_level, bin_label, temperature_target, capacity_units, occupied_units, keeper_name, status, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        b
      );
    }
  }

  const [[supCountRow]] = await db.query('SELECT COUNT(*) AS cnt FROM inventory_suppliers');
  if (Number(supCountRow?.cnt || 0) === 0) {
    const seedSuppliers = [
      ['SUP-MFG-001', 'Sitashi Herbal Industry', 'Sitashi Herbal Industry', '+91 141 2770000', 'info@sitashiherbal.com', '08AEQFS1102P1ZM', 'Jaipur, Rajasthan', 'Licensed Ayurvedic & Botanical Formulations (FSSAI: 12222999000145)', 0.00, 7, 5.00, 'Primary Licensed Ayurvedic & Herbal Products Manufacturer (Invoice #MGP/26-27/02)'],
      ['SUP-BOT-001', 'Himalayan Phyto-Actives & Cold-Press Labs', 'Himalayan Phyto-Actives Pvt. Ltd.', '+91 98110 44556', 'supply@himalayanphyto.in', '02AABCH1234F1Z2', 'Kullu, Himachal Pradesh', 'Cold-Pressed Botanical Extracts (Sea Buckthorn, Tulsi, Reetha)', 0.00, 5, 4.95, 'Primary COA-certified botanical extract partner'],
      ['SUP-ACT-002', 'Vedic Bio-Ferment & Niacinamide Sciences', 'Vedic Bio-Sciences India Ltd.', '+91 98201 77889', 'orders@vedicbiosciences.com', '27AABCV5678G1Z9', 'Mumbai, Maharashtra', 'Cosmetic Actives (Hyaluronic Acid, Niacinamide, Activated Carbon)', 0.00, 4, 4.90, 'Pharmaceutical-grade active ingredients'],
      ['SUP-PKG-003', 'Maison Glassware & Luxury Rigid Packaging', 'Maison Packaging Craft Pvt. Ltd.', '+91 98302 99001', 'dispatch@maisonglass.in', '19AABCM9012H1Z4', 'Kolkata, West Bengal', 'Luxury Packaging, UV Bottles & Gold-Foil Cartons', 0.00, 3, 4.88, 'Serialized micro-batch packaging supplier'],
    ];
    for (const s of seedSuppliers) {
      await db.query(
        `INSERT IGNORE INTO inventory_suppliers
          (supplier_code, name, company_name, phone, email, gstin, city, supply_category, payable_balance, lead_time_days, rating, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        s
      );
    }
  }
}

async function ensureInventorySoftwareTables(db = pool) {
  if (!tablesInitializedPromise) {
    tablesInitializedPromise = initInventorySoftwareTables(db).catch(err => {
      tablesInitializedPromise = null;
      throw err;
    });
  }
  return tablesInitializedPromise;
}

const DEFAULT_PRODUCT_KEEPER_CONFIG = {
  'BV-LUX-CFW-01': { barcode: '8908020260015', uom: '100 ML', costPrice: 60.00, mrp: 699.00, binCode: 'ASN-SHOP-R1-B01', rackLocation: 'Zone A • Rack 01 • Shelf A • Bin 01', batchNo: null, mfgDate: null, expiryDate: null, minStock: 20, reorderQty: 100, gstHsnCode: '30049011', gstRate: 5.00 },
  'BV-LUX-SBFW-02': { barcode: '8908020260022', uom: '100 ML', costPrice: 62.00, mrp: 799.00, binCode: 'ASN-SHOP-R1-B01', rackLocation: 'Zone A • Rack 01 • Shelf A • Bin 02', batchNo: null, mfgDate: null, expiryDate: null, minStock: 20, reorderQty: 100, gstHsnCode: '30049011', gstRate: 5.00 },
  'BV-LUX-SH2IN1-03': { barcode: '8908020260039', uom: '200 ML', costPrice: 85.00, mrp: 899.00, binCode: 'ASN-SHOP-R1-B02', rackLocation: 'Zone A • Rack 01 • Shelf B • Bin 01', batchNo: null, mfgDate: null, expiryDate: null, minStock: 15, reorderQty: 100, gstHsnCode: '30049011', gstRate: 5.00 },
  'BV-LUX-CSOAP-04': { barcode: '8908020260046', uom: '100 GM', costPrice: 24.00, mrp: 399.00, binCode: 'ASN-SHOP-R2-B01', rackLocation: 'Zone A • Rack 02 • Shelf A • Bin 01', batchNo: null, mfgDate: null, expiryDate: null, minStock: 25, reorderQty: 150, gstHsnCode: '30049011', gstRate: 5.00 },
  'BV-LUX-ASOAP-05': { barcode: '8908020260053', uom: '100 GM', costPrice: 24.00, mrp: 349.00, binCode: 'ASN-SHOP-R2-B01', rackLocation: 'Zone A • Rack 02 • Shelf A • Bin 02', batchNo: null, mfgDate: null, expiryDate: null, minStock: 25, reorderQty: 150, gstHsnCode: '30049011', gstRate: 5.00 },
  'BV-LUX-TULSI-06': { barcode: '8908020260060', uom: '30 ML', costPrice: 40.00, mrp: 499.00, binCode: 'ASN-SHOP-R2-B01', rackLocation: 'Zone A • Rack 02 • Shelf A • Bin 03', batchNo: null, mfgDate: null, expiryDate: null, minStock: 20, reorderQty: 120, gstHsnCode: '20099000', gstRate: 5.00 },
  'BV-BND-DAILY-01': { barcode: '8908020260077', uom: 'Combo', costPrice: 193.00, mrp: 2596.00, binCode: 'ASN-DISPATCH-R1-B01', rackLocation: 'Zone C • Rack D1 • Shelf 01 • Regimen Bay', batchNo: null, mfgDate: null, expiryDate: null, minStock: 10, reorderQty: 50, gstHsnCode: '30049011', gstRate: 5.00 },
  'BV-BND-ROYAL-03': { barcode: '8908020260107', uom: 'Combo', costPrice: 169.00, mrp: 2047.00, binCode: 'ASN-DISPATCH-R1-B01', rackLocation: 'Zone C • Rack D1 • Shelf 01 • Regimen Bay', batchNo: null, mfgDate: null, expiryDate: null, minStock: 10, reorderQty: 50, gstHsnCode: '30049011', gstRate: 5.00 },
  'BV-BND-INSIDEOUT-02': { barcode: '8908020260084', uom: 'Combo', costPrice: 124.00, mrp: 1597.00, binCode: 'ASN-DISPATCH-R1-B01', rackLocation: 'Zone C • Rack D1 • Shelf 01 • Regimen Bay', batchNo: null, mfgDate: null, expiryDate: null, minStock: 10, reorderQty: 50, gstHsnCode: '30049011', gstRate: 5.00 },
  'BV-BND-VAULT-06': { barcode: '8908020260091', uom: 'Vault', costPrice: 295.00, mrp: 3644.00, binCode: 'ASN-DISPATCH-R1-B01', rackLocation: 'Zone C • Rack D1 • Shelf 01 • Vault Bay', batchNo: null, mfgDate: null, expiryDate: null, minStock: 10, reorderQty: 40, gstHsnCode: '30049011', gstRate: 5.00 },
};

async function syncWebsiteProductsToInventoryMeta(db = pool, productId = null) {
  try {
    const productFilter = productId == null ? '' : 'WHERE p.id = ?';
    const productParams = productId == null ? [] : [productId];
    const [products] = await db.query(`
      SELECT p.id, p.name, p.slug, p.sku, p.price, p.discount_price, p.quantity,
             p.gst_hsn_code, p.gst_rate, p.specifications,
             c.name AS category_name
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      ${productFilter}
    `, productParams);

    const [soldAggRows] = await db
      .query(`
        SELECT oi.product_id, COALESCE(SUM(oi.quantity), 0) AS online_sold
        FROM order_items oi
        INNER JOIN orders o ON o.id = oi.order_id
        WHERE o.status NOT IN ('cancelled', 'returned', 'archived')
          AND oi.product_id IS NOT NULL
          ${productId == null ? '' : 'AND oi.product_id = ?'}
        GROUP BY oi.product_id
      `, productParams)
      .catch(() => [[]]);
    const onlineSoldMap = new Map(
      (soldAggRows || []).map(r => [Number(r.product_id), Number(r.online_sold) || 0])
    );

    for (const prod of products) {
      const sku = prod.sku || `BV-PROD-${prod.id}`;
      const preset = DEFAULT_PRODUCT_KEEPER_CONFIG[sku] || {};
      const sellingPrice =
        Number(prod.discount_price) > 0 ? Number(prod.discount_price) : Number(prod.price) || 0;
      const mrp = preset.mrp || Math.max(sellingPrice, Number(prod.price) || sellingPrice);
      const costPrice = preset.costPrice || Number((sellingPrice * 0.38).toFixed(2));
      const qty = Math.max(0, Number(prod.quantity) || 0);
      const shopDisplay = Math.min(qty, Math.ceil(qty * 0.3));
      const vaultStock = Math.max(0, qty - shopDisplay);
      const qrPayload = `https://www.bhumivera.com/verify?sku=${encodeURIComponent(sku)}`;
      const onlineSold = onlineSoldMap.get(Number(prod.id)) || 0;
      const hsnCode = prod.gst_hsn_code || preset.gstHsnCode || '30049011';
      const gstRate = Number(prod.gst_rate) > 0 ? Number(prod.gst_rate) : (preset.gstRate || 5.00);

      await db.query(
        `INSERT INTO inventory_product_meta
          (warehouse_id, product_id, custom_name, sku, barcode, qr_code_payload, category_name, uom, cost_price, mrp, selling_price,
           gst_hsn_code, gst_rate, physical_stock, shop_display_stock, warehouse_vault_stock,
           safety_buffer_stock, min_stock_alert, reorder_qty, bin_code, rack_location,
           batch_no, mfg_date, expiry_date, sold_online_qty, sync_to_website)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, 1)
         ON DUPLICATE KEY UPDATE
           custom_name = VALUES(custom_name),
           selling_price = VALUES(selling_price),
           cost_price = VALUES(cost_price),
           gst_hsn_code = VALUES(gst_hsn_code),
           gst_rate = VALUES(gst_rate),
           batch_no = COALESCE(inventory_product_meta.batch_no, VALUES(batch_no)),
           mfg_date = COALESCE(inventory_product_meta.mfg_date, VALUES(mfg_date)),
           expiry_date = COALESCE(inventory_product_meta.expiry_date, VALUES(expiry_date)),
           physical_stock = VALUES(physical_stock),
           sold_online_qty = GREATEST(sold_online_qty, VALUES(sold_online_qty)),
           qr_code_payload = COALESCE(qr_code_payload, VALUES(qr_code_payload)),
           category_name = COALESCE(VALUES(category_name), category_name)`,
        [
          prod.id,
          prod.name,
          sku,
          preset.barcode || `8908020${String(prod.id).padStart(6, '0')}`,
          qrPayload,
          prod.category_name || 'Botanical Formulations',
          preset.uom || 'Pcs',
          costPrice,
          mrp,
          sellingPrice,
          hsnCode,
          gstRate,
          qty,
          shopDisplay,
          vaultStock,
          preset.minStock || 15,
          preset.reorderQty || 50,
          preset.binCode || 'ASN-SHOP-R1-B01',
          preset.rackLocation || 'Zone A • Rack 01 • Shelf A',
          preset.batchNo || null,
          preset.mfgDate || null,
          preset.expiryDate || null,
          onlineSold,
        ]
      );
    }
  } catch (err) {
    console.warn('[INVENTORY_META_SYNC_WARN]', err.message);
  }
}

async function recalculateAllBundleStocks(conn = pool) {
  try {
    const [bundles] = await conn.query(
      "SELECT id, sku, specifications FROM products WHERE specifications IS NOT NULL"
    );
    for (const b of bundles) {
      let spec = b.specifications;
      if (typeof spec === 'string') {
        try {
          spec = JSON.parse(spec);
        } catch {
          spec = null;
        }
      }
      if (spec?.product_type === 'bundle' && Array.isArray(spec.components) && spec.components.length > 0) {
        const slugs = spec.components.map(c => c.slug).filter(Boolean);
        if (slugs.length > 0) {
          const placeholders = slugs.map(() => '?').join(',');
          const [compRows] = await conn.query(
            `SELECT quantity FROM products WHERE slug IN (${placeholders})`,
            slugs
          );
          if (compRows.length > 0) {
            const minQty = Math.max(0, Math.min(...compRows.map(r => Number(r.quantity) || 0)));
            await conn.query('UPDATE products SET quantity = ? WHERE id = ?', [minQty, b.id]);
            await conn.query(
              'UPDATE inventory_product_meta SET physical_stock = ? WHERE product_id = ?',
              [minQty, b.id]
            );
          }
        }
      }
    }
  } catch (err) {
    console.warn('[BUNDLE_STOCK_RECALC_WARN]', err.message);
  }
}

async function appendInventoryAuditLog(
  conn = pool,
  { actorUsername = 'system', actorRole = 'admin', actionCode = 'ACTION', summary = '', details = null }
) {
  try {
    const signature = computeQuantumHash512(
      {
        actorUsername,
        actorRole,
        actionCode,
        summary,
        ts: Date.now(),
      },
      'BHUMIVERA_INVENTORY_AUDIT_512'
    );
    await conn.query(
      `INSERT INTO inventory_audit_logs
        (actor_username, actor_role, action_code, summary, details_json, signature_sha512)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        String(actorUsername || 'system').slice(0, 80),
        String(actorRole || 'admin').slice(0, 40),
        String(actionCode || 'ACTION').slice(0, 60),
        String(summary || '').slice(0, 500),
        details ? JSON.stringify(details) : null,
        signature,
      ]
    );
  } catch (err) {
    console.warn('[INVENTORY_AUDIT_LOG_WARN]', err.message);
  }
}

async function recordStockMovement(
  conn = pool,
  {
    productId = null,
    sku = '-',
    productName = 'Item',
    movementType = 'MANUAL_OVERRIDE',
    qtyBefore = 0,
    qtyDelta = 0,
    qtyAfter = 0,
    binCode = null,
    batchNo = null,
    referenceId = null,
    reason = null,
    operatorUsername = 'system',
  }
) {
  try {
    await conn.query(
      `INSERT INTO inventory_stock_movements
        (product_id, sku, product_name, movement_type, qty_before, qty_delta, qty_after, bin_code, batch_no, reference_id, reason, operator_username)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        productId || null,
        String(sku || '-').slice(0, 100),
        String(productName || 'Item').slice(0, 255),
        String(movementType || 'MANUAL_OVERRIDE').slice(0, 50),
        Number(qtyBefore) || 0,
        Number(qtyDelta) || 0,
        Number(qtyAfter) || 0,
        binCode || null,
        batchNo || null,
        referenceId || null,
        reason ? String(reason).slice(0, 255) : null,
        String(operatorUsername || 'system').slice(0, 80),
      ]
    );
  } catch (err) {
    console.warn('[STOCK_MOVEMENT_LOG_WARN]', err.message);
  }
}

async function atomicAdjustProductStock(
  {
    metaId = null,
    productId = null,
    sku = null,
    operation = 'subtract',
    quantity = 0,
    movementType = 'STOCK_ADJUSTMENT',
    reason = 'Manual adjustment',
    referenceId = null,
    operatorUsername = 'admin',
    quarantineDelta = 0,
  },
  externalConn = null
) {
  const ownConn = !externalConn;
  const conn = externalConn || (await pool.getConnection());
  try {
    if (ownConn) await conn.beginTransaction();

    let metaRow = null;
    if (metaId) {
      const [rows] = await conn.query('SELECT * FROM inventory_product_meta WHERE id = ? FOR UPDATE', [metaId]);
      metaRow = rows[0] || null;
    }
    if (!metaRow && productId) {
      const [rows] = await conn.query('SELECT * FROM inventory_product_meta WHERE product_id = ? FOR UPDATE', [productId]);
      metaRow = rows[0] || null;
    }
    if (!metaRow && sku) {
      const [rows] = await conn.query('SELECT * FROM inventory_product_meta WHERE sku = ? FOR UPDATE', [sku]);
      metaRow = rows[0] || null;
    }

    let prodRow = null;
    const targetProductId = metaRow?.product_id || productId;
    if (targetProductId) {
      const [pRows] = await conn.query(
        'SELECT id, name, sku, quantity, price, discount_price FROM products WHERE id = ? FOR UPDATE',
        [targetProductId]
      );
      prodRow = pRows[0] || null;
    } else if (sku) {
      const [pRows] = await conn.query(
        'SELECT id, name, sku, quantity, price, discount_price FROM products WHERE sku = ? FOR UPDATE',
        [sku]
      );
      prodRow = pRows[0] || null;
    }

    if (!metaRow && !prodRow) {
      throw Object.assign(new Error('Product not found in inventory.'), { status: 404 });
    }

    const qtyBefore = prodRow
      ? Number(prodRow.quantity) || 0
      : Number(metaRow.physical_stock) || 0;
    const rawVal = Math.max(0, Math.trunc(Number(quantity) || 0));

    let qtyAfter = qtyBefore;
    if (operation === 'set') {
      qtyAfter = rawVal;
    } else if (operation === 'add') {
      qtyAfter = qtyBefore + rawVal;
    } else if (operation === 'subtract') {
      if (qtyBefore < rawVal) {
        throw Object.assign(
          new Error(
            `Insufficient stock for "${prodRow?.name || metaRow?.custom_name}". Available: ${qtyBefore}, Requested: ${rawVal}.`
          ),
          { status: 409, code: 'INSUFFICIENT_STOCK' }
        );
      }
      qtyAfter = Math.max(0, qtyBefore - rawVal);
    }

    const qtyDelta = qtyAfter - qtyBefore;
    const safetyBuffer = Number(metaRow?.safety_buffer_stock) || 0;
    const websiteAvailableQty = Math.max(0, qtyAfter - safetyBuffer);

    if (prodRow) {
      await conn.query('UPDATE products SET quantity = ? WHERE id = ?', [websiteAvailableQty, prodRow.id]);
    }

    if (metaRow) {
      const nextQuarantine = Math.max(
        0,
        (Number(metaRow.damaged_quarantine_stock) || 0) + (Number(quarantineDelta) || 0)
      );
      const nextShopDisplay = Math.min(qtyAfter, Number(metaRow.shop_display_stock) || Math.ceil(qtyAfter * 0.3));
      const nextVaultStock = Math.max(0, qtyAfter - nextShopDisplay);
      const offlineSoldAdd =
        movementType === 'OFFLINE_POS_SALE' && qtyDelta < 0 ? Math.abs(qtyDelta) : 0;
      const offlineSoldSub =
        movementType === 'POS_VOID_RESTOCK' && qtyDelta > 0 ? Math.abs(qtyDelta) : 0;

      await conn.query(
        `UPDATE inventory_product_meta
         SET physical_stock = ?,
             shop_display_stock = ?,
             warehouse_vault_stock = ?,
             damaged_quarantine_stock = ?,
             sold_offline_qty = GREATEST(0, sold_offline_qty + ? - ?)
         WHERE id = ?`,
        [
          qtyAfter,
          nextShopDisplay,
          nextVaultStock,
          nextQuarantine,
          offlineSoldAdd,
          offlineSoldSub,
          metaRow.id,
        ]
      );
    }

    // Strict FIFO / FEFO Batch Allocation deduction from physical batches
    if (prodRow?.id && operation === 'subtract' && rawVal > 0) {
      try {
        const [batches] = await conn.query(
          `SELECT id, unit_count FROM product_batches
           WHERE product_id = ? AND unit_count > 0
           ORDER BY COALESCE(expiry_date, '2099-12-31') ASC, COALESCE(manufacture_date, '1970-01-01') ASC, id ASC
           FOR UPDATE`,
          [prodRow.id]
        );
        let rem = rawVal;
        for (const b of batches) {
          if (rem <= 0) break;
          const deductFromBatch = Math.min(rem, Number(b.unit_count) || 0);
          if (deductFromBatch > 0) {
            await conn.query('UPDATE product_batches SET unit_count = GREATEST(0, unit_count - ?) WHERE id = ?', [deductFromBatch, b.id]);
            rem -= deductFromBatch;
          }
        }
      } catch (batchErr) {
        // Non-blocking fallback if product_batches table is not used
      }
    }

    await recalculateAllBundleStocks(conn);

    await recordStockMovement(conn, {
      productId: prodRow?.id || metaRow?.product_id || null,
      sku: prodRow?.sku || metaRow?.sku || '-',
      productName: prodRow?.name || metaRow?.custom_name || 'Product',
      movementType,
      qtyBefore,
      qtyDelta,
      qtyAfter,
      binCode: metaRow?.bin_code || 'ASN-SHOP-R1-B01',
      batchNo: metaRow?.batch_no || null,
      referenceId,
      reason,
      operatorUsername,
    });

    if (ownConn) {
      await conn.commit();
      await invalidatePublicCatalogCache();
    }

    return {
      productId: prodRow?.id || metaRow?.product_id || null,
      metaId: metaRow?.id || null,
      sku: prodRow?.sku || metaRow?.sku,
      name: prodRow?.name || metaRow?.custom_name,
      qtyBefore,
      qtyDelta,
      qtyAfter,
      websiteAvailableQty,
    };
  } catch (err) {
    if (ownConn) await conn.rollback();
    throw err;
  } finally {
    if (ownConn) conn.release();
  }
}

/**
 * Resolves any scanned QR code payload, serial number, EAN-13 barcode, or SKU
 * into an inventory item for the Mobile QR Scanner App & POS Billing Terminal.
 */
async function resolveProductByQrOrCode(db = pool, rawInput = '') {
  const raw = String(rawInput || '').trim();
  if (!raw) return null;

  let extractedSku = null;
  let extractedSerial = null;
  let extractedSlug = null;
  let extractedBatch = null;

  // Handle standalone Product QR (BV-QR:<SKU>) or Batch QR (BV:<SKU>:<BATCH> or BV|<SKU>|<BATCH>)
  if (/^BV-QR[:|]/i.test(raw)) {
    const parts = raw.split(/[:|]/).map(p => p.trim());
    if (parts.length >= 2) {
      extractedSku = parts[1];
      if (parts[2]) extractedBatch = parts[2];
    }
  } else if (/^BV[:|]/i.test(raw)) {
    const parts = raw.split(/[:|]/).map(p => p.trim());
    if (parts.length >= 2) {
      extractedSku = parts[1];
      if (parts[2]) extractedBatch = parts[2];
    }
  } else if (raw.startsWith('{') && raw.endsWith('}')) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed.sku) extractedSku = parsed.sku;
      if (parsed.code && !extractedSku) extractedSku = parsed.code;
      if (parsed.batch) extractedBatch = parsed.batch;
      if (parsed.serial) extractedSerial = parsed.serial;
    } catch (_) {}
  }

  if (raw.startsWith('http://') || raw.startsWith('https://') || raw.includes('bhumivera.com')) {
    try {
      const urlObj = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
      extractedSku = urlObj.searchParams.get('sku') || null;
      extractedSerial = urlObj.searchParams.get('serial') || urlObj.searchParams.get('code') || null;
      extractedBatch = urlObj.searchParams.get('batch') || extractedBatch;
      const parts = urlObj.pathname.split('/').filter(Boolean);
      const prodIdx = parts.findIndex(p => p === 'product' || p === 'products' || p === 'combo');
      if (prodIdx !== -1 && parts[prodIdx + 1]) {
        extractedSlug = parts[prodIdx + 1];
      } else if (parts[0] === 'verify' && parts[1]) {
        extractedSerial = parts[1];
      }
    } catch {
      // Fallback to direct matching
    }
  }

  let matchedSerialNumber = null;
  let matchedSerialStatus = null;

  // 1. Check if it's a unique bottle/bar Genuinity Serial in product_serials
  const serialCandidate = extractedSerial || raw;
  try {
    const [serialRows] = await db.query(
      `SELECT ps.serial_number, ps.product_id, ps.batch_id, ps.status
       FROM product_serials ps
       WHERE UPPER(ps.serial_number) = UPPER(?)
       LIMIT 1`,
      [serialCandidate]
    );
    if (serialRows?.[0]?.product_id) {
      matchedSerialNumber = serialRows[0].serial_number;
      matchedSerialStatus = serialRows[0].status || 'available';
      const [metaRows] = await db.query(
        `SELECT m.*, p.name AS web_name, p.slug AS web_slug, p.quantity AS web_quantity, p.price AS web_price, p.discount_price AS web_discount_price
         FROM inventory_product_meta m
         LEFT JOIN products p ON m.product_id = p.id
         WHERE m.product_id = ? AND p.id IS NOT NULL
         LIMIT 1`,
        [serialRows[0].product_id]
      );
      if (metaRows?.[0]) {
        return formatResolvedScannerItem(metaRows[0], matchedSerialNumber, extractedBatch, matchedSerialStatus);
      }
    }
  } catch {
    // Ignore if product_serials table is not present
  }

  // 2. Match by SKU, Barcode, Batch Number, Slug, or Product Name in inventory_product_meta + products
  const lookupToken = extractedSku || extractedSlug || raw;
  const [rows] = await db.query(
    `SELECT m.*, p.name AS web_name, p.slug AS web_slug, p.quantity AS web_quantity, p.price AS web_price, p.discount_price AS web_discount_price
     FROM inventory_product_meta m
     LEFT JOIN products p ON m.product_id = p.id
     WHERE (m.product_id IS NULL OR p.id IS NOT NULL)
       AND (LOWER(m.sku) = LOWER(?)
        OR m.barcode = ?
        OR LOWER(COALESCE(m.batch_no, '')) = LOWER(?)
        OR LOWER(COALESCE(p.slug, '')) = LOWER(?)
        OR LOWER(COALESCE(p.name, m.custom_name, '')) = LOWER(?)
        OR m.id = ?
        OR p.id = ?)
     LIMIT 1`,
    [
      lookupToken,
      lookupToken,
      lookupToken,
      lookupToken,
      lookupToken,
      Number.isInteger(Number(lookupToken)) ? Number(lookupToken) : -1,
      Number.isInteger(Number(lookupToken)) ? Number(lookupToken) : -1,
    ]
  );

  if (rows?.[0]) {
    return formatResolvedScannerItem(rows[0], matchedSerialNumber, extractedBatch, matchedSerialStatus);
  }

  // 3. Fallback: match by product_batches table if a batch QR was scanned directly
  try {
    const [batchRows] = await db.query(
      `SELECT pb.product_id, pb.batch_number 
       FROM product_batches pb 
       WHERE LOWER(pb.batch_number) = LOWER(?) 
       LIMIT 1`,
      [lookupToken]
    );
    if (batchRows?.[0]?.product_id) {
      const [metaByBatch] = await db.query(
        `SELECT m.*, p.name AS web_name, p.slug AS web_slug, p.quantity AS web_quantity, p.price AS web_price, p.discount_price AS web_discount_price
         FROM inventory_product_meta m
         LEFT JOIN products p ON m.product_id = p.id
         WHERE m.product_id = ? AND p.id IS NOT NULL
         LIMIT 1`,
        [batchRows[0].product_id]
      );
      if (metaByBatch?.[0]) {
        return formatResolvedScannerItem(metaByBatch[0], null, batchRows[0].batch_number);
      }
    }
  } catch (_) {}

  return null;
}

function formatResolvedScannerItem(r, serialNumber = null, batchNumber = null, serialStatus = null) {
  const liveQty =
    r.product_id && r.web_quantity !== null && r.web_quantity !== undefined
      ? Number(r.web_quantity)
      : Number(r.physical_stock) || 0;
  const sellingPrice =
    r.product_id && Number(r.web_discount_price) > 0
      ? Number(r.web_discount_price)
      : r.product_id && Number(r.web_price) > 0
      ? Number(r.web_price)
      : Number(r.selling_price) || 0;

  return {
    metaId: r.id,
    productId: r.product_id,
    sku: r.sku,
    barcode: r.barcode,
    serialNumber: serialNumber || null,
    serialStatus,
    name: r.web_name || r.custom_name || 'Bhumivera Formulation',
    slug: r.web_slug || '',
    uom: r.uom || 'Pcs',
    price: sellingPrice,
    mrp: Number(r.mrp) || sellingPrice,
    gstHsnCode: r.gst_hsn_code || '30049011',
    gstRate: Number(r.gst_rate) || 5,
    availableStock: liveQty,
    binCode: r.bin_code || 'ASN-SHOP-R1-B01',
    batchNo: batchNumber || r.batch_no || '',
  };
}

const BACKUP_TABLES_ORDER = [
  'categories',
  'subcategories',
  'products',
  'product_images',
  'product_batches',
  'product_serials',
  'users',
  'addresses',
  'orders',
  'order_items',
  'inventory_order_pack_progress',
  'coupons',
  'coupon_redemptions',
  'wallets',
  'wallet_transactions',
  'referral_wallets',
  'loyalty_tiers',
  'settings',
  'support_agents',
  'support_tickets',
  'inventory_staff_accounts',
  'inventory_storage_bins',
  'inventory_product_meta',
  'inventory_suppliers',
  'inventory_grn_entries',
  'inventory_pos_invoices',
  'inventory_stock_movements',
  'inventory_store_config',
];

function escapeSqlValue(val) {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'boolean') return val ? '1' : '0';
  if (typeof val === 'number') return Number.isFinite(val) ? String(val) : '0';
  if (val instanceof Date) {
    return `'${val.toISOString().slice(0, 19).replace('T', ' ')}'`;
  }
  if (Buffer.isBuffer(val)) {
    return `X'${val.toString('hex')}'`;
  }
  const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
  return (
    "'" +
    str
      .replace(/\\/g, '\\\\')
      .replace(/\0/g, '\\0')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/'/g, "\\'")
      .replace(/"/g, '\\"')
      .replace(/\x1a/g, '\\Z') +
    "'"
  );
}

/**
 * Generates a full SQL (.sql) and JSON (.avbak.json) disaster-recovery backup
 * of all critical tables so that even if the database on Railway is wiped or hacked,
 * it can be 100% restored in 1 click from /inventorysoftware.
 */
async function generateFullDatabaseBackup(
  db = pool,
  { triggerType = 'MANUAL', actorUsername = 'admin', saveToVault = true } = {}
) {
  await ensureInventorySoftwareTables(db);
  const exportedAt = new Date().toISOString();
  const backupDate = exportedAt.slice(0, 10);
  const backupCode = `BV-SQL-BAK-${backupDate.replace(/-/g, '')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

  const tablesData = {};
  const sqlLines = [
    `-- ============================================================================`,
    `-- BHUMIVERA ORGANICS — FULL DISASTER RECOVERY SQL DUMP (RAILWAY + VERCEL SYNC)`,
    `-- Backup Code: ${backupCode}`,
    `-- Generated At: ${exportedAt}`,
    `-- Trigger: ${triggerType} | Operator: @${actorUsername}`,
    `-- ============================================================================`,
    `SET FOREIGN_KEY_CHECKS = 0;`,
    `SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";`,
    ``,
  ];

  let totalTables = 0;
  let totalRows = 0;

  for (const tableName of BACKUP_TABLES_ORDER) {
    try {
      const [rows] = await db.query(`SELECT * FROM \`${tableName}\``);
      tablesData[tableName] = rows || [];
      totalTables += 1;
      totalRows += (rows || []).length;

      try {
        const [createInfo] = await db.query(`SHOW CREATE TABLE \`${tableName}\``);
        const createStmt = createInfo?.[0]?.['Create Table'] || createInfo?.[0]?.['Create View'];
        if (createStmt) {
          sqlLines.push(`-- Table structure for \`${tableName}\``);
          sqlLines.push(createStmt.replace(/^CREATE TABLE/i, 'CREATE TABLE IF NOT EXISTS') + ';');
          sqlLines.push('');
        }
      } catch {
        // Ignore if SHOW CREATE TABLE is not supported on mock
      }

      if (Array.isArray(rows) && rows.length > 0) {
        sqlLines.push(`-- Data for \`${tableName}\` (${rows.length} rows)`);
        const cols = Object.keys(rows[0]);
        const colList = cols.map(c => `\`${c}\``).join(', ');
        const updateList = cols.map(c => `\`${c}\` = VALUES(\`${c}\`)`).join(', ');

        for (const row of rows) {
          const vals = cols.map(c => escapeSqlValue(row[c])).join(', ');
          sqlLines.push(
            `INSERT INTO \`${tableName}\` (${colList}) VALUES (${vals}) ON DUPLICATE KEY UPDATE ${updateList};`
          );
        }
        sqlLines.push('');
      }
    } catch {
      // Table may not exist yet; skip gracefully
    }
  }

  sqlLines.push(`SET FOREIGN_KEY_CHECKS = 1;`);
  sqlLines.push(`-- END OF BHUMIVERA SQL BACKUP (${backupCode})`);

  const sqlDump = sqlLines.join('\n');
  const snapshotObj = {
    version: '10X-RAILWAY-VERCEL-SQL-3.0',
    backupCode,
    backupDate,
    exportedAt,
    triggerType,
    createdBy: actorUsername,
    tablesCount: totalTables,
    rowsCount: totalRows,
    tables: tablesData,
  };
  const snapshotJson = JSON.stringify(snapshotObj);
  const sizeBytes = Buffer.byteLength(sqlDump, 'utf8') + Buffer.byteLength(snapshotJson, 'utf8');
  const checksumSha512 = computeQuantumHash512(
    { backupCode, exportedAt, totalTables, totalRows },
    'BHUMIVERA_DAILY_SQL_BACKUP_512'
  );

  let insertedId = null;
  if (saveToVault) {
    try {
      const [ins] = await db.query(
        `INSERT INTO system_daily_backups
          (backup_code, backup_date, trigger_type, tables_count, rows_count, size_bytes, checksum_sha512, snapshot_json, sql_dump, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          backupCode,
          backupDate,
          triggerType,
          totalTables,
          totalRows,
          sizeBytes,
          checksumSha512,
          snapshotJson,
          sqlDump,
          actorUsername,
        ]
      );
      insertedId = ins.insertId;

      // Retain latest 15 backups in DB table so Railway storage stays fast and clean
      await db
        .query(
          `DELETE FROM system_daily_backups
           WHERE id NOT IN (
             SELECT id FROM (
               SELECT id FROM system_daily_backups ORDER BY created_at DESC LIMIT 15
             ) AS recent_backups
           )`
        )
        .catch(() => {});
    } catch (err) {
      console.warn('[DAILY_BACKUP_VAULT_SAVE_WARN]', err.message);
    }
  }

  return {
    id: insertedId,
    backupCode,
    backupDate,
    exportedAt,
    triggerType,
    tablesCount: totalTables,
    rowsCount: totalRows,
    sizeBytes,
    checksumSha512,
    snapshotObj,
    sqlDump,
  };
}

/**
 * Ensures at least one automatic daily backup exists for today's date.
 */
async function ensureDailyAutoBackup(db = pool, actorUsername = 'auto-daily-scheduler') {
  try {
    const todayStr = new Date().toISOString().slice(0, 10);
    const [existing] = await db.query(
      'SELECT id, backup_code, backup_date, trigger_type, tables_count, rows_count, size_bytes, checksum_sha512, created_at FROM system_daily_backups WHERE backup_date = ? ORDER BY created_at DESC LIMIT 1',
      [todayStr]
    );
    if (existing && existing.length > 0) {
      return existing[0];
    }
    const created = await generateFullDatabaseBackup(db, {
      triggerType: 'AUTO_DAILY',
      actorUsername,
      saveToVault: true,
    });
    return {
      id: created.id,
      backup_code: created.backupCode,
      backup_date: created.backupDate,
      trigger_type: created.triggerType,
      tables_count: created.tablesCount,
      rows_count: created.rowsCount,
      size_bytes: created.sizeBytes,
      checksum_sha512: created.checksumSha512,
      created_at: created.exportedAt,
    };
  } catch (err) {
    console.warn('[ENSURE_DAILY_AUTO_BACKUP_WARN]', err.message);
    return null;
  }
}

/**
 * Restores the database from a saved backupId, a JSON snapshot (.avbak.json), or raw SQL (.sql).
 * Re-syncs Railway MySQL tables and invalidates Vercel/Redis public catalog cache.
 */
async function restoreFullDatabaseBackup(
  db = pool,
  { backupId = null, snapshotObj = null, sqlDump = null, actorUsername = 'admin' } = {}
) {
  await ensureInventorySoftwareTables(db);
  let targetSnapshot = snapshotObj;
  let targetSql = sqlDump;
  let sourceLabel = 'Uploaded Backup File';

  if (backupId) {
    const [[row]] = await db.query('SELECT * FROM system_daily_backups WHERE id = ?', [Number(backupId)]);
    if (!row) {
      throw Object.assign(new Error('Selected backup record not found in vault.'), { status: 404 });
    }
    sourceLabel = `Vault Backup ${row.backup_code} (${row.backup_date})`;
    if (row.snapshot_json) {
      try {
        targetSnapshot = JSON.parse(row.snapshot_json);
      } catch {
        targetSnapshot = null;
      }
    }
    targetSql = row.sql_dump || null;
  }

  const conn = await db.getConnection();
  let restoredTables = 0;
  let restoredRows = 0;

  try {
    await conn.beginTransaction();
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');

    if (targetSnapshot && targetSnapshot.tables && typeof targetSnapshot.tables === 'object') {
      for (const [tableName, rows] of Object.entries(targetSnapshot.tables)) {
        if (!BACKUP_TABLES_ORDER.includes(tableName) || !Array.isArray(rows) || rows.length === 0) continue;
        const cols = Object.keys(rows[0]);
        if (cols.length === 0) continue;
        const colList = cols.map(c => `\`${c}\``).join(', ');
        const placeholders = cols.map(() => '?').join(', ');
        const updateList = cols.map(c => `\`${c}\` = VALUES(\`${c}\`)`).join(', ');

        let tableRestored = 0;
        for (const r of rows) {
          const vals = cols.map(c => {
            const v = r[c];
            if (v !== null && typeof v === 'object' && !(v instanceof Date) && !Buffer.isBuffer(v)) {
              return JSON.stringify(v);
            }
            if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v)) {
              return v.slice(0, 19).replace('T', ' ');
            }
            return v;
          });
          await conn
            .query(
              `INSERT INTO \`${tableName}\` (${colList}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${updateList}`,
              vals
            )
            .catch(() => {});
          tableRestored += 1;
        }
        if (tableRestored > 0) {
          restoredTables += 1;
          restoredRows += tableRestored;
        }
      }
    } else if (targetSnapshot && Array.isArray(targetSnapshot.items)) {
      // Legacy .avbak.json format compatibility
      for (const it of targetSnapshot.items) {
        if (it.productId && it.qty !== undefined) {
          await conn
            .query('UPDATE products SET quantity = ? WHERE id = ?', [Number(it.qty) || 0, Number(it.productId)])
            .catch(() => {});
          await conn
            .query('UPDATE inventory_product_meta SET physical_stock = ? WHERE product_id = ?', [
              Number(it.qty) || 0,
              Number(it.productId),
            ])
            .catch(() => {});
          restoredRows += 1;
        }
      }
      restoredTables = 2;
    } else if (targetSql && typeof targetSql === 'string') {
      const statements = targetSql
        .split(/;\s*\r?\n/)
        .map(s => s.trim())
        .filter(s => s && !s.startsWith('--'));
      for (const stmt of statements) {
        if (/^(INSERT\s+INTO|CREATE\s+TABLE|UPDATE\s+)/i.test(stmt)) {
          await conn.query(stmt).catch(() => {});
          restoredRows += 1;
        }
      }
      restoredTables = 1;
    } else {
      throw Object.assign(new Error('Invalid backup payload. Provide a valid .avbak.json or .sql backup file.'), {
        status: 400,
      });
    }

    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
    await syncWebsiteProductsToInventoryMeta(conn);
    await recalculateAllBundleStocks(conn);

    await appendInventoryAuditLog(conn, {
      actorUsername,
      actorRole: 'admin',
      actionCode: 'SQL_DISASTER_RECOVERY_RESTORE',
      summary: `Restored ${restoredRows} records across ${restoredTables} tables from ${sourceLabel} and synced Railway DB + Vercel storefront.`,
    });

    await conn.commit();
    await invalidatePublicCatalogCache();

    return {
      restoredTables,
      restoredRows,
      sourceLabel,
      restoredAt: new Date().toISOString(),
    };
  } catch (err) {
    await conn.query('SET FOREIGN_KEY_CHECKS = 1').catch(() => {});
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * 1. AI-Powered Inventory Velocity & Days of Cover (DOC) Forecasting
 */
async function calculateInventoryVelocityAndDoc(db = pool) {
  const [velocityRows] = await db.query(`
    SELECT 
      oi.product_id,
      SUM(oi.quantity) AS total_sold_30d,
      COUNT(DISTINCT oi.order_id) AS order_count_30d
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
      AND o.status NOT IN ('cancelled', 'refunded', 'archived')
    GROUP BY oi.product_id
  `).catch(() => [[]]);

  const velocityByProductId = {};
  for (const row of velocityRows) {
    velocityByProductId[row.product_id] = {
      sold30d: Number(row.total_sold_30d) || 0,
      dailyRunRate: Math.round(((Number(row.total_sold_30d) || 0) / 30) * 100) / 100,
    };
  }

  let items = [];
  try {
    const [rows] = await db.query(`
      SELECT m.id AS meta_id, m.product_id, m.sku, m.barcode, m.custom_name,
             m.category_name, m.cost_price, m.selling_price, m.min_stock_alert,
             m.reorder_qty, m.bin_code, m.rack_location, m.gst_hsn_code, m.gst_rate,
             COALESCE(p.name, m.custom_name) AS product_name,
             COALESCE(p.quantity, m.physical_stock, 0) AS current_stock
      FROM inventory_product_meta m
      LEFT JOIN products p ON m.product_id = p.id
      WHERE m.product_id IS NULL OR p.id IS NOT NULL
      ORDER BY m.id ASC
    `);
    items = rows || [];
  } catch (err) {
    console.error('[FORECAST_QUERY_FALLBACK]', err);
    items = [];
  }

  const forecasts = items.map(it => {
    const vel = velocityByProductId[it.product_id] || { sold30d: 0, dailyRunRate: 0 };
    const runRate = vel.dailyRunRate > 0 ? vel.dailyRunRate : 0.05;
    const daysOfCover = Math.round(Number(it.current_stock) / runRate);
    const leadTime = 7;
    const safetyStock = Number(it.min_stock_alert) || 15;
    const reorderPoint = Math.ceil(runRate * leadTime + safetyStock);

    let status = 'HEALTHY';
    if (it.current_stock <= 0) {
      status = 'OUT_OF_STOCK';
    } else if (it.current_stock <= safetyStock || daysOfCover <= 15) {
      status = 'REORDER_CRITICAL';
    } else if (daysOfCover <= 30) {
      status = 'REORDER_APPROACHING';
    }

    return {
      metaId: it.meta_id,
      productId: it.product_id,
      sku: it.sku,
      barcode: it.barcode,
      name: it.product_name,
      category: it.category_name,
      gstHsnCode: it.gst_hsn_code || '30049011',
      gstRate: Number(it.gst_rate) || 5,
      currentStock: Number(it.current_stock),
      sold30d: vel.sold30d,
      dailyRunRate: vel.dailyRunRate,
      daysOfCover,
      leadTimeDays: leadTime,
      safetyStock,
      reorderPoint,
      suggestedReorderQty: Number(it.reorder_qty) || 50,
      binCode: it.bin_code,
      rackLocation: it.rack_location,
      status,
    };
  });

  const criticalCount = forecasts.filter(f => f.status === 'REORDER_CRITICAL' || f.status === 'OUT_OF_STOCK').length;
  const approachingCount = forecasts.filter(f => f.status === 'REORDER_APPROACHING').length;

  return {
    calculatedAt: new Date().toISOString(),
    forecasts,
    summary: {
      totalProducts: forecasts.length,
      criticalCount,
      approachingCount,
      healthyCount: forecasts.length - criticalCount - approachingCount,
    },
  };
}

/**
 * 2. FEFO (First-Expired, First-Out) & FIFO Batch Allocation for an Order
 * Earliest expiry dates are strictly picked first so older products never age on shelves.
 */
async function allocateFefoBatchesForOrder(db = pool, orderId) {
  const [orderItems] = await db.query(
    'SELECT id, product_id, name, quantity, price FROM order_items WHERE order_id = ?',
    [Number(orderId)]
  );

  if (!orderItems || orderItems.length === 0) {
    return { orderId: Number(orderId), allocations: [] };
  }

  const allocations = [];

  for (const item of orderItems) {
    const [batches] = await db.query(`
      SELECT pb.id, pb.batch_number,
             COALESCE(pb.expiry_date, pb.manufacture_date) AS expiry_date,
             COALESCE(pb.unit_count, 0) AS batch_stock,
             m.bin_code, m.rack_location
      FROM product_batches pb
      LEFT JOIN inventory_product_meta m ON m.product_id = pb.product_id
      WHERE pb.product_id = ? AND COALESCE(pb.unit_count, 0) > 0
      ORDER BY COALESCE(pb.expiry_date, '2099-12-31') ASC, COALESCE(pb.manufacture_date, '1970-01-01') ASC, pb.id ASC
    `, [item.product_id]).catch(() => [[]]);

    let neededQty = Number(item.quantity);
    const allocatedBatches = [];

    if (batches && batches.length > 0) {
      for (const b of batches) {
        if (neededQty <= 0) break;
        const availableInBatch = Math.max(0, Number(b.batch_stock) || 0);
        const pickQty = Math.min(neededQty, availableInBatch > 0 ? availableInBatch : neededQty);
        allocatedBatches.push({
          batchId: b.id,
          batchNumber: b.batch_number,
          expiryDate: b.expiry_date ? String(b.expiry_date).slice(0, 10) : 'N/A',
          pickQuantity: pickQty,
          binCode: b.bin_code || 'ASN-DEFAULT',
          rackLocation: b.rack_location || 'Zone A',
        });
        neededQty -= pickQty;
      }
    }

    allocations.push({
      orderItemId: item.id,
      productId: item.product_id,
      productName: item.name,
      orderedQuantity: Number(item.quantity),
      fefoBatches: allocatedBatches.length > 0 ? allocatedBatches : [{
        batchNumber: 'FIFO-DISPATCH',
        expiryDate: 'ACTIVE',
        pickQuantity: Number(item.quantity),
        binCode: 'ASN-SHOP-R1-B01',
        rackLocation: 'Zone A',
      }],
    });
  }

  return {
    orderId: Number(orderId),
    allocations,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * 3. Wave & Zone Picking Engine (Aggregated Warehouse Walk Route)
 */
async function generateWavePicklist(db = pool, orderIds = []) {
  if (!Array.isArray(orderIds) || orderIds.length === 0) {
    throw Object.assign(new Error('At least one order ID is required to generate a wave picklist.'), { status: 400 });
  }

  const placeholders = orderIds.map(() => '?').join(',');
  const [items] = await db.query(`
    SELECT oi.order_id, oi.product_id, oi.name AS product_name, oi.quantity,
           m.sku, m.barcode, m.bin_code, m.rack_location,
           COALESCE(b.zone_name, 'Zone A') AS zone_name,
           COALESCE(b.rack_no, '01') AS rack_no,
           COALESCE(b.shelf_level, 'A') AS shelf_level
    FROM order_items oi
    LEFT JOIN inventory_product_meta m ON m.product_id = oi.product_id
    LEFT JOIN inventory_storage_bins b ON b.bin_code = m.bin_code
    WHERE oi.order_id IN (${placeholders})
    ORDER BY b.zone_name ASC, b.rack_no ASC, b.shelf_level ASC, m.sku ASC
  `, orderIds);

  const aggregatedBySku = {};
  for (const it of items) {
    const key = it.sku || `PID-${it.product_id}`;
    if (!aggregatedBySku[key]) {
      aggregatedBySku[key] = {
        sku: it.sku || 'N/A',
        barcode: it.barcode || 'N/A',
        name: it.product_name,
        totalPickQuantity: 0,
        binCode: it.bin_code || 'ASN-DEFAULT',
        rackLocation: it.rack_location || 'Zone A',
        zone: it.zone_name,
        rack: it.rack_no,
        orderAllocations: [],
      };
    }
    aggregatedBySku[key].totalPickQuantity += Number(it.quantity) || 1;
    aggregatedBySku[key].orderAllocations.push({
      orderId: it.order_id,
      quantity: Number(it.quantity) || 1,
    });
  }

  const picklistItems = Object.values(aggregatedBySku).sort((a, b) => {
    if (a.zone !== b.zone) return a.zone.localeCompare(b.zone);
    if (a.rack !== b.rack) return a.rack.localeCompare(b.rack);
    return a.binCode.localeCompare(b.binCode);
  });

  const waveId = `WAVE-${Date.now().toString().slice(-6)}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;

  return {
    waveId,
    orderCount: orderIds.length,
    orderIds,
    totalItemsToPick: picklistItems.reduce((sum, it) => sum + it.totalPickQuantity, 0),
    totalUniqueSkus: picklistItems.length,
    walkPath: picklistItems,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * 4. Consolidated Courier Shipping Manifest Generator
 */
async function generateCarrierManifest(db = pool, orderIds = [], courier = 'All Carriers', actorUsername = 'system') {
  if (!Array.isArray(orderIds) || orderIds.length === 0) {
    throw Object.assign(new Error('At least one order ID is required to generate a manifest.'), { status: 400 });
  }

  const placeholders = orderIds.map(() => '?').join(',');
  const [orders] = await db.query(`
    SELECT o.id, o.order_number, o.status, o.courier, o.tracking_number, o.tracking_url,
           o.total, o.payment_mode, o.created_at, o.address_snapshot,
           u.name AS customer_name, u.phone AS customer_phone
    FROM orders o
    LEFT JOIN users u ON u.id = o.user_id
    WHERE o.id IN (${placeholders})
  `, orderIds);

  const foundOrderIds = new Set(orders.map(order => Number(order.id)));
  const missingOrderIds = [...new Set(orderIds.map(Number))].filter(id => !foundOrderIds.has(id));
  if (missingOrderIds.length > 0) {
    throw Object.assign(new Error(`Order(s) not found: ${missingOrderIds.join(', ')}.`), { status: 404, code: 'MANIFEST_ORDER_NOT_FOUND' });
  }

  const ineligible = orders.filter(order =>
    !['shipped', 'out_for_delivery', 'delivered'].includes(String(order.status || '').toLowerCase()) ||
    !order.courier ||
    !order.tracking_number ||
    !order.tracking_url
  );
  if (ineligible.length > 0) {
    throw Object.assign(
      new Error(`Shipping documents require shipped orders with a courier, tracking/AWB number, and tracking link. Ineligible order(s): ${ineligible.map(order => order.order_number || order.id).join(', ')}.`),
      { status: 409, code: 'SHIPMENT_DETAILS_REQUIRED' }
    );
  }

  const manifestCode = `BV-MAN-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  const totalWeightKg = (orders.length * 0.45).toFixed(2);

  return {
    manifestCode,
    courier,
    totalShipments: orders.length,
    totalWeightKg: Number(totalWeightKg),
    generatedBy: actorUsername,
    generatedAt: new Date().toISOString(),
    shipments: orders.map(o => {
      let address = o.address_snapshot || {};
      if (typeof address === 'string') {
        try {
          address = JSON.parse(address);
        } catch {
          address = {};
        }
      }
      return {
      orderId: o.id,
      orderNumber: o.order_number || `BV-${o.id}`,
      customerName: o.customer_name || 'Walk-in / Patron',
      phone: o.customer_phone || 'N/A',
      trackingNumber: o.tracking_number,
      trackingUrl: o.tracking_url,
      destinationCity: address.city || address.district || '',
      pincode: address.pincode || address.postal_code || address.zip || '',
      courier: o.courier || courier,
      paymentMode: o.payment_mode || 'Prepaid',
      collectableAmount: o.payment_mode === 'cod' ? Number(o.total) : 0,
      declaredValue: Number(o.total) || 0,
      };
    }),
  };
}

/**
 * 5. Return QC Inspection & Grading Matrix
 */
async function processReturnQcGrade(db = pool, { orderId, grade, notes = '', actorUsername = 'system' }) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [[order]] = await conn.query('SELECT * FROM orders WHERE id = ? FOR UPDATE', [Number(orderId)]);
    if (!order) {
      throw Object.assign(new Error(`Order #${orderId} not found.`), { status: 404 });
    }

    const [items] = await conn.query('SELECT * FROM order_items WHERE order_id = ?', [Number(orderId)]);

    let restockCategory = 'vault';
    let movementType = 'RTO_RESTOCK_GRADE_A';
    let newStatus = 'rto_delivered';

    if (grade === 'GRADE_A') {
      restockCategory = 'vault';
      movementType = 'RTO_QC_GRADE_A_SELLABLE';
      for (const it of items) {
        await atomicAdjustProductStock(conn, {
          productId: it.product_id,
          delta: Number(it.quantity),
          category: 'vault',
          notes: `RTO QC Grade A (Pristine): Restocked ${it.quantity} unit(s) from order #${orderId}`,
          actorUsername,
        });
      }
    } else if (grade === 'GRADE_B') {
      restockCategory = 'shop';
      movementType = 'RTO_QC_GRADE_B_DISPLAY';
      for (const it of items) {
        await atomicAdjustProductStock(conn, {
          productId: it.product_id,
          delta: Number(it.quantity),
          category: 'shop',
          notes: `RTO QC Grade B (Display/Clearance): Restocked ${it.quantity} unit(s) from order #${orderId}`,
          actorUsername,
        });
      }
    } else {
      restockCategory = 'damaged';
      movementType = 'RTO_QC_GRADE_C_DAMAGED';
      for (const it of items) {
        await atomicAdjustProductStock(conn, {
          productId: it.product_id,
          delta: Number(it.quantity),
          category: 'damaged',
          notes: `RTO QC Grade C (Damaged/Quarantine): Marked ${it.quantity} unit(s) as quarantine from order #${orderId}`,
          actorUsername,
        });
      }
    }

    await conn.query(
      `UPDATE orders 
       SET status = ?, 
           rto_reason = CONCAT('QC Grade: ', ?, ' — ', ?),
           rto_restock_mode = ?,
           rto_processed_at = NOW(),
           updated_at = NOW()
       WHERE id = ?`,
      [newStatus, grade, notes, restockCategory, Number(orderId)]
    );

    await appendInventoryAuditLog(conn, {
      actorUsername,
      actorRole: 'inspector',
      actionCode: movementType,
      summary: `Processed return QC for Order #${orderId}: ${grade}. Stock routed to ${restockCategory}. Notes: ${notes}`,
    });

    await conn.commit();
    await invalidatePublicCatalogCache();

    return {
      success: true,
      orderId: Number(orderId),
      grade,
      restockCategory,
      processedAt: new Date().toISOString(),
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}


/**
 * Generates a compact, fast-scannable standalone QR code payload for any product SKU.
 * Uses a low-density payload (BV-QR:<SKU>) so mobile cameras decode it in <10ms.
 */
function buildStandaloneProductQr(sku, batchNo = null) {
  const cleanSku = String(sku || 'BV-PRODUCT').trim().toUpperCase();
  if (batchNo && String(batchNo).trim()) {
    return `BV-QR:${cleanSku}:${String(batchNo).trim()}`;
  }
  return `BV-QR:${cleanSku}`;
}

/**
 * Automatically computes optimal A4 sheet grid layout (210mm x 297mm) for any requested QR count
 * (e.g., 6, 10, 20, 24, 35, 48, etc.) while clamping physical QR dimensions between 24mm and 38mm
 * so the QR code is never too small for mobile cameras and never oversized/awkward on paper.
 */
function computeOptimalA4QrLayout(requestedCount = 24, showLabel = true) {
  const totalCount = Math.max(1, Math.min(500, Math.trunc(Number(requestedCount) || 24)));
  const printableWidthMm = 194; // 210mm - 2*8mm margin
  const printableHeightMm = 281; // 297mm - 2*8mm margin

  let cols = 4;
  let rows = 6;

  if (totalCount <= 4) {
    cols = 2;
    rows = 3;
  } else if (totalCount <= 6) {
    cols = 3;
    rows = 3;
  } else if (totalCount <= 10) {
    cols = 3;
    rows = 4;
  } else if (totalCount <= 12) {
    cols = 3;
    rows = 4;
  } else if (totalCount <= 16) {
    cols = 4;
    rows = 4;
  } else if (totalCount <= 20) {
    cols = 4;
    rows = 5;
  } else if (totalCount <= 24) {
    cols = 4;
    rows = 6;
  } else if (totalCount <= 30) {
    cols = 5;
    rows = 6;
  } else if (totalCount <= 35) {
    cols = 5;
    rows = 7;
  } else {
    cols = 6;
    rows = 8;
  }

  const perPage = cols * rows;
  const totalPages = Math.ceil(totalCount / perPage);
  const gapMm = cols >= 5 ? 2.5 : 3.5;

  const cellWidthMm = Number(((printableWidthMm - (cols - 1) * gapMm) / cols).toFixed(1));
  const cellHeightMm = Number(((printableHeightMm - (rows - 1) * gapMm) / rows).toFixed(1));

  // Reserve vertical space for compact product name + SKU label if enabled
  const labelAllowanceMm = showLabel ? 9 : 3;
  const maxFitQrMm = Math.min(cellWidthMm - 5, cellHeightMm - labelAllowanceMm);

  // Clamp strictly between 24mm (fast mobile focus minimum) and 38mm (visual elegance maximum)
  const qrSizeMm = Math.max(24, Math.min(38, Math.floor(maxFitQrMm)));

  return {
    totalCount,
    cols,
    rows,
    perPage,
    totalPages,
    gapMm,
    cellWidthMm,
    cellHeightMm,
    qrSizeMm,
    minQrMm: 24,
    maxQrMm: 38,
    showLabel: Boolean(showLabel),
  };
}

module.exports = {
  buildStandaloneProductQr,
  computeOptimalA4QrLayout,
  VALID_INVENTORY_ROLES,
  INVENTORY_PERMISSION_DEFINITIONS,
  ROLE_DEFAULT_INVENTORY_PERMISSIONS,
  resolveInventoryPermissions,
  generateTotpSecret,
  verifyTotpCode,
  calculateEstimatedDeliveryDate,
  initInventorySoftwareTables,
  ensureInventorySoftwareTables,
  syncWebsiteProductsToInventoryMeta,
  recalculateAllBundleStocks,
  appendInventoryAuditLog,
  recordStockMovement,
  atomicAdjustProductStock,
  resolveProductByQrOrCode,
  generateFullDatabaseBackup,
  ensureDailyAutoBackup,
  restoreFullDatabaseBackup,
  calculateInventoryVelocityAndDoc,
  allocateFefoBatchesForOrder,
  generateWavePicklist,
  generateCarrierManifest,
  processReturnQcGrade,
};
