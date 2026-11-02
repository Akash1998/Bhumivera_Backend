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
    desc: 'Full unrestricted access to all 10X Inventory, Storage Keeper, Offline POS, Website Stock Sync, Khata, GRN & Settings modules.',
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
    label: 'Offline Shop POS Billing Terminal',
    desc: 'Create walk-in & registered customer POS bills that atomically deduct stock from the live website.',
  },
  can_give_discounts: {
    label: 'Apply Custom POS Discounts',
    desc: 'Apply item-level or invoice-level discounts and promotional rates at POS checkout.',
  },
  can_void_invoices: {
    label: 'Void / Cancel POS Invoices & Restock',
    desc: 'Cancel completed POS invoices, automatically restore stock to bhumivera.com, and reverse Khata balances.',
  },
  can_manage_khata: {
    label: 'Customer Khata & Credit Ledger',
    desc: 'Manage customer profiles, credit limits, debt collection, payment proof uploads, and WhatsApp reminders.',
  },
  can_process_returns: {
    label: 'Customer Returns & Replacements',
    desc: 'Process returned items into Restock (Good Condition) or Scrap/Quarantine (Damaged Condition).',
  },
  can_manage_online_dispatch: {
    label: 'Live Online Website Orders & Dispatch Queue',
    desc: 'Inspect live bhumivera.com online orders, verify stock allocation, and mark orders Packed or Shipped.',
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
    label: 'Time-Machine Financial Reports & Proof Gallery',
    desc: 'Access daily/monthly revenue reports, margin analytics, and payment proof gallery.',
  },
  can_export_data: {
    label: 'Excel Exports & Encrypted Backups (.avbak)',
    desc: 'Export inventory/sales/logs to Excel (.xlsx) and create or restore daily snapshots.',
  },
  can_view_audit_logs: {
    label: 'Cryptographic Audit Trail & Stock Ledger',
    desc: 'View immutable 512-bit signed audit logs and before/after stock movement history.',
  },
  can_manage_store_settings: {
    label: 'Store & Billing Configuration',
    desc: 'Configure store name, address, GSTIN, UPI ID for dynamic QR codes, and invoice branding.',
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
    can_manage_khata: false,
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
    can_manage_online_dispatch: false,
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

let tablesInitializedPromise = null;

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
      product_id INT UNIQUE DEFAULT NULL,
      custom_name VARCHAR(255) DEFAULT NULL,
      sku VARCHAR(100) NOT NULL UNIQUE,
      barcode VARCHAR(100) NOT NULL,
      category_name VARCHAR(120) DEFAULT 'Botanical Formulations',
      uom VARCHAR(30) DEFAULT 'Pcs',
      cost_price DECIMAL(10,2) NOT NULL DEFAULT 0.00,
      mrp DECIMAL(10,2) NOT NULL DEFAULT 0.00,
      selling_price DECIMAL(10,2) NOT NULL DEFAULT 0.00,
      gst_hsn_code VARCHAR(20) DEFAULT '33049990',
      gst_rate DECIMAL(5,2) NOT NULL DEFAULT 18.00,
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
      default_tax_rate DECIMAL(5,2) NOT NULL DEFAULT 18.00,
      auto_sync_website TINYINT(1) NOT NULL DEFAULT 1,
      pos_hold_reservation TINYINT(1) NOT NULL DEFAULT 1,
      categories_json JSON DEFAULT NULL,
      hidden_widgets_json JSON DEFAULT NULL,
      logo_url TEXT DEFAULT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await db.query(
    `INSERT IGNORE INTO inventory_store_config
      (id, store_name, tagline, address, phone, email, website, gstin, cin, upi_id, default_tax_rate, auto_sync_website, categories_json, hidden_widgets_json, logo_url)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 18.00, 1, ?, '[]', '/assets/bhumivera-luxury-crest-logo.webp')`,
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
      ['ASN-SHOP-R1-B01', 'Bhumivera Flagship Hub — Asansol', 'Zone A: Retail Shop Front Counter', 'Rack-01', 'Shelf-A', 'Facial Cleansers Display Bay', '22°C - 25°C', 400, 120, 'Rahul Sharma', 'active', 'Direct walk-in POS counter stock for Facial Cleansers'],
      ['ASN-SHOP-R1-B02', 'Bhumivera Flagship Hub — Asansol', 'Zone A: Retail Shop Front Counter', 'Rack-01', 'Shelf-B', 'Royal Hair Care & Shampoo Counter', '22°C - 25°C', 350, 80, 'Rahul Sharma', 'active', 'Direct walk-in POS counter stock for 2-in-1 Botanical Shampoo'],
      ['ASN-SHOP-R2-B01', 'Bhumivera Flagship Hub — Asansol', 'Zone A: Retail Shop Front Counter', 'Rack-02', 'Shelf-A', 'Artisanal Cleansing Bars & Tulsi Drops', '22°C - 25°C', 600, 200, 'Rahul Sharma', 'active', 'Charcoal Bar, Aloe-Neem-Tulsi Bar & Kalpvriksh 7-Tulsi Drops'],
      ['ASN-COLD-R1-B01', 'Bhumivera Flagship Hub — Asansol', 'Zone B: Cold-Pressed Botanical Vault (<28°C)', 'Rack-C1', 'Shelf-01', 'Climate-Controlled Master Reserve Vault', '18°C - 24°C', 1500, 850, 'Vikram Rathore', 'active', 'Sub-28°C climate-controlled reserve for micro-batch formulations'],
      ['ASN-DISPATCH-R1-B01', 'Bhumivera Flagship Hub — Asansol', 'Zone C: Online Order Dispatch & CCTV Weighing Bay', 'Rack-D1', 'Shelf-01', 'E-Commerce Pick, Pack & Scale #02 Bay', '22°C - 26°C', 500, 180, 'Vikram Rathore', 'active', 'Dedicated online order staging & regimen bundle assembly bay'],
      ['ASN-PACK-R1-B01', 'Bhumivera Flagship Hub — Asansol', 'Zone D: Luxury Glass & Packaging Vault', 'Rack-P1', 'Shelf-01', 'Amber Apothecary Bottles & Gold Foiled Boxes', 'Ambient', 2000, 650, 'Karan Verma', 'active', 'UV-protective containers, pumps, tamper seals & shipping cartons'],
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

  const [[custCountRow]] = await db.query('SELECT COUNT(*) AS cnt FROM inventory_customers');
  if (Number(custCountRow?.cnt || 0) === 0) {
    const seedCustomers = [
      ['Walk-in Retail Shopper', '+91 90000 00000', 'walkin@bhumivera.com', '', 'Asansol Flagship Counter', 'Walk-in', 0.00, 25000.00, 0.00, 1, 'Default counter walk-in profile for quick POS billing'],
      ['Aura Luxury Salon & Wellness Spa', '+91 98321 55667', 'procurement@auraspa.in', '19AABCA1122K1Z1', 'City Centre, Durgapur, WB', 'Salon / Spa Partner', -4500.00, 100000.00, 28500.00, 6, 'Wholesale B2B salon partner — Net 15 Khata terms'],
      ['Royal Ayurveda & Organic Boutique', '+91 98305 88990', 'orders@royalayurveda.in', '19AABCR3344M1Z8', 'Park Street, Kolkata, WB', 'Retail Shop', 0.00, 75000.00, 42000.00, 9, 'Authorized retail stockist'],
      ['Ananya Chatterjee (VIP Patron)', '+91 98324 12345', 'ananya.c@gmail.com', '', 'Burnpur Road, Asansol, WB', 'VIP Patron', 1500.00, 50000.00, 14200.00, 5, 'Regular offline + online patron'],
    ];
    for (const c of seedCustomers) {
      await db.query(
        `INSERT INTO inventory_customers
          (name, phone, email, gstin, location, customer_type, wallet_balance, credit_limit, total_purchases, visit_count, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        c
      );
    }
  }

  await syncWebsiteProductsToInventoryMeta(db);
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
  'BV-LUX-CFW-01': { barcode: '8908020260015', uom: '100 ML', costPrice: 115.00, mrp: 699.00, binCode: 'ASN-SHOP-R1-B01', rackLocation: 'Zone A • Rack 01 • Shelf A • Bin 01', batchNo: 'BV-BATCH-2026-CFW01', mfgDate: '2026-08-01', expiryDate: '2028-07-31', minStock: 20, reorderQty: 100 },
  'BV-LUX-SBFW-02': { barcode: '8908020260022', uom: '100 ML', costPrice: 145.00, mrp: 799.00, binCode: 'ASN-SHOP-R1-B01', rackLocation: 'Zone A • Rack 01 • Shelf A • Bin 02', batchNo: 'BV-BATCH-2026-SBFW02', mfgDate: '2026-08-01', expiryDate: '2028-07-31', minStock: 20, reorderQty: 100 },
  'BV-LUX-SH2IN1-03': { barcode: '8908020260039', uom: '200 ML', costPrice: 165.00, mrp: 899.00, binCode: 'ASN-SHOP-R1-B02', rackLocation: 'Zone A • Rack 01 • Shelf B • Bin 01', batchNo: 'BV-BATCH-2026-SH03', mfgDate: '2026-08-05', expiryDate: '2028-08-04', minStock: 15, reorderQty: 100 },
  'BV-LUX-CSOAP-04': { barcode: '8908020260046', uom: '100 GM', costPrice: 68.00, mrp: 399.00, binCode: 'ASN-SHOP-R2-B01', rackLocation: 'Zone A • Rack 02 • Shelf A • Bin 01', batchNo: 'BV-BATCH-2026-CS04', mfgDate: '2026-08-10', expiryDate: '2028-08-09', minStock: 25, reorderQty: 150 },
  'BV-LUX-ASOAP-05': { barcode: '8908020260053', uom: '100 GM', costPrice: 65.00, mrp: 349.00, binCode: 'ASN-SHOP-R2-B01', rackLocation: 'Zone A • Rack 02 • Shelf A • Bin 02', batchNo: 'BV-BATCH-2026-AS05', mfgDate: '2026-08-10', expiryDate: '2028-08-09', minStock: 25, reorderQty: 150 },
  'BV-LUX-TULSI-06': { barcode: '8908020260060', uom: '30 ML', costPrice: 95.00, mrp: 499.00, binCode: 'ASN-SHOP-R2-B01', rackLocation: 'Zone A • Rack 02 • Shelf A • Bin 03', batchNo: 'BV-BATCH-2026-TL06', mfgDate: '2026-08-12', expiryDate: '2028-08-11', minStock: 20, reorderQty: 120 },
  'BV-BND-DAILY-01': { barcode: '8908020260077', uom: 'Combo', costPrice: 375.00, mrp: 2047.00, binCode: 'ASN-DISPATCH-R1-B01', rackLocation: 'Zone C • Rack D1 • Shelf 01 • Regimen Bay', batchNo: 'BV-BND-2026-D01', mfgDate: '2026-08-15', expiryDate: '2028-07-31', minStock: 10, reorderQty: 50 },
  'BV-BND-INSIDEOUT-02': { barcode: '8908020260084', uom: 'Combo', costPrice: 278.00, mrp: 1597.00, binCode: 'ASN-DISPATCH-R1-B01', rackLocation: 'Zone C • Rack D1 • Shelf 01 • Regimen Bay', batchNo: 'BV-BND-2026-IO02', mfgDate: '2026-08-15', expiryDate: '2028-07-31', minStock: 10, reorderQty: 50 },
  'BV-BND-VAULT-06': { barcode: '8908020260091', uom: 'Vault', costPrice: 653.00, mrp: 3644.00, binCode: 'ASN-DISPATCH-R1-B01', rackLocation: 'Zone C • Rack D1 • Shelf 01 • Vault Bay', batchNo: 'BV-BND-2026-V06', mfgDate: '2026-08-15', expiryDate: '2028-07-31', minStock: 10, reorderQty: 40 },
};

async function syncWebsiteProductsToInventoryMeta(db = pool) {
  try {
    const [products] = await db.query(`
      SELECT p.id, p.name, p.sku, p.price, p.discount_price, p.quantity,
             p.gst_hsn_code, p.gst_rate, p.specifications,
             c.name AS category_name
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
    `);

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

      await db.query(
        `INSERT INTO inventory_product_meta
          (product_id, custom_name, sku, barcode, category_name, uom, cost_price, mrp, selling_price,
           gst_hsn_code, gst_rate, physical_stock, shop_display_stock, warehouse_vault_stock,
           safety_buffer_stock, min_stock_alert, reorder_qty, bin_code, rack_location,
           batch_no, mfg_date, expiry_date, sync_to_website)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, 1)
         ON DUPLICATE KEY UPDATE
           custom_name = VALUES(custom_name),
           selling_price = VALUES(selling_price),
           physical_stock = VALUES(physical_stock),
           category_name = COALESCE(VALUES(category_name), category_name)`,
        [
          prod.id,
          prod.name,
          sku,
          preset.barcode || `8908020${String(prod.id).padStart(6, '0')}`,
          prod.category_name || 'Botanical Formulations',
          preset.uom || 'Pcs',
          costPrice,
          mrp,
          sellingPrice,
          prod.gst_hsn_code || '33049990',
          Number(prod.gst_rate) || 18.00,
          qty,
          shopDisplay,
          vaultStock,
          preset.minStock || 15,
          preset.reorderQty || 50,
          preset.binCode || 'ASN-SHOP-R1-B01',
          preset.rackLocation || 'Zone A • Rack 01 • Shelf A',
          preset.batchNo || `BV-BATCH-2026-${prod.id}`,
          preset.mfgDate || '2026-08-01',
          preset.expiryDate || '2028-07-31',
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

module.exports = {
  VALID_INVENTORY_ROLES,
  INVENTORY_PERMISSION_DEFINITIONS,
  ROLE_DEFAULT_INVENTORY_PERMISSIONS,
  resolveInventoryPermissions,
  generateTotpSecret,
  verifyTotpCode,
  initInventorySoftwareTables,
  ensureInventorySoftwareTables,
  syncWebsiteProductsToInventoryMeta,
  recalculateAllBundleStocks,
  appendInventoryAuditLog,
  recordStockMovement,
  atomicAdjustProductStock,
};
