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
];

module.exports = migrations;
