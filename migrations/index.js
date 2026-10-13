const { initWarehouseTables } = require('../models/warehouseModel');
const { initWalletTables } = require('../models/walletModel');
const { createCartTable } = require('../models/cartModel');
const { createOrdersTables } = require('../models/orderModel');
const { createAddressTable } = require('../models/addressModel');
const { initProductsTable } = require('../models/productModel');
const { initCategoriesTable, initCategoryAuditTable } = require('../models/categoryModel');
const { initReturnsTable } = require('../models/returnModel');
const { initContactTable } = require('../models/contactModel');
const { initAdminTable } = require('../models/adminModel');
const { createUsersTable, initAuthTables } = require('../models/userModel');
const { createReviewTable } = require('../models/reviewModel');
const { createNotificationTable } = require('../models/notificationModel');
const { createClientErrorTable } = require('../models/clientErrorModel');
const { createSettingsTable } = require('../models/settingsModel');
const { createCartRulesTable } = require('../models/cartRulesModel');
const { createLoyaltyTierTable } = require('../models/loyaltyTierModel');
const { createNewsletterTable } = require('../models/newsletterModel');
const { createShippingTable } = require('../models/shippingModel');
const { initSerialTable } = require('../models/serialModel');
const { initImpactTables } = require('../models/impactModel');
const { initSubcategoriesTable } = require('../models/subcategoryModel');
const { createWishlistTable } = require('../models/wishlistModel');
const { createRecommendationTables } = require('../models/recommendationModel');
const { createCouponTable } = require('../models/couponModel');
const { initShippingLabelTables } = require('../models/shippingLabelModel');
const { initGstAccountingTables } = require('../models/gstAccountingModel');
const { initWarrantyTable } = require('../models/warrantyModel');
const { initReturnRefundTable } = require('../models/returnRefundModel');
const { correctOutdatedSiteMetadata } = require('../utils/siteMetadataMigration');
const pool = require('../config/db');

const migrations = [
  { version: 1, name: 'create users table', up: createUsersTable },
  { version: 2, name: 'initialize authentication schema', up: initAuthTables },
  { version: 3, name: 'initialize categories schema', up: initCategoriesTable },
  { version: 4, name: 'initialize subcategories schema', up: initSubcategoriesTable },
  { version: 5, name: 'initialize products schema', up: initProductsTable },
  { version: 6, name: 'initialize product serials schema', up: initSerialTable },
  { version: 7, name: 'initialize reviews schema', up: createReviewTable },
  { version: 8, name: 'initialize notifications schema', up: createNotificationTable },
  { version: 9, name: 'initialize address schema', up: createAddressTable },
  { version: 10, name: 'initialize wallet schema', up: initWalletTables },
  { version: 11, name: 'initialize wishlist schema', up: createWishlistTable },
  { version: 12, name: 'initialize product recommendations schema', up: createRecommendationTables },
  { version: 13, name: 'initialize cart schema', up: createCartTable },
  { version: 14, name: 'initialize coupon schema', up: createCouponTable },
  { version: 15, name: 'initialize orders schema', up: createOrdersTables },
  { version: 16, name: 'initialize GST accounting schema', up: initGstAccountingTables },
  { version: 17, name: 'initialize impact ledger schema', up: initImpactTables },
  { version: 18, name: 'initialize returns schema', up: initReturnsTable },
  { version: 19, name: 'initialize shipping labels schema', up: initShippingLabelTables },
  { version: 20, name: 'initialize support schema', up: initContactTable },
  { version: 21, name: 'initialize admin schema', up: initAdminTable },
  { version: 22, name: 'initialize warehouse schema', up: initWarehouseTables },
  { version: 23, name: 'initialize settings schema', up: createSettingsTable },
  { version: 24, name: 'initialize cart rules schema', up: createCartRulesTable },
  { version: 25, name: 'initialize loyalty tiers schema', up: createLoyaltyTierTable },
  { version: 26, name: 'initialize newsletter schema', up: createNewsletterTable },
  { version: 27, name: 'initialize shipping zones schema', up: createShippingTable },
  { version: 28, name: 'initialize client error log schema', up: createClientErrorTable },
  {
    version: 29,
    name: 'seed legacy site settings',
    up: async () => {
      const initialSettings = [
        ['general', 'site_name', 'Bhumivera'],
        ['seo', 'meta_title', 'Bhumivera | Botanical Science'],
        ['policy', 'return_policy', '15-day botanical window'],
      ];
      for (const [group, key, value] of initialSettings) {
        await pool.query(
          'INSERT IGNORE INTO settings (group_name, key_name, value) VALUES (?, ?, ?)',
          [group, key, value]
        );
      }
    },
  },
  { version: 30, name: 'initialize warranty registrations schema', up: initWarrantyTable },
  {
    version: 31,
    name: 'record Razorpay webhook deliveries',
    up: async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS razorpay_webhook_events (
          event_id VARCHAR(100) NOT NULL PRIMARY KEY,
          event_type VARCHAR(100) NOT NULL,
          received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_razorpay_webhook_received_at (received_at)
        ) ENGINE=InnoDB
      `);
    },
  },
  {
    version: 32,
    name: 'enforce unique online payment IDs',
    up: async () => {
      const [duplicates] = await pool.query(`
        SELECT payment_id, COUNT(*) AS order_count
        FROM orders
        WHERE payment_id IS NOT NULL AND payment_id <> ''
        GROUP BY payment_id
        HAVING COUNT(*) > 1
        LIMIT 1
      `);
      if (duplicates.length > 0) {
        throw new Error('Duplicate payment IDs already exist in orders; reconcile these rows before applying the unique payment index.');
      }
      const [indexes] = await pool.query("SHOW INDEX FROM orders WHERE Key_name = 'uq_orders_payment_id'");
      if (indexes.length === 0) {
        await pool.query('CREATE UNIQUE INDEX uq_orders_payment_id ON orders (payment_id)');
      }
    },
  },
  {
    version: 33,
    name: 'associate warranty registrations with customers',
    up: initWarrantyTable,
  },
  {
    version: 34,
    name: 'record category administration audit history',
    up: initCategoryAuditTable,
  },
  {
    version: 35,
    name: 'record provider-backed return refund requests',
    up: initReturnRefundTable,
  },
  {
    version: 36,
    name: 'correct legacy electronics SEO defaults',
    up: () => correctOutdatedSiteMetadata(pool),
  },
  {
    version: 37,
    name: 'record order WhatsApp notification consent',
    up: async () => {
      const [columns] = await pool.query("SHOW COLUMNS FROM orders LIKE 'whatsapp_updates_opt_in'");
      if (columns.length === 0) {
        await pool.query('ALTER TABLE orders ADD COLUMN whatsapp_updates_opt_in TINYINT(1) NOT NULL DEFAULT 0');
      }
      const [consentColumns] = await pool.query("SHOW COLUMNS FROM orders LIKE 'whatsapp_consent_at'");
      if (consentColumns.length === 0) {
        await pool.query('ALTER TABLE orders ADD COLUMN whatsapp_consent_at DATETIME DEFAULT NULL');
      }
    },
  },
  {
    version: 38,
    name: 'record customer WhatsApp order update preferences',
    up: async () => {
      const [columns] = await pool.query("SHOW COLUMNS FROM users LIKE 'whatsapp_order_updates_opt_in'");
      if (columns.length === 0) {
        await pool.query('ALTER TABLE users ADD COLUMN whatsapp_order_updates_opt_in TINYINT(1) NOT NULL DEFAULT 0');
      }
      const [consentColumns] = await pool.query("SHOW COLUMNS FROM users LIKE 'whatsapp_order_updates_consent_at'");
      if (consentColumns.length === 0) {
        await pool.query('ALTER TABLE users ADD COLUMN whatsapp_order_updates_consent_at DATETIME DEFAULT NULL');
      }
    },
  },
  {
    version: 39,
    name: 'initialize referral rewards',
    up: async () => {
      for (const [table, column, definition] of [
        ['users', 'referred_by_user_id', 'INT DEFAULT NULL'],
        ['pending_registrations', 'referrer_user_id', 'INT DEFAULT NULL'],
      ]) {
        const [columns] = await pool.query(`SHOW COLUMNS FROM ${table} LIKE ?`, [column]);
        if (columns.length === 0) await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      }
      const [referrerIndex] = await pool.query("SHOW INDEX FROM users WHERE Key_name = 'idx_users_referred_by'");
      if (referrerIndex.length === 0) await pool.query('CREATE INDEX idx_users_referred_by ON users (referred_by_user_id)');
      await pool.query(`
        CREATE TABLE IF NOT EXISTS referral_codes (
          user_id INT NOT NULL PRIMARY KEY,
          code VARCHAR(32) NOT NULL UNIQUE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS referral_settings (
          id TINYINT NOT NULL PRIMARY KEY,
          enabled TINYINT(1) NOT NULL DEFAULT 1,
          reward_mode ENUM('wallet','coupon','wallet_coupon') NOT NULL DEFAULT 'wallet',
          wallet_reward_amount DECIMAL(10,2) NOT NULL DEFAULT 100,
          coupon_discount_type ENUM('fixed','percentage') NOT NULL DEFAULT 'fixed',
          coupon_discount_value DECIMAL(10,2) NOT NULL DEFAULT 100,
          coupon_min_order_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
          coupon_valid_days INT NOT NULL DEFAULT 30,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS referral_rewards (
          id BIGINT AUTO_INCREMENT PRIMARY KEY,
          referred_user_id INT NOT NULL UNIQUE,
          referrer_user_id INT NOT NULL,
          order_id INT NOT NULL UNIQUE,
          wallet_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
          coupon_code VARCHAR(50) DEFAULT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_referral_rewards_referrer (referrer_user_id, created_at),
          FOREIGN KEY (referred_user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (referrer_user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB
      `);
    },
  },
  {
    version: 40,
    name: 'add referral review and timed approvals',
    up: async () => {
      const [linkExpiryColumn] = await pool.query("SHOW COLUMNS FROM referral_codes LIKE 'link_expires_at'");
      if (linkExpiryColumn.length === 0) {
        await pool.query('ALTER TABLE referral_codes ADD COLUMN link_expires_at DATETIME DEFAULT NULL');
      }
      await pool.query(`
        CREATE TABLE IF NOT EXISTS referral_claims (
          id BIGINT AUTO_INCREMENT PRIMARY KEY,
          referred_user_id INT NOT NULL UNIQUE,
          referrer_user_id INT NOT NULL,
          status ENUM('pending','approved','auto_approved','rejected') NOT NULL DEFAULT 'pending',
          verified_at DATETIME NOT NULL,
          auto_approve_at DATETIME NOT NULL,
          reviewed_at DATETIME DEFAULT NULL,
          reviewed_by_admin_id INT DEFAULT NULL,
          decision_reason VARCHAR(255) DEFAULT NULL,
          wallet_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
          coupon_code VARCHAR(50) DEFAULT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_referral_claims_queue (status, auto_approve_at),
          INDEX idx_referral_claims_referrer (referrer_user_id, verified_at),
          FOREIGN KEY (referred_user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (referrer_user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB
      `);
      const [orderIdColumn] = await pool.query("SHOW COLUMNS FROM referral_rewards LIKE 'order_id'");
      if (orderIdColumn.length && orderIdColumn[0].Null === 'NO') {
        await pool.query('ALTER TABLE referral_rewards MODIFY COLUMN order_id INT NULL');
      }
      await pool.query(`
        INSERT IGNORE INTO referral_claims
          (referred_user_id, referrer_user_id, status, verified_at, auto_approve_at, reviewed_at, wallet_amount, coupon_code)
        SELECT referred.id, referred.referred_by_user_id,
          IF(reward.id IS NULL, 'pending', 'auto_approved'),
          COALESCE(reward.created_at, NOW()),
          DATE_ADD(NOW(), INTERVAL 60 MINUTE),
          reward.created_at,
          COALESCE(reward.wallet_amount, 0),
          reward.coupon_code
        FROM users referred
        LEFT JOIN referral_rewards reward ON reward.referred_user_id = referred.id
        WHERE referred.referred_by_user_id IS NOT NULL
      `);
    },
  },
  {
    version: 41,
    name: 'separate restricted referral wallet credits',
    up: async () => {
      const addColumn = async (table, column, definition) => {
        const [columns] = await pool.query(`SHOW COLUMNS FROM \`${table}\` LIKE ?`, [column]);
        if (!columns.length) await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
      };

      await addColumn('referral_settings', 'wallet_reward_per_order_limit', 'DECIMAL(10,2) NOT NULL DEFAULT 100.00');
      await addColumn('referral_claims', 'wallet_bucket', "ENUM('cash','referral') NOT NULL DEFAULT 'cash'");
      await addColumn('coupons', 'reward_type', "ENUM('standard','referral_wallet') NOT NULL DEFAULT 'standard'");
      await addColumn('coupons', 'wallet_per_order_limit', 'DECIMAL(10,2) DEFAULT NULL');
      await addColumn('orders', 'referral_wallet_amount', 'DECIMAL(10,2) NOT NULL DEFAULT 0.00');

      await pool.query(`
        CREATE TABLE IF NOT EXISTS referral_wallets (
          user_id INT NOT NULL PRIMARY KEY,
          balance DECIMAL(10,2) NOT NULL DEFAULT 0.00,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS referral_wallet_transactions (
          id BIGINT AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL,
          amount DECIMAL(10,2) NOT NULL,
          type ENUM('credit','debit') NOT NULL,
          description VARCHAR(255) NOT NULL,
          reference_id VARCHAR(100) NOT NULL,
          coupon_code VARCHAR(50) DEFAULT NULL,
          order_id INT DEFAULT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uq_referral_wallet_reference (user_id, reference_id),
          INDEX idx_referral_wallet_history (user_id, created_at),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL
        ) ENGINE=InnoDB
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS wallet_topups (
          id BIGINT AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL,
          payment_id VARCHAR(100) NOT NULL,
          payment_order_id VARCHAR(100) NOT NULL,
          amount DECIMAL(10,2) NOT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uq_wallet_topup_payment (payment_id),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB
      `);
    },
  },
  {
    version: 42,
    name: 'preserve legacy spendable wallet balances',
    up: async () => {
      await pool.query(`
        INSERT IGNORE INTO wallets (user_id, balance)
        SELECT id, COALESCE(wallet_balance, 0.00)
        FROM users
      `);
    },
  },
  {
    version: 43,
    name: 'configure automatic referral wallet redemption',
    up: async () => {
      const [tiersColumn] = await pool.query("SHOW COLUMNS FROM referral_settings LIKE 'referral_redemption_tiers'");
      if (!tiersColumn.length) {
        await pool.query('ALTER TABLE referral_settings ADD COLUMN referral_redemption_tiers TEXT DEFAULT NULL');
      }
      await pool.query(
        `UPDATE referral_settings SET reward_mode = 'wallet_coupon',
          wallet_reward_amount = CASE WHEN wallet_reward_amount IN (100, 1000) THEN 500 ELSE wallet_reward_amount END
         WHERE id = 1 AND (reward_mode = 'wallet' OR
           (reward_mode = 'wallet_coupon' AND wallet_reward_amount IN (100, 1000)))`
      );
    },
  },
];

module.exports = migrations;
