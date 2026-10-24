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
const { createReviewTable, seedAllCustomerReviews } = require('../models/reviewModel');
const { createNotificationTable } = require('../models/notificationModel');
const { createClientErrorTable } = require('../models/clientErrorModel');
const { createSettingsTable } = require('../models/settingsModel');
const { createCartRulesTable } = require('../models/cartRulesModel');
const { createLoyaltyTierTable } = require('../models/loyaltyTierModel');
const { createNewsletterTable } = require('../models/newsletterModel');
const { createShippingTable } = require('../models/shippingModel');
const { initSerialTable } = require('../models/serialModel');
const { initImpactTables, upgradeImpactContributionSchema } = require('../models/impactModel');
const { initSubcategoriesTable } = require('../models/subcategoryModel');
const { createWishlistTable } = require('../models/wishlistModel');
const { createRecommendationTables } = require('../models/recommendationModel');
const { createCouponTable } = require('../models/couponModel');
const { initShippingLabelTables } = require('../models/shippingLabelModel');
const { initGstAccountingTables } = require('../models/gstAccountingModel');
const { initWarrantyTable } = require('../models/warrantyModel');
const { initReturnRefundTable } = require('../models/returnRefundModel');
const { initAiSupportTables } = require('../models/aiSupportModel');
const { initSuperAdminFortressTables } = require('../models/superAdminVaultModel');
const { correctOutdatedSiteMetadata } = require('../utils/siteMetadataMigration');
const { seedLuxuryCatalog } = require('../scripts/seedLuxuryCatalog');
const { generateOrderNumber } = require('../services/orderNumber');
const {
  DEFAULT_ORDER_SPIN_REWARDS,
  LEGACY_DEFAULT_ORDER_SPIN_REWARDS,
  validateOrderSpinRewards,
} = require('../services/orderSpinPolicy');
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
  {
    version: 44,
    name: 'reward both referral participants and stack promotions',
    up: async () => {
      const addColumn = async (table, column, definition) => {
        const [columns] = await pool.query(`SHOW COLUMNS FROM \`${table}\` LIKE ?`, [column]);
        if (!columns.length) await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
      };
      await addColumn('referral_settings', 'referred_reward_amount', 'DECIMAL(10,2) NOT NULL DEFAULT 500.00');
      await addColumn('referral_claims', 'referred_wallet_amount', 'DECIMAL(10,2) NOT NULL DEFAULT 0.00');
      await addColumn('referral_rewards', 'referred_wallet_amount', 'DECIMAL(10,2) NOT NULL DEFAULT 0.00');
      await pool.query(
        `UPDATE referral_settings
         SET reward_mode = 'wallet_coupon', wallet_reward_amount = 500, referred_reward_amount = 500
         WHERE id = 1`
      );
      await pool.query("UPDATE settings SET value = 'both' WHERE key_name = 'coupon_stack_policy' AND value = 'rule_first'");
    },
  },
  {
    version: 45,
    name: 'record customer terms acceptance',
    up: async () => {
      const addColumn = async (table, column, definition) => {
        const [columns] = await pool.query(`SHOW COLUMNS FROM \`${table}\` LIKE ?`, [column]);
        if (!columns.length) await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
      };
      for (const table of ['users', 'pending_registrations', 'orders']) {
        await addColumn(table, 'terms_version', 'VARCHAR(20) DEFAULT NULL');
        await addColumn(table, 'terms_accepted_at', 'DATETIME DEFAULT NULL');
      }
    },
  },
  {
    version: 46,
    name: 'activate loyalty matrix and lifetime tier points',
    up: async () => {
      for (const [table, column, definition] of [
        ['users', 'loyalty_lifetime_points', 'INT UNSIGNED NOT NULL DEFAULT 0'],
        ['orders', 'tier_discount', 'DECIMAL(10,2) NOT NULL DEFAULT 0.00'],
        ['loyalty_tiers', 'points_multiplier', 'DECIMAL(6,2) NOT NULL DEFAULT 1.00'],
        ['loyalty_tiers', 'tier_discount_percent', 'DECIMAL(5,2) NOT NULL DEFAULT 0.00'],
        ['loyalty_tiers', 'cashback_percent', 'DECIMAL(5,2) NOT NULL DEFAULT 0.00'],
        ['loyalty_tiers', 'free_shipping', 'TINYINT(1) NOT NULL DEFAULT 0'],
        ['loyalty_tiers', 'bonus_points', 'INT UNSIGNED NOT NULL DEFAULT 0'],
      ]) {
        const [columns] = await pool.query(`SHOW COLUMNS FROM \`${table}\` LIKE ?`, [column]);
        if (!columns.length) await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
      }
      await pool.query('UPDATE users SET loyalty_lifetime_points = loyalty_points WHERE loyalty_lifetime_points = 0 AND loyalty_points > 0');
      await pool.query("UPDATE settings SET value = '0.1' WHERE key_name = 'loyalty_points_per_rupee' AND value = '10'");
      for (const [key, value] of [
        ['loyalty_program_enabled', '1'],
        ['loyalty_redemption_points_per_rupee', '10'],
        ['loyalty_max_redemption_percent', '20'],
        ['loyalty_minimum_redemption_points', '100'],
      ]) {
        await pool.query(
          "INSERT IGNORE INTO settings (key_name, value, group_name) VALUES (?, ?, 'loyalty')",
          [key, value]
        );
      }
      await pool.query(`
        UPDATE loyalty_tiers SET
          points_multiplier = CASE name WHEN 'Silver' THEN 1.25 WHEN 'Gold' THEN 1.5 WHEN 'Platinum' THEN 2 ELSE points_multiplier END,
          tier_discount_percent = CASE name WHEN 'Gold' THEN 2 WHEN 'Platinum' THEN 3 ELSE tier_discount_percent END,
          cashback_percent = CASE name WHEN 'Gold' THEN 0.5 WHEN 'Platinum' THEN 1 ELSE cashback_percent END,
          free_shipping = CASE WHEN name IN ('Silver', 'Gold', 'Platinum') THEN 1 ELSE free_shipping END
        WHERE points_multiplier = 1 AND tier_discount_percent = 0 AND cashback_percent = 0 AND free_shipping = 0
      `);
    },
  },
  {
    version: 47,
    name: 'audit loyalty point transactions',
    up: async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS loyalty_point_transactions (
          id BIGINT AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL,
          points_delta INT NOT NULL,
          balance_after INT UNSIGNED NOT NULL,
          type ENUM('earn','redeem','reversal','adjustment') NOT NULL,
          description VARCHAR(255) NOT NULL,
          reference_id VARCHAR(120) NOT NULL UNIQUE,
          order_id INT DEFAULT NULL,
          created_by_admin_id INT DEFAULT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_loyalty_points_user_created (user_id, created_at),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
    },
  },
  {
    version: 48,
    name: 'add webauthn passkey authentication',
    up: async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS webauthn_credentials (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
          account_type ENUM('customer','admin') NOT NULL,
          account_id INT NOT NULL,
          credential_id VARCHAR(1024) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
          public_key VARBINARY(4096) NOT NULL,
          counter BIGINT UNSIGNED NOT NULL DEFAULT 0,
          transports JSON DEFAULT NULL,
          device_name VARCHAR(100) NOT NULL DEFAULT 'Passkey device',
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          last_used_at DATETIME(6) DEFAULT NULL,
          UNIQUE KEY uq_webauthn_credential_id (credential_id),
          INDEX idx_webauthn_account (account_type, account_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS webauthn_challenges (
          challenge_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
          purpose ENUM('registration','authentication') NOT NULL,
          account_type ENUM('customer','admin') NOT NULL,
          account_id INT NOT NULL,
          challenge VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
          origin VARCHAR(255) NOT NULL,
          rp_id VARCHAR(255) NOT NULL,
          expires_at DATETIME NOT NULL,
          consumed_at DATETIME DEFAULT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_webauthn_challenges_expiry (expires_at, consumed_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
    },
  },
  {
    version: 49,
    name: 'allow discoverable passkey sign-in',
    up: async () => {
      await pool.query('ALTER TABLE webauthn_challenges MODIFY COLUMN account_id INT NULL');
    },
  },
  {
    version: 50,
    name: 'expand customer password reset OTP hashes',
    up: async () => {
      await pool.query('ALTER TABLE users MODIFY COLUMN reset_otp VARCHAR(64) DEFAULT NULL');
    },
  },
  {
    version: 51,
    name: 'persist system error diagnostics',
    up: async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS system_error_events (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
          source ENUM('api','database') NOT NULL,
          request_id VARCHAR(64) DEFAULT NULL,
          error_code VARCHAR(100) DEFAULT NULL,
          sql_state VARCHAR(10) DEFAULT NULL,
          sql_fingerprint CHAR(64) DEFAULT NULL,
          sql_template VARCHAR(2000) DEFAULT NULL,
          http_status SMALLINT UNSIGNED DEFAULT NULL,
          method VARCHAR(12) DEFAULT NULL,
          endpoint VARCHAR(500) DEFAULT NULL,
          occurred_at DATETIME(3) NOT NULL,
          INDEX idx_system_error_occurred_at (occurred_at),
          INDEX idx_system_error_source_time (source, occurred_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
    },
  },
  {
    version: 52,
    name: 'record optional ad-personalization consent',
    up: async () => {
      for (const [table, columns] of [
        ['users', [
          ['ad_personalization_opt_in', 'TINYINT(1) NOT NULL DEFAULT 0'],
          ['ad_personalization_consent_at', 'DATETIME NULL'],
          ['ad_personalization_consent_version', 'VARCHAR(40) DEFAULT NULL'],
        ]],
        ['pending_registrations', [
          ['ad_personalization_opt_in', 'TINYINT(1) NOT NULL DEFAULT 0'],
          ['ad_personalization_consent_version', 'VARCHAR(40) DEFAULT NULL'],
        ]],
      ]) {
        for (const [column, definition] of columns) {
          const [existing] = await pool.query(`SHOW COLUMNS FROM ${table} LIKE ?`, [column]);
          if (!existing.length) await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        }
      }
      await pool.query(`
        DELETE FROM user_product_views
        WHERE user_id IN (SELECT id FROM users WHERE ad_personalization_opt_in = 0)
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS privacy_consent_events (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL,
          purpose VARCHAR(40) NOT NULL,
          granted TINYINT(1) NOT NULL,
          notice_version VARCHAR(40) NOT NULL,
          source ENUM('registration','profile') NOT NULL,
          recorded_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
          INDEX idx_privacy_consent_user_purpose_time (user_id, purpose, recorded_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
    },
  },
  {
    version: 53,
    name: 'require updated consent for product recommendations',
    up: async () => {
      await pool.query(`
        ALTER TABLE privacy_consent_events
        MODIFY COLUMN source ENUM('registration','profile','system') NOT NULL
      `);
      await pool.query(`
        INSERT INTO privacy_consent_events (user_id, purpose, granted, notice_version, source)
        SELECT id, 'personalized_recommendations', 0, 'product-recommendations-v2', 'system'
        FROM users
        WHERE ad_personalization_opt_in = 1
          AND (ad_personalization_consent_version IS NULL OR ad_personalization_consent_version <> 'product-recommendations-v2')
      `);
      await pool.query(`
        UPDATE users
        SET ad_personalization_opt_in = 0,
            ad_personalization_consent_at = NULL,
            ad_personalization_consent_version = NULL
        WHERE ad_personalization_opt_in = 1
          AND (ad_personalization_consent_version IS NULL OR ad_personalization_consent_version <> 'product-recommendations-v2')
      `);
      await pool.query(`
        UPDATE pending_registrations
        SET ad_personalization_opt_in = 0,
            ad_personalization_consent_version = NULL
        WHERE ad_personalization_opt_in = 1
          AND (ad_personalization_consent_version IS NULL OR ad_personalization_consent_version <> 'product-recommendations-v2')
      `);
      await pool.query(`
        DELETE FROM user_product_views
        WHERE user_id IN (SELECT id FROM users WHERE ad_personalization_opt_in = 0)
      `);
    },
  },
  {
    version: 54,
    name: 'add restricted coupon credit rewards',
    up: async () => {
      const addColumn = async (table, column, definition) => {
        const [columns] = await pool.query(`SHOW COLUMNS FROM \`${table}\` LIKE ?`, [column]);
        if (!columns.length) await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
      };

      await pool.query(
        "ALTER TABLE coupons MODIFY COLUMN reward_type ENUM('standard','referral_wallet','coupon_credit') NOT NULL DEFAULT 'standard'"
      );
      await addColumn('coupons', 'reward_order_id', 'INT DEFAULT NULL');
      const [rewardOrderIndex] = await pool.query("SHOW INDEX FROM coupons WHERE Key_name = 'uq_coupon_reward_order'");
      if (!rewardOrderIndex.length) {
        await pool.query('CREATE UNIQUE INDEX uq_coupon_reward_order ON coupons (reward_order_id)');
      }
      await addColumn('orders', 'coupon_credit_eligible_subtotal', 'DECIMAL(10,2) NOT NULL DEFAULT 0.00');
      await addColumn('orders', 'coupon_credit_awarded_amount', 'DECIMAL(10,2) NOT NULL DEFAULT 0.00');
      await addColumn('orders', 'coupon_credit_reversed_amount', 'DECIMAL(10,2) NOT NULL DEFAULT 0.00');
      await addColumn('orders', 'coupon_credit_awarded_at', 'DATETIME DEFAULT NULL');
      await pool.query(`
        CREATE TABLE IF NOT EXISTS coupon_credit_offsets (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL,
          source_order_id INT NOT NULL,
          amount_due DECIMAL(10,2) NOT NULL DEFAULT 0.00,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uq_coupon_credit_offset_source (source_order_id),
          INDEX idx_coupon_credit_offset_user (user_id, amount_due, id),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (source_order_id) REFERENCES orders(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
    },
  },
  {
    version: 55,
    name: 'add shopping-only wallet rewards',
    up: async () => {
      const addColumn = async (table, column, definition) => {
        const [columns] = await pool.query(`SHOW COLUMNS FROM \`${table}\` LIKE ?`, [column]);
        if (!columns.length) await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
      };

      await addColumn('orders', 'shopping_wallet_reward_amount', 'DECIMAL(10,2) NOT NULL DEFAULT 0.00');
      await addColumn('orders', 'shopping_wallet_reward_reversed_amount', 'DECIMAL(10,2) NOT NULL DEFAULT 0.00');
      await addColumn('orders', 'shopping_wallet_reward_awarded_at', 'DATETIME DEFAULT NULL');
    },
  },
  {
    version: 56,
    name: 'create post-order spin reward claims',
    up: async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS order_spin_claims (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
          order_id INT NOT NULL,
          user_id INT NOT NULL,
          reward_label VARCHAR(120) NOT NULL,
          coupon_code VARCHAR(50) NOT NULL UNIQUE,
          reward_index TINYINT UNSIGNED NOT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uq_order_spin_claim_order (order_id),
          INDEX idx_order_spin_claim_user (user_id, created_at),
          FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
    },
  },
  {
    version: 57,
    name: 'add public nine-digit order references',
    up: async () => {
      const [columns] = await pool.query("SHOW COLUMNS FROM orders LIKE 'order_number'");
      if (!columns.length) await pool.query('ALTER TABLE orders ADD COLUMN order_number CHAR(9) DEFAULT NULL');

      const [orders] = await pool.query('SELECT id FROM orders WHERE order_number IS NULL ORDER BY id');
      for (const order of orders) {
        await pool.query('UPDATE orders SET order_number = ? WHERE id = ? AND order_number IS NULL', [
          generateOrderNumber(),
          order.id,
        ]);
      }

      await pool.query('ALTER TABLE orders MODIFY COLUMN order_number CHAR(9) NOT NULL');
      const [indexes] = await pool.query("SHOW INDEX FROM orders WHERE Key_name = 'uq_orders_order_number'");
      if (!indexes.length) {
        await pool.query('CREATE UNIQUE INDEX uq_orders_order_number ON orders (order_number)');
      }
      await pool.query(
        "UPDATE settings SET value = '1' WHERE key_name = 'gamification_spin_after_purchase_enabled'"
      );
    },
  },
  {
    version: 58,
    name: 'seed default post-order spin rewards',
    up: async () => {
      const [settings] = await pool.query(
        'SELECT value FROM settings WHERE key_name = ?',
        ['gamification_order_spin_rewards']
      );
      if (validateOrderSpinRewards(settings[0]?.value).valid) return;

      const rewards = JSON.stringify(DEFAULT_ORDER_SPIN_REWARDS);
      await pool.query(
        `INSERT INTO settings (key_name, value, group_name)
         VALUES ('gamification_order_spin_rewards', ?, 'gamification')
         ON DUPLICATE KEY UPDATE value = IF(value IS NULL OR TRIM(value) = '', VALUES(value), value)`,
        [rewards]
      );
    },
  },
  {
    version: 59,
    name: 'support spin rewards for free shipping and loyalty points',
    up: async () => {
      await pool.query(
        "ALTER TABLE coupons MODIFY COLUMN reward_type ENUM('standard','referral_wallet','coupon_credit','free_shipping') NOT NULL DEFAULT 'standard'"
      );
      const addColumn = async (column, definition) => {
        const [columns] = await pool.query(`SHOW COLUMNS FROM order_spin_claims LIKE ?`, [column]);
        if (!columns.length) await pool.query(`ALTER TABLE order_spin_claims ADD COLUMN \`${column}\` ${definition}`);
      };
      await pool.query('ALTER TABLE order_spin_claims MODIFY COLUMN coupon_code VARCHAR(50) NULL');
      await addColumn('reward_type', "VARCHAR(30) NOT NULL DEFAULT 'discount'");
      await addColumn('points_awarded', 'INT UNSIGNED NOT NULL DEFAULT 0');
    },
  },
  {
    version: 60,
    name: 'initialize autonomous ai customer support engine schema',
    up: () => initAiSupportTables(pool),
  },
  {
    version: 61,
    name: 'upgrade tamperproof coupon ledger and unify coupon columns',
    up: () => createCouponTable(),
  },
  {
    version: 62,
    name: 'initialize superadmin security vault, 108-module rbac matrix, and atomic wallet refund ledger',
    up: () => initSuperAdminFortressTables(pool),
  },
  {
    version: 63,
    name: 'link impact contributions to verified Razorpay payments and certificates',
    up: upgradeImpactContributionSchema,
  },
  {
    version: 64,
    name: 'apply configured post-order reward spin weights',
    up: async () => {
      const [settings] = await pool.query(
        'SELECT value FROM settings WHERE key_name = ?',
        ['gamification_order_spin_rewards']
      );
      if (!settings.length) {
        await pool.query(
          `INSERT INTO settings (key_name, value, group_name)
           VALUES ('gamification_order_spin_rewards', ?, 'gamification')`,
          [JSON.stringify(DEFAULT_ORDER_SPIN_REWARDS)]
        );
        return;
      }

      let savedRewards;
      try {
        savedRewards = JSON.parse(settings[0].value);
      } catch {
        return;
      }
      if (JSON.stringify(savedRewards) !== JSON.stringify(LEGACY_DEFAULT_ORDER_SPIN_REWARDS)) return;
      await pool.query(
        `UPDATE settings
         SET value = ?, group_name = 'gamification'
         WHERE key_name = 'gamification_order_spin_rewards'`,
        [JSON.stringify(DEFAULT_ORDER_SPIN_REWARDS)]
      );
    },
  },
  {
    version: 65,
    name: 'add terms and conditions to coupons',
    up: () => createCouponTable(),
  },
  {
    version: 66,
    name: 'purge legacy catalog artifacts and seed luxury geo catalog',
    up: () => seedLuxuryCatalog(pool),
  },
  {
    version: 67,
    name: 'initialize product questions schema',
    up: async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS product_questions (
          id INT AUTO_INCREMENT PRIMARY KEY,
          product_id INT NOT NULL,
          user_id INT NULL,
          user_name VARCHAR(100) DEFAULT 'Customer',
          question TEXT NOT NULL,
          answer TEXT NULL,
          is_approved TINYINT(1) DEFAULT 1,
          helpful_count INT DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_prod (product_id)
        )
      `);
    },
  },
  {
    version: 68,
    name: 'add customer profile image',
    up: async () => {
      const [columns] = await pool.query("SHOW COLUMNS FROM users LIKE 'profile_image_url'");
      if (columns.length === 0) {
        await pool.query('ALTER TABLE users ADD COLUMN profile_image_url VARCHAR(512) DEFAULT NULL');
      }
    },
  },
  {
    version: 69,
    name: 'seed 1080 classified customer reviews (2020-2026) and sync product ratings',
    up: () => seedAllCustomerReviews(pool),
  },
  {
    version: 70,
    name: 'replace legacy bot reviews with 1080 natural multi-length Indian marketplace reviews v3',
    up: () => seedAllCustomerReviews(pool),
  },
  {
    version: 71,
    name: 'purge bot reviews and reseed 1080 authentic pan-India multilingual marketplace reviews v4',
    up: async () => {
      try {
        await pool.query("DELETE FROM reviews WHERE order_number LIKE 'BV-ORD-%'");
      } catch (_) {}
      return seedAllCustomerReviews(pool);
    },
  },
];

module.exports = migrations;
