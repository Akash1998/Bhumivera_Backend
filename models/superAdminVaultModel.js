'use strict';

const crypto = require('crypto');
const {
  hashSecretFortress,
  verifySecretFortress,
  normalizeSecurityAnswer,
  encryptVaultJson,
  decryptVaultJson,
  computeQuantumHash512,
} = require('../utils/fortressCrypto');
const { hashOtp, compareOtp } = require('../utils/otpCrypto');

const SUPERADMIN_EMAIL = 'adminbhumivera27@gmail.com';
const VALID_ACCESS_LEVELS = Object.freeze(['hidden', 'read', 'write', 'full']);
const VALID_PORTALS = Object.freeze(['storefront', 'admin', 'warehouse', 'support', 'superadminsupport', 'controlcentre']);

/**
 * 108 Granular Platform Modules & Functions governed by the Single-Master Control Centre
 * (`/superadmin/controlcentre`) across all 5 Bhumivera Portals.
 */
const PLATFORM_MODULES_CATALOG = Object.freeze([
  // ── 1. STOREFRONT & MERCHANDISING (8 Modules) ───────────────────────────────
  { key: 'storefront.hero_banners', title: 'Storefront Hero & Editorial Campaigns', category: 'Main Storefront', portal: 'storefront', adminTab: 'overview', apiPrefixes: ['/api/settings/public'] },
  { key: 'storefront.collection_navigation', title: 'Explore the Collection Routing & Filters', category: 'Main Storefront', portal: 'storefront', adminTab: 'products', apiPrefixes: ['/api/products/active'] },
  { key: 'storefront.search_discovery', title: 'Botanical Search & Instant Discovery', category: 'Main Storefront', portal: 'storefront', adminTab: 'products', apiPrefixes: ['/api/search'], pauseKey: 'search' },
  { key: 'storefront.science_ingredients', title: 'Botanical Science & Ingredient Notes', category: 'Main Storefront', portal: 'storefront', adminTab: 'products', apiPrefixes: ['/api/products'] },
  { key: 'storefront.customer_stories', title: 'Community Stories & Verified Testimonials', category: 'Main Storefront', portal: 'storefront', adminTab: 'reviews', apiPrefixes: ['/api/reviews'], pauseKey: 'reviews' },
  { key: 'storefront.flash_editions', title: 'Limited Botanical Editions & Flash Releases', category: 'Main Storefront', portal: 'storefront', adminTab: 'flash-sales', apiPrefixes: ['/api/flash-sales'], pauseKey: 'flash_sales' },
  { key: 'storefront.newsletter_journal', title: 'Maison Journal & Newsletter Subscriptions', category: 'Main Storefront', portal: 'storefront', adminTab: 'notifications', apiPrefixes: ['/api/newsletter'], pauseKey: 'newsletter' },
  { key: 'storefront.seo_sitemap', title: 'SEO Structured Data & Dynamic XML Sitemap', category: 'Main Storefront', portal: 'storefront', adminTab: 'settings', apiPrefixes: ['/sitemap.xml'] },

  // ── 2. ORDERS & FULFILMENT GOVERNANCE (12 Modules) ──────────────────────────
  { key: 'orders.ledger_view', title: 'Global Order Ledger & Live Search', category: 'Orders', portal: 'admin', adminTab: 'orders', apiPrefixes: ['/api/orders/all', '/api/admin/orders'], pauseKey: 'orders' },
  { key: 'orders.status_progression', title: 'Order Status Progression (Confirm / Pack / Ship)', category: 'Orders', portal: 'admin', adminTab: 'orders', apiPrefixes: ['/api/orders'] },
  { key: 'orders.superadmin_cancellation', title: 'SuperAdmin Exclusive Order Cancellation', category: 'Orders', portal: 'controlcentre', adminTab: 'orders', apiPrefixes: ['/api/superadmin/controlcentre/orders', '/api/orders'] },
  { key: 'orders.payment_reconciliation', title: 'Razorpay Gateway Payment Reconciliation', category: 'Orders', portal: 'admin', adminTab: 'orders', apiPrefixes: ['/api/orders/admin/reconciliation/payments'], pauseKey: 'payments' },
  { key: 'orders.cod_eligibility_rules', title: 'Cash-on-Delivery Eligibility Policy', category: 'Orders', portal: 'admin', adminTab: 'orders', apiPrefixes: ['/api/orders/cod-eligibility'] },
  { key: 'orders.export_master_xlsx', title: '28-Column Master Orders XLSX Export', category: 'Orders', portal: 'admin', adminTab: 'orders', apiPrefixes: ['/api/orders/all'] },
  { key: 'orders.tracking_awb_assignment', title: 'Courier Partner & AWB Tracking Assignment', category: 'Orders', portal: 'admin', adminTab: 'orders', apiPrefixes: ['/api/orders'] },
  { key: 'orders.whatsapp_dispatch_alerts', title: 'Transactional Order Email & Dispatch Alerts', category: 'Orders', portal: 'admin', adminTab: 'orders', apiPrefixes: ['/api/notifications'] },
  { key: 'orders.checkout_cart_engine', title: 'Customer Cart & Atomic Checkout Engine', category: 'Orders', portal: 'storefront', adminTab: 'orders', apiPrefixes: ['/api/cart'], pauseKey: 'cart' },
  { key: 'orders.address_book_validation', title: 'Client Address Book & Pincode Validation', category: 'Orders', portal: 'storefront', adminTab: 'orders', apiPrefixes: ['/api/addresses'], pauseKey: 'addresses' },
  { key: 'orders.invoice_generation', title: 'Branded Tax Invoice Generation & Print', category: 'Orders', portal: 'admin', adminTab: 'orders', apiPrefixes: ['/api/gst'] },
  { key: 'orders.archival_retention', title: 'Historical Order Archival & Retention', category: 'Orders', portal: 'admin', adminTab: 'orders', apiPrefixes: ['/api/orders'] },

  // ── 3. PRODUCTS & BOTANICAL CATALOG (10 Modules) ────────────────────────────
  { key: 'products.catalog_list', title: 'Product Master Catalog & SKU Registry', category: 'Products', portal: 'admin', adminTab: 'products', apiPrefixes: ['/api/products'], pauseKey: 'products' },
  { key: 'products.create_formulation', title: 'Create New Botanical Formulation', category: 'Products', portal: 'admin', adminTab: 'products', apiPrefixes: ['/api/products'] },
  { key: 'products.edit_pricing_mrp', title: 'MRP, Offer Pricing & Margin Controls', category: 'Products', portal: 'admin', adminTab: 'products', apiPrefixes: ['/api/products'] },
  { key: 'products.media_gallery_s3', title: 'Cloudflare R2 / S3 Product Media Gallery', category: 'Products', portal: 'admin', adminTab: 'products', apiPrefixes: ['/api/products/presign'] },
  { key: 'products.ingredients_directions', title: 'Botanical Actives, Ingredients & Ritual Guide', category: 'Products', portal: 'admin', adminTab: 'products', apiPrefixes: ['/api/products'] },
  { key: 'products.editorial_copy_assistant', title: 'Editorial Product Copy & Metadata Studio', category: 'Products', portal: 'admin', adminTab: 'products', apiPrefixes: ['/api/ai'], pauseKey: 'ai' },
  { key: 'products.status_visibility', title: 'Product Active / Draft Visibility Toggle', category: 'Products', portal: 'admin', adminTab: 'products', apiPrefixes: ['/api/products'] },
  { key: 'products.qa_moderation', title: 'Product Q&A Client Inquiry Moderation', category: 'Products', portal: 'admin', adminTab: 'products', apiPrefixes: ['/api/products'] },
  { key: 'products.compare_matrix', title: 'Formulation Comparison Matrix', category: 'Products', portal: 'storefront', adminTab: 'products', apiPrefixes: ['/api/products'] },
  { key: 'products.wishlist_analytics', title: 'Client Wishlist & Demand Signals', category: 'Products', portal: 'admin', adminTab: 'products', apiPrefixes: ['/api/wishlist'], pauseKey: 'wishlist' },

  // ── 4. CATEGORIES & TAXONOMY (6 Modules) ────────────────────────────────────
  { key: 'categories.primary_taxonomy', title: 'Primary Ritual Categories', category: 'Categories', portal: 'admin', adminTab: 'categories', apiPrefixes: ['/api/categories'], pauseKey: 'categories' },
  { key: 'categories.subcategories', title: 'Subcategory Hierarchy & Mapping', category: 'Categories', portal: 'admin', adminTab: 'categories', apiPrefixes: ['/api/subcategories'] },
  { key: 'categories.slug_seo_routing', title: 'Category Slug & Canonical URL Routing', category: 'Categories', portal: 'admin', adminTab: 'categories', apiPrefixes: ['/api/categories'] },
  { key: 'categories.visual_merchandising', title: 'Category Cover Imagery & Editorial Copy', category: 'Categories', portal: 'admin', adminTab: 'categories', apiPrefixes: ['/api/categories'] },
  { key: 'categories.sort_priority', title: 'Navigation Display Order & Pinning', category: 'Categories', portal: 'admin', adminTab: 'categories', apiPrefixes: ['/api/categories'] },
  { key: 'categories.audit_reconciliation', title: 'Orphan SKU & Category Integrity Check', category: 'Categories', portal: 'admin', adminTab: 'categories', apiPrefixes: ['/api/categories'] },

  // ── 5. INVENTORY & PROVENANCE (8 Modules) ───────────────────────────────────
  { key: 'inventory.stock_ledger', title: 'Real-Time Stock Balance & Reservations', category: 'Inventory', portal: 'admin', adminTab: 'inventory', apiPrefixes: ['/api/inventory'], pauseKey: 'inventory' },
  { key: 'inventory.low_stock_alerts', title: 'Replenishment Thresholds & Low-Stock Alerts', category: 'Inventory', portal: 'admin', adminTab: 'inventory', apiPrefixes: ['/api/inventory'] },
  { key: 'inventory.batch_adjustments', title: 'Batch Stock Count & Audit Adjustments', category: 'Inventory', portal: 'admin', adminTab: 'inventory', apiPrefixes: ['/api/inventory'] },
  { key: 'inventory.serial_generation', title: 'Cryptographic Serial Number Generator', category: 'Inventory', portal: 'admin', adminTab: 'ewarranty', apiPrefixes: ['/api/serials'], pauseKey: 'serials' },
  { key: 'inventory.provenance_verification', title: 'Client Authenticity & Provenance Verification', category: 'Inventory', portal: 'storefront', adminTab: 'ewarranty', apiPrefixes: ['/api/serials/validate'] },
  { key: 'inventory.ewarranty_registry', title: 'E-Warranty Registration & Certificates', category: 'Inventory', portal: 'admin', adminTab: 'ewarranty', apiPrefixes: ['/api/warranty'], pauseKey: 'warranty' },
  { key: 'inventory.damaged_quarantine', title: 'Damaged / Returned Stock Quarantine', category: 'Inventory', portal: 'warehouse', adminTab: 'inventory', apiPrefixes: ['/api/inventory'] },
  { key: 'inventory.valuation_report', title: 'Inventory Cost & Retail Valuation Export', category: 'Inventory', portal: 'admin', adminTab: 'inventory', apiPrefixes: ['/api/inventory'] },

  // ── 6. WAREHOUSE PORTAL & DISPATCH (10 Modules) ─────────────────────────────
  { key: 'warehouse.dispatch_queue', title: 'Warehouse Live Pick, Pack & Dispatch Queue', category: 'Warehouse', portal: 'warehouse', adminTab: 'warehouse', apiPrefixes: ['/api/warehouse'], pauseKey: 'warehouse' },
  { key: 'warehouse.barcode_scanner', title: 'SKU & Serial Barcode Dispatch Scanner', category: 'Warehouse', portal: 'warehouse', adminTab: 'warehouse', apiPrefixes: ['/api/warehouse'] },
  { key: 'warehouse.packing_slips', title: 'Luxury Packing Slip & Manifest Printer', category: 'Warehouse', portal: 'warehouse', adminTab: 'warehouse', apiPrefixes: ['/api/warehouse'] },
  { key: 'warehouse.cutoff_sla_monitor', title: '2:00 PM IST Same-Day Dispatch SLA Tracker', category: 'Warehouse', portal: 'warehouse', adminTab: 'warehouse', apiPrefixes: ['/api/warehouse'] },
  { key: 'warehouse.staff_access_roster', title: 'Warehouse Operator Roster & Shift Access', category: 'Warehouse', portal: 'warehouse', adminTab: 'warehouse', apiPrefixes: ['/api/warehouse/admin'] },
  { key: 'warehouse.inbound_receiving', title: 'Inbound Botanical Batch Receiving Log', category: 'Warehouse', portal: 'warehouse', adminTab: 'warehouse', apiPrefixes: ['/api/warehouse'] },
  { key: 'warehouse.reverse_pickup_intake', title: 'RMA Reverse Pickup Package Inspection', category: 'Warehouse', portal: 'warehouse', adminTab: 'returns', apiPrefixes: ['/api/returns'] },
  { key: 'warehouse.packaging_materials', title: 'Sustainable Glass & Box Packaging Stock', category: 'Warehouse', portal: 'warehouse', adminTab: 'warehouse', apiPrefixes: ['/api/warehouse'] },
  { key: 'warehouse.handover_manifest', title: 'Courier Daily Handover Manifest Sign-Off', category: 'Warehouse', portal: 'warehouse', adminTab: 'warehouse', apiPrefixes: ['/api/shipping/labels'] },
  { key: 'warehouse.cold_storage_audit', title: 'Botanical Cold-Pressed Batch Storage Log', category: 'Warehouse', portal: 'warehouse', adminTab: 'warehouse', apiPrefixes: ['/api/warehouse'] },

  // ── 7. SHIPPING & CARRIER INTEGRATIONS (8 Modules) ──────────────────────────
  { key: 'shipping.zones_rates', title: 'PAN-India Shipping Zones & Rate Matrix', category: 'Shipping', portal: 'admin', adminTab: 'shipping', apiPrefixes: ['/api/shipping/zones'], pauseKey: 'shipping' },
  { key: 'shipping.free_delivery_threshold', title: 'Free Standard Shipping & Express Rules', category: 'Shipping', portal: 'admin', adminTab: 'shipping', apiPrefixes: ['/api/shipping'] },
  { key: 'shipping.carrier_credentials', title: 'Shiprocket / Delhivery / BlueDart Credentials', category: 'Shipping', portal: 'admin', adminTab: 'shipping', apiPrefixes: ['/api/shipping/carriers'] },
  { key: 'shipping.forward_labels', title: 'Automated Forward Shipping Label Booking', category: 'Shipping', portal: 'admin', adminTab: 'shipping', apiPrefixes: ['/api/shipping/labels'] },
  { key: 'shipping.return_labels', title: 'Reverse Pickup AWB Label Generation', category: 'Shipping', portal: 'admin', adminTab: 'returns', apiPrefixes: ['/api/shipping/labels'] },
  { key: 'shipping.delivery_promise_engine', title: 'Pincode Delivery Promise Estimator', category: 'Shipping', portal: 'storefront', adminTab: 'shipping', apiPrefixes: ['/api/shipping'] },
  { key: 'shipping.ndr_exception_desk', title: 'Undelivered / RTO Shipment Exception Desk', category: 'Shipping', portal: 'admin', adminTab: 'shipping', apiPrefixes: ['/api/shipping'] },
  { key: 'shipping.carrier_health_test', title: 'Live Carrier Webhook & API Connectivity Test', category: 'Shipping', portal: 'admin', adminTab: 'shipping', apiPrefixes: ['/api/shipping/carriers'] },

  // ── 8. FINANCIAL LEDGER & GST COMPLIANCE (10 Modules) ───────────────────────
  { key: 'gst.financial_ledger', title: 'Financial Ledger & GST Compliance Overview', category: 'Financial Ledger & GST Compliance', portal: 'admin', adminTab: 'gst', apiPrefixes: ['/api/gst'], pauseKey: 'gst' },
  { key: 'gst.tax_invoices_register', title: 'Issued B2B / B2C GST Tax Invoice Register', category: 'Financial Ledger & GST Compliance', portal: 'admin', adminTab: 'gst', apiPrefixes: ['/api/gst'] },
  { key: 'gst.credit_notes_register', title: 'Statutory Credit Notes & Cancellation Adjustments', category: 'Financial Ledger & GST Compliance', portal: 'admin', adminTab: 'gst', apiPrefixes: ['/api/gst'] },
  { key: 'gst.gstr1_working_schedule', title: 'GSTR-1 Outward Supplies Working Tables', category: 'Financial Ledger & GST Compliance', portal: 'admin', adminTab: 'gst', apiPrefixes: ['/api/gst'] },
  { key: 'gst.gstr3b_summary', title: 'GSTR-3B Monthly Liability & Offset Summary', category: 'Financial Ledger & GST Compliance', portal: 'admin', adminTab: 'gst', apiPrefixes: ['/api/gst'] },
  { key: 'gst.hsn_classification', title: 'HSN Code & CGST / SGST / IGST Rate Mapping', category: 'Financial Ledger & GST Compliance', portal: 'admin', adminTab: 'tax', apiPrefixes: ['/api/tax'], pauseKey: 'tax' },
  { key: 'gst.itc_expense_ledger', title: 'Input Tax Credit (ITC) & Vendor Purchase Ledger', category: 'Financial Ledger & GST Compliance', portal: 'admin', adminTab: 'gst', apiPrefixes: ['/api/gst'] },
  { key: 'gst.seller_legal_profile', title: 'Maison GSTIN, Legal Entity & Signatory Profile', category: 'Financial Ledger & GST Compliance', portal: 'admin', adminTab: 'gst', apiPrefixes: ['/api/gst'] },
  { key: 'gst.ca_master_export', title: '48-Column Statutory CA Excel & CSV Export', category: 'Financial Ledger & GST Compliance', portal: 'admin', adminTab: 'gst', apiPrefixes: ['/api/gst'] },
  { key: 'gst.revenue_analytics', title: 'Executive Revenue, AOV & Category Performance', category: 'Financial Ledger & GST Compliance', portal: 'admin', adminTab: 'analytics', apiPrefixes: ['/api/analytics'], pauseKey: 'analytics' },

  // ── 9. RETURNS, REFUNDS & WALLET TREASURY (10 Modules) ──────────────────────
  { key: 'returns.rma_queue', title: 'Returns & Replacements (RMA) Inspection Queue', category: 'Returns & Refunds', portal: 'admin', adminTab: 'returns', apiPrefixes: ['/api/returns'], pauseKey: 'returns' },
  { key: 'returns.condition_grading', title: 'Returned Item Quality Grading (Grades A–D)', category: 'Returns & Refunds', portal: 'admin', adminTab: 'returns', apiPrefixes: ['/api/returns/admin'] },
  { key: 'returns.atomic_refund_execution', title: 'Atomic Refund & Wallet Restoration Execution', category: 'Returns & Refunds', portal: 'controlcentre', adminTab: 'returns', apiPrefixes: ['/api/returns/admin', '/api/superadmin/controlcentre/refunds'] },
  { key: 'returns.gateway_refund_reconcile', title: 'Razorpay Refund Webhook & Receipt Reconciliation', category: 'Returns & Refunds', portal: 'admin', adminTab: 'returns', apiPrefixes: ['/api/returns/admin'] },
  { key: 'returns.wallet_accounts_treasury', title: 'Bhumivera Client Wallet Balance Treasury', category: 'Returns & Refunds', portal: 'admin', adminTab: 'wallet-management', apiPrefixes: ['/api/wallet'], pauseKey: 'wallet' },
  { key: 'returns.wallet_refund_audit_ledger', title: 'Immutable Wallet & Gateway Refund Audit Ledger', category: 'Returns & Refunds', portal: 'controlcentre', adminTab: 'wallet-management', apiPrefixes: ['/api/superadmin/controlcentre/refund-ledger'] },
  { key: 'returns.shopping_reward_credits', title: 'Post-Order Shopping Reward Credits Ledger', category: 'Returns & Refunds', portal: 'admin', adminTab: 'wallet-management', apiPrefixes: ['/api/wallet'] },
  { key: 'returns.policy_cooling_window', title: 'Return Eligibility & 7-Day Window Rules', category: 'Returns & Refunds', portal: 'admin', adminTab: 'returns', apiPrefixes: ['/api/returns/eligibility'] },
  { key: 'returns.purchase_protection', title: 'Bhumivera Purchase Protection Claims', category: 'Returns & Refunds', portal: 'storefront', adminTab: 'returns', apiPrefixes: ['/api/returns'] },
  { key: 'returns.earth_impact_pledges', title: 'Ecological Tree-Planting Pledge Reconciliation', category: 'Returns & Refunds', portal: 'admin', adminTab: 'impact', apiPrefixes: ['/api/impact'], pauseKey: 'impact' },

  // ── 10. CLIENTELE PRIVILEGE & TIERS (8 Modules) ─────────────────────────────
  { key: 'privilege.tier_architecture', title: 'Clientele Privilege & Tiers Configuration', category: 'Clientele Privilege & Tiers', portal: 'admin', adminTab: 'loyalty-tiers', apiPrefixes: ['/api/users/loyalty/tiers'] },
  { key: 'privilege.member_directory', title: 'Privilege Member Balances & Tier Progression', category: 'Clientele Privilege & Tiers', portal: 'admin', adminTab: 'loyalty-members', apiPrefixes: ['/api/admin/users'] },
  { key: 'privilege.redemption_cap_policy', title: 'Points Earning Multipliers & Redemption Cap', category: 'Clientele Privilege & Tiers', portal: 'admin', adminTab: 'loyalty-matrix', apiPrefixes: ['/api/settings/cart-rules/loyalty-tiers'] },
  { key: 'privilege.tier_cashback_rules', title: 'Gold & Platinum Tier Discount & Cashback Rules', category: 'Clientele Privilege & Tiers', portal: 'admin', adminTab: 'loyalty-tiers', apiPrefixes: ['/api/users/loyalty/tiers'] },
  { key: 'privilege.points_ledger_audit', title: 'Client Loyalty Points Transaction Audit', category: 'Clientele Privilege & Tiers', portal: 'admin', adminTab: 'loyalty-members', apiPrefixes: ['/api/admin/users'] },
  { key: 'privilege.post_order_ritual_wheel', title: 'Post-Purchase Privilege Reward Wheel', category: 'Clientele Privilege & Tiers', portal: 'admin', adminTab: 'gamification', apiPrefixes: ['/api/gamification'], pauseKey: 'gamification' },
  { key: 'privilege.lifecycle_gift_triggers', title: 'Milestone Order Complimentary Botanical Gifts', category: 'Clientele Privilege & Tiers', portal: 'admin', adminTab: 'lifecycle-offers', apiPrefixes: ['/api/settings'] },
  { key: 'privilege.vip_concierge_routing', title: 'Platinum Clientele Priority Concierge Routing', category: 'Clientele Privilege & Tiers', portal: 'support', adminTab: 'loyalty-members', apiPrefixes: ['/api/support'] },

  // ── 11. BESPOKE CLIENT CURATION & PROMOTIONS (8 Modules) ────────────────────
  { key: 'curation.bespoke_recommendations', title: 'Bespoke Client Curation & Scoring Weights', category: 'Bespoke Client Curation', portal: 'admin', adminTab: 'personalization', apiPrefixes: ['/api/recommendations'], pauseKey: 'recommendations' },
  { key: 'curation.privacy_consent_governance', title: 'Opt-In Curation Consent Version Governance', category: 'Bespoke Client Curation', portal: 'admin', adminTab: 'personalization', apiPrefixes: ['/api/users/profile/ad-personalization-preference'] },
  { key: 'curation.coupon_campaign_studio', title: 'Promotional Coupon & Single-Use Lock Studio', category: 'Bespoke Client Curation', portal: 'admin', adminTab: 'coupons', apiPrefixes: ['/api/coupons'], pauseKey: 'coupons' },
  { key: 'curation.coupon_redemption_ledger', title: 'Signed Coupon Redemption Audit Ledger', category: 'Bespoke Client Curation', portal: 'admin', adminTab: 'coupons', apiPrefixes: ['/api/coupons'] },
  { key: 'curation.dynamic_cart_rules', title: 'Cart Value Thresholds & Complimentary Gift Rules', category: 'Bespoke Client Curation', portal: 'admin', adminTab: 'cart-rules', apiPrefixes: ['/api/settings/cart-rules'] },
  { key: 'curation.min_order_thresholds', title: 'Minimum Order Value & Free Delivery Tiers', category: 'Bespoke Client Curation', portal: 'admin', adminTab: 'min-cart-value', apiPrefixes: ['/api/settings'] },
  { key: 'curation.ab_merchandising_tests', title: 'Storefront Merchandising A/B Evaluations', category: 'Bespoke Client Curation', portal: 'admin', adminTab: 'ab-experiments', apiPrefixes: ['/api/settings'] },
  { key: 'curation.abandoned_cart_recovery', title: 'Considered Cart Recovery Invitations', category: 'Bespoke Client Curation', portal: 'admin', adminTab: 'lifecycle-offers', apiPrefixes: ['/api/cart/abandoned-coupon'] },

  // ── 12. BRAND AMBASSADOR PROGRAM (6 Modules) ────────────────────────────────
  { key: 'ambassador.program_settings', title: 'Brand Ambassador Program Rules & Rewards', category: 'Brand Ambassador Program', portal: 'admin', adminTab: 'referral-engine', apiPrefixes: ['/api/affiliate/admin/config'], pauseKey: 'affiliate' },
  { key: 'ambassador.referral_claims_queue', title: 'Ambassador Referral Verification & Approval Queue', category: 'Brand Ambassador Program', portal: 'admin', adminTab: 'referral-engine', apiPrefixes: ['/api/affiliate/admin/referrals'] },
  { key: 'ambassador.redemption_tiers', title: 'Ambassador Credit Minimum-Order Tiers', category: 'Brand Ambassador Program', portal: 'admin', adminTab: 'referral-engine', apiPrefixes: ['/api/affiliate/admin/config'] },
  { key: 'ambassador.partner_inquiries', title: 'B2B & Botanical Cultivation Partner Inquiries', category: 'Brand Ambassador Program', portal: 'admin', adminTab: 'contacts', apiPrefixes: ['/api/contact'] },
  { key: 'ambassador.fraud_abuse_guard', title: 'Self-Referral & Duplicate Account Guard', category: 'Brand Ambassador Program', portal: 'admin', adminTab: 'referral-engine', apiPrefixes: ['/api/affiliate'] },
  { key: 'ambassador.share_link_generator', title: 'Personal Ambassador Invitation Links', category: 'Brand Ambassador Program', portal: 'storefront', adminTab: 'referral-engine', apiPrefixes: ['/api/affiliate/referral/link'] },

  // ── 13. BHUMIVERA CLIENT CONCIERGE & SUPPORT DESK (8 Modules) ───────────────
  { key: 'concierge.public_inquiry_bot', title: 'Bhumivera Client Concierge (Public Rate-Limited Bot)', category: 'Bhumivera Client Concierge', portal: 'storefront', adminTab: 'support', apiPrefixes: ['/api/support/chat'], pauseKey: 'support' },
  { key: 'concierge.verified_buyer_threads', title: 'Verified Buyer Single-Thread Order Support Chat', category: 'Bhumivera Client Concierge', portal: 'support', adminTab: 'support', apiPrefixes: ['/api/support/sessions'] },
  { key: 'concierge.escalation_tickets', title: 'Verified 12-Hour Callback & Email Escalation Queue', category: 'Bhumivera Client Concierge', portal: 'support', adminTab: 'support', apiPrefixes: ['/api/support/tickets', '/api/superadmin/controlcentre/escalations'] },
  { key: 'concierge.universal_order_lookup', title: 'Support Desk Order, AWB, Email & Phone Verification', category: 'Bhumivera Client Concierge', portal: 'support', adminTab: 'support', apiPrefixes: ['/api/support/universal-search'] },
  { key: 'concierge.courtesy_benefit_guard', title: 'One-Time Courtesy Coupon & Goodwill Cap Guard', category: 'Bhumivera Client Concierge', portal: 'superadminsupport', adminTab: 'support', apiPrefixes: ['/api/support/sessions'] },
  { key: 'concierge.canned_response_macros', title: 'Luxury Concierge Response Macros & SLA Timers', category: 'Bhumivera Client Concierge', portal: 'superadminsupport', adminTab: 'support', apiPrefixes: ['/api/support/superadmin/features'] },
  { key: 'concierge.csat_quality_board', title: 'Client Satisfaction (CSAT) Reviews & Transcript Purge', category: 'Bhumivera Client Concierge', portal: 'superadminsupport', adminTab: 'support', apiPrefixes: ['/api/support/superadmin/overview'] },

  // ── 14. CLIENT DIRECTORY, RBAC & CONTROL CENTRE SECURITY (6 Modules) ────────
  { key: 'governance.client_directory', title: 'Client Directory & Account Status Governance', category: 'Client Directory & Security', portal: 'admin', adminTab: 'users', apiPrefixes: ['/api/admin/users'] },
  { key: 'governance.staff_rbac_matrix', title: 'Staff Accounts & 108-Module Permission Matrix', category: 'Client Directory & Security', portal: 'controlcentre', adminTab: 'support-agents', apiPrefixes: ['/api/superadmin/controlcentre/staff'] },
  { key: 'governance.security_vault_config', title: 'SuperAdmin Dual-Password, 3-Q&A & Passcode Vault', category: 'Client Directory & Security', portal: 'controlcentre', adminTab: 'settings', apiPrefixes: ['/api/superadmin/controlcentre/vault'] },
  { key: 'governance.module_pause_switchboard', title: 'Live Platform Module Pause & Maintenance Switchboard', category: 'Client Directory & Security', portal: 'controlcentre', adminTab: 'system-health', apiPrefixes: ['/api/admin/system/modules'] },
  { key: 'governance.realtime_api_telemetry', title: 'Real-Time API Latency, HTTP Status & F12 Crash Monitor', category: 'Client Directory & Security', portal: 'controlcentre', adminTab: 'system-health', apiPrefixes: ['/api/superadmin/controlcentre/telemetry', '/api/admin/system/health'] },
  { key: 'governance.infrastructure_logs', title: 'Vercel Edge, Railway Uptime & MySQL Pool Diagnostics', category: 'Client Directory & Security', portal: 'controlcentre', adminTab: 'logs', apiPrefixes: ['/api/admin/system/logs', '/api/logs/client'] },
]);

const DEFAULT_STAFF_ROSTER_SEED = Object.freeze([
  { username: 'maison_exec_01', email: 'exec.director@bhumivera.com', fullName: 'Aarav Sen (Executive Director)', primaryPortal: 'admin', roleTitle: 'Executive Director', department: 'Maison Leadership', defaultAccess: 'write' },
  { username: 'finance_gst_01', email: 'finance.ledger@bhumivera.com', fullName: 'Meera Iyer (GST & Finance Lead)', primaryPortal: 'admin', roleTitle: 'Financial Controller', department: 'Financial Ledger & GST', defaultAccess: 'read', categoryOverrides: { 'Financial Ledger & GST Compliance': 'full', 'Orders': 'read', 'Returns & Refunds': 'write' } },
  { username: 'catalog_curator_01', email: 'curator@bhumivera.com', fullName: 'Devika Nair (Botanical Curator)', primaryPortal: 'admin', roleTitle: 'Catalog & Curation Lead', department: 'Botanical Merchandising', defaultAccess: 'read', categoryOverrides: { 'Products': 'full', 'Categories': 'full', 'Bespoke Client Curation': 'write', 'Main Storefront': 'write' } },
  { username: 'privilege_lead_01', email: 'privilege@bhumivera.com', fullName: 'Rohan Malhotra (Clientele Privilege)', primaryPortal: 'admin', roleTitle: 'Clientele & Ambassador Lead', department: 'Clientele Privilege', defaultAccess: 'read', categoryOverrides: { 'Clientele Privilege & Tiers': 'full', 'Brand Ambassador Program': 'full' } },
  { username: 'warehouse_head_01', email: 'warehouse.lead@bhumivera.com', fullName: 'Vikram Rathore (Dispatch Master)', primaryPortal: 'warehouse', roleTitle: 'Warehouse Operations Head', department: 'Fulfilment & Logistics', defaultAccess: 'hidden', categoryOverrides: { 'Warehouse': 'full', 'Inventory': 'write', 'Shipping': 'write', 'Orders': 'read' } },
  { username: 'warehouse_pack_02', email: 'dispatch.desk1@bhumivera.com', fullName: 'Karan Verma (Fulfilment Specialist)', primaryPortal: 'warehouse', roleTitle: 'Dispatch Executive', department: 'Fulfilment & Logistics', defaultAccess: 'hidden', categoryOverrides: { 'Warehouse': 'write', 'Inventory': 'read', 'Shipping': 'read' } },
  { username: 'warehouse_qc_03', email: 'qc.intake@bhumivera.com', fullName: 'Nisha Gupta (Reverse Logistics QC)', primaryPortal: 'warehouse', roleTitle: 'Quality & RMA Inspector', department: 'Fulfilment & Logistics', defaultAccess: 'hidden', categoryOverrides: { 'Warehouse': 'read', 'Returns & Refunds': 'write', 'Inventory': 'read' } },
  { username: 'concierge_mgr_01', email: 'concierge.manager@bhumivera.com', fullName: 'Ananya Chatterjee (Concierge Manager)', primaryPortal: 'superadminsupport', roleTitle: 'Client Concierge Manager (L3)', department: 'Bhumivera Client Concierge', defaultAccess: 'read', categoryOverrides: { 'Bhumivera Client Concierge': 'write', 'Returns & Refunds': 'write', 'Orders': 'read' } },
  { username: 'concierge_sup_02', email: 'concierge.supervisor@bhumivera.com', fullName: 'Siddharth Roy (Concierge Supervisor)', primaryPortal: 'support', roleTitle: 'Concierge Supervisor (L2)', department: 'Bhumivera Client Concierge', defaultAccess: 'hidden', categoryOverrides: { 'Bhumivera Client Concierge': 'write', 'Orders': 'read', 'Returns & Refunds': 'read' } },
  { username: 'concierge_exec_03', email: 'concierge.care1@bhumivera.com', fullName: 'Priya Sharma (Client Concierge L1)', primaryPortal: 'support', roleTitle: 'Client Concierge Executive (L1)', department: 'Bhumivera Client Concierge', defaultAccess: 'hidden', categoryOverrides: { 'Bhumivera Client Concierge': 'read', 'Orders': 'read' } },
  { username: 'concierge_exec_04', email: 'concierge.care2@bhumivera.com', fullName: 'Kabir Bose (Client Concierge L1)', primaryPortal: 'support', roleTitle: 'Client Concierge Executive (L1)', department: 'Bhumivera Client Concierge', defaultAccess: 'hidden', categoryOverrides: { 'Bhumivera Client Concierge': 'read', 'Orders': 'read' } },
]);

let fortressInitializedPromise = null;

async function initSuperAdminFortressTables(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS superadmin_security_vault (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      authorized_email VARCHAR(150) NOT NULL UNIQUE DEFAULT 'adminbhumivera27@gmail.com',
      is_onboarded TINYINT(1) NOT NULL DEFAULT 0,
      primary_password_hash VARCHAR(512) NULL,
      secondary_vault_password_hash VARCHAR(512) NULL,
      action_passcode_hash VARCHAR(512) NULL,
      security_questions_encrypted TEXT NULL,
      last_rotated_question_index TINYINT UNSIGNED NOT NULL DEFAULT 0,
      failed_login_attempts INT UNSIGNED NOT NULL DEFAULT 0,
      locked_until DATETIME NULL,
      last_login_at DATETIME NULL,
      last_login_ip VARCHAR(64) NULL,
      vault_signature_sha512 CHAR(128) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_sa_vault_email (authorized_email, is_onboarded)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(
    `INSERT IGNORE INTO superadmin_security_vault (authorized_email, is_onboarded)
     VALUES (?, 0)`,
    [SUPERADMIN_EMAIL]
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS superadmin_otp_challenges (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      challenge_id VARCHAR(64) NOT NULL UNIQUE,
      authorized_email VARCHAR(150) NOT NULL,
      purpose ENUM('onboarding', 'multi_factor_login', 'step_up_action') NOT NULL DEFAULT 'multi_factor_login',
      otp_hash VARCHAR(256) NOT NULL,
      selected_question_index TINYINT UNSIGNED NOT NULL DEFAULT 0,
      attempts INT UNSIGNED NOT NULL DEFAULT 0,
      max_attempts INT UNSIGNED NOT NULL DEFAULT 3,
      expires_at DATETIME NOT NULL,
      consumed_at DATETIME NULL,
      ip_address VARCHAR(64) NULL,
      user_agent VARCHAR(255) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_sa_otp_email_expires (authorized_email, purpose, expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS staff_accounts (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(80) NOT NULL UNIQUE,
      email VARCHAR(150) NOT NULL UNIQUE,
      full_name VARCHAR(120) NOT NULL,
      password_hash VARCHAR(512) NOT NULL,
      primary_portal ENUM('admin', 'warehouse', 'support', 'superadminsupport', 'controlcentre') NOT NULL DEFAULT 'admin',
      role_title VARCHAR(80) NOT NULL DEFAULT 'Executive Administrator',
      department VARCHAR(80) NOT NULL DEFAULT 'Maison Operations',
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      failed_attempts INT UNSIGNED NOT NULL DEFAULT 0,
      locked_until DATETIME NULL,
      last_login_at DATETIME NULL,
      created_by_email VARCHAR(150) NOT NULL DEFAULT 'adminbhumivera27@gmail.com',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_staff_portal_active (primary_portal, is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS staff_module_permissions (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      staff_id INT UNSIGNED NOT NULL,
      module_key VARCHAR(100) NOT NULL,
      access_level ENUM('hidden', 'read', 'write', 'full') NOT NULL DEFAULT 'read',
      updated_by VARCHAR(150) NOT NULL DEFAULT 'adminbhumivera27@gmail.com',
      signature_sha512 CHAR(128) NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_staff_module (staff_id, module_key),
      INDEX idx_staff_module_lookup (module_key, access_level),
      CONSTRAINT fk_staff_perm_account FOREIGN KEY (staff_id) REFERENCES staff_accounts (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS wallet_refund_ledger (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      ledger_reference VARCHAR(64) NOT NULL UNIQUE,
      order_id INT NOT NULL,
      order_number VARCHAR(32) NOT NULL,
      return_id INT NULL,
      user_id INT NOT NULL,
      source_payment_mode ENUM('WALLET', 'online', 'COD') NOT NULL,
      refund_destination ENUM('WALLET_INSTANT', 'ORIGINAL_GATEWAY', 'INTERNAL_REFUND_LEDGER') NOT NULL,
      wallet_credited_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
      referral_credited_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
      gateway_refund_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
      wallet_balance_before DECIMAL(10,2) NOT NULL DEFAULT 0.00,
      wallet_balance_after DECIMAL(10,2) NOT NULL DEFAULT 0.00,
      gateway_payment_id VARCHAR(120) NULL,
      gateway_refund_id VARCHAR(120) NULL,
      gateway_status ENUM('NOT_APPLICABLE', 'INITIATED', 'PENDING_WEBHOOK', 'PROCESSED', 'CREDITED_TO_WALLET_FALLBACK') NOT NULL DEFAULT 'NOT_APPLICABLE',
      reason TEXT NOT NULL,
      executed_by_email VARCHAR(150) NOT NULL DEFAULT 'adminbhumivera27@gmail.com',
      signature_sha512 CHAR(128) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_wallet_refund_order (order_id, created_at),
      INDEX idx_wallet_refund_user (user_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS support_escalation_tickets (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      ticket_reference VARCHAR(32) NOT NULL UNIQUE,
      session_id BIGINT UNSIGNED NULL,
      user_id INT NOT NULL,
      order_id INT NOT NULL,
      order_number VARCHAR(32) NOT NULL,
      verified_email VARCHAR(150) NULL,
      verified_phone VARCHAR(20) NULL,
      contact_preference ENUM('email', 'phone_call') NOT NULL,
      callback_phone VARCHAR(20) NULL,
      callback_time_slot VARCHAR(80) NULL,
      inquiry_category VARCHAR(80) NOT NULL DEFAULT 'Order Intervention',
      query_details TEXT NOT NULL,
      status ENUM('open', 'assigned', 'in_progress', 'resolved', 'closed') NOT NULL DEFAULT 'open',
      sla_deadline DATETIME NOT NULL,
      assigned_staff_id INT UNSIGNED NULL,
      resolution_notes TEXT NULL,
      signature_sha512 CHAR(128) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_esc_ticket_order (order_id, status),
      INDEX idx_esc_ticket_user (user_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS api_telemetry_logs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      route_pattern VARCHAR(160) NOT NULL,
      http_method VARCHAR(12) NOT NULL,
      status_code SMALLINT UNSIGNED NOT NULL,
      latency_ms INT UNSIGNED NOT NULL,
      request_id VARCHAR(64) NULL,
      error_code VARCHAR(100) NULL,
      actor_role VARCHAR(40) NULL,
      recorded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_api_telemetry_route_time (route_pattern, recorded_at),
      INDEX idx_api_telemetry_status_time (status_code, recorded_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS superadmin_vault_audit_logs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      actor_email VARCHAR(150) NOT NULL,
      action_code VARCHAR(80) NOT NULL,
      target_entity VARCHAR(120) NULL,
      payload_summary TEXT NULL,
      ip_address VARCHAR(64) NULL,
      user_agent VARCHAR(255) NULL,
      prev_hash_sha512 CHAR(128) NOT NULL,
      signature_sha512 CHAR(128) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_sa_audit_created (created_at, action_code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // Ensure orders.payment_status supports 'refund_initiated' and 'refunded'
  try {
    await pool.query(
      "ALTER TABLE orders MODIFY COLUMN payment_status ENUM('pending', 'paid', 'failed', 'refund_initiated', 'refunded') DEFAULT 'pending'"
    );
  } catch {
    // Ignore on unit-test mock pools
  }

  // Ensure ai_support_sessions has verification state columns for 3-step concierge flow
  try {
    const [cols] = await pool.query("SHOW COLUMNS FROM ai_support_sessions LIKE 'verification_state'");
    if (!cols || cols.length === 0) {
      await pool.query(
        "ALTER TABLE ai_support_sessions ADD COLUMN verification_state VARCHAR(40) NOT NULL DEFAULT 'UNVERIFIED', ADD COLUMN verified_order_id INT NULL, ADD COLUMN contact_preference VARCHAR(20) NULL, ADD COLUMN callback_phone VARCHAR(20) NULL, ADD COLUMN callback_slot VARCHAR(80) NULL"
      );
    }
  } catch {
    // Ignore on mock pools
  }

  // Seed default 11 staff accounts across Admin, Warehouse, and Support if staff_accounts is empty
  try {
    const [[countRow]] = await pool.query('SELECT COUNT(*) AS cnt FROM staff_accounts');
    if (Number(countRow?.cnt || 0) === 0) {
      for (const seed of DEFAULT_STAFF_ROSTER_SEED) {
        const randomInitialPass = crypto.randomBytes(18).toString('base64url') + '!9A';
        const passHash = hashSecretFortress(randomInitialPass, 'staff-password');
        const [ins] = await pool.query(
          `INSERT IGNORE INTO staff_accounts
            (username, email, full_name, password_hash, primary_portal, role_title, department, is_active, created_by_email)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
          [
            seed.username,
            seed.email,
            seed.fullName,
            passHash,
            seed.primaryPortal,
            seed.roleTitle,
            seed.department,
            SUPERADMIN_EMAIL,
          ]
        );
        const staffId = ins?.insertId;
        if (staffId) {
          for (const mod of PLATFORM_MODULES_CATALOG) {
            let level = seed.defaultAccess || 'read';
            if (seed.categoryOverrides && seed.categoryOverrides[mod.category]) {
              level = seed.categoryOverrides[mod.category];
            }
            // Never grant order cancellation to non-SuperAdmin staff
            if (mod.key === 'orders.superadmin_cancellation') {
              level = 'hidden';
            }
            const sig = computeQuantumHash512(
              { staffId, moduleKey: mod.key, accessLevel: level },
              'STAFF_RBAC_MATRIX_512'
            );
            await pool.query(
              `INSERT IGNORE INTO staff_module_permissions
                (staff_id, module_key, access_level, updated_by, signature_sha512)
               VALUES (?, ?, ?, ?, ?)`,
              [staffId, mod.key, level, SUPERADMIN_EMAIL, sig]
            );
          }
        }
      }
    }
  } catch {
    // Ignore on unit-test mock pools
  }
}

async function ensureSuperAdminFortressTables(pool) {
  if (!fortressInitializedPromise) {
    fortressInitializedPromise = initSuperAdminFortressTables(pool).catch(err => {
      fortressInitializedPromise = null;
      throw err;
    });
  }
  return fortressInitializedPromise;
}

async function appendVaultAuditLog(pool, {
  actorEmail = SUPERADMIN_EMAIL,
  actionCode,
  targetEntity = null,
  payloadSummary = null,
  ipAddress = null,
  userAgent = null,
}) {
  try {
    await ensureSuperAdminFortressTables(pool);
    const [lastRows] = await pool.query(
      'SELECT signature_sha512 FROM superadmin_vault_audit_logs ORDER BY id DESC LIMIT 1'
    );
    const prevHash = lastRows?.[0]?.signature_sha512 || 'GENESIS_SUPERADMIN_VAULT_512';
    const summaryText = typeof payloadSummary === 'string'
      ? payloadSummary.slice(0, 4000)
      : JSON.stringify(payloadSummary || {}).slice(0, 4000);
    const signature = computeQuantumHash512(
      {
        actorEmail,
        actionCode,
        targetEntity,
        summaryText,
        ipAddress,
      },
      prevHash
    );
    await pool.query(
      `INSERT INTO superadmin_vault_audit_logs
        (actor_email, action_code, target_entity, payload_summary, ip_address, user_agent, prev_hash_sha512, signature_sha512)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        actorEmail,
        actionCode,
        targetEntity,
        summaryText,
        ipAddress ? String(ipAddress).slice(0, 64) : null,
        userAgent ? String(userAgent).slice(0, 255) : null,
        prevHash,
        signature,
      ]
    );
    return signature;
  } catch {
    return null;
  }
}

async function getVaultStatus(pool) {
  await ensureSuperAdminFortressTables(pool);
  const [rows] = await pool.query(
    'SELECT * FROM superadmin_security_vault WHERE LOWER(authorized_email) = ? LIMIT 1',
    [SUPERADMIN_EMAIL]
  );
  const vault = rows?.[0];
  const lockedUntil = vault?.locked_until ? new Date(vault.locked_until) : null;
  const isLocked = Boolean(lockedUntil && lockedUntil.getTime() > Date.now());
  const secondsRemaining = isLocked
    ? Math.max(0, Math.ceil((lockedUntil.getTime() - Date.now()) / 1000))
    : 0;

  return {
    authorizedEmail: SUPERADMIN_EMAIL,
    isOnboarded: Boolean(vault && Number(vault.is_onboarded) === 1 && vault.primary_password_hash),
    locked: isLocked,
    secondsRemaining,
    failedAttempts: Number(vault?.failed_login_attempts || 0),
    lastLoginAt: vault?.last_login_at || null,
    totalModulesCount: PLATFORM_MODULES_CATALOG.length,
  };
}

/**
 * Generates a 5-minute, max-3-attempt OTP challenge for `adminbhumivera27@gmail.com`.
 * If already onboarded, selects the rotating security question prompt for this login session.
 */
async function createSuperAdminOtpChallenge(pool, {
  email,
  purpose = 'multi_factor_login',
  ipAddress = null,
  userAgent = null,
}) {
  await ensureSuperAdminFortressTables(pool);
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (normalizedEmail !== SUPERADMIN_EMAIL) {
    await appendVaultAuditLog(pool, {
      actorEmail: normalizedEmail || 'unknown',
      actionCode: 'UNAUTHORIZED_SUPERADMIN_EMAIL_ATTEMPT',
      targetEntity: '/superadmin/controlcentre',
      payloadSummary: { attemptedEmail: normalizedEmail },
      ipAddress,
      userAgent,
    });
    const err = new Error('Access restricted exclusively to the authorized SuperAdmin principal.');
    err.statusCode = 403;
    err.code = 'UNAUTHORIZED_SUPERADMIN_PRINCIPAL';
    throw err;
  }

  const [vaultRows] = await pool.query(
    'SELECT * FROM superadmin_security_vault WHERE LOWER(authorized_email) = ? LIMIT 1',
    [SUPERADMIN_EMAIL]
  );
  const vault = vaultRows?.[0];
  if (vault?.locked_until && new Date(vault.locked_until).getTime() > Date.now()) {
    const secondsRemaining = Math.max(0, Math.ceil((new Date(vault.locked_until).getTime() - Date.now()) / 1000));
    const err = new Error('SuperAdmin Security Vault is temporarily locked due to repeated failed verification attempts.');
    err.statusCode = 423;
    err.code = 'VAULT_LOCKED';
    err.secondsRemaining = secondsRemaining;
    throw err;
  }

  const isOnboarded = Boolean(vault && Number(vault.is_onboarded) === 1 && vault.primary_password_hash);
  const effectivePurpose = isOnboarded ? purpose : 'onboarding';

  let selectedQuestionIndex = 0;
  let selectedQuestionPrompt = null;

  if (isOnboarded && vault.security_questions_encrypted) {
    const decryptedQuestions = decryptVaultJson(vault.security_questions_encrypted, []);
    if (Array.isArray(decryptedQuestions) && decryptedQuestions.length === 3) {
      // Rotate question index deterministically + random jitter if desired, advancing from last_rotated_question_index
      selectedQuestionIndex = Number(vault.last_rotated_question_index || 0) % 3;
      selectedQuestionPrompt = decryptedQuestions[selectedQuestionIndex]?.question || 'Verify configured security question';
      await pool.query(
        'UPDATE superadmin_security_vault SET last_rotated_question_index = ? WHERE id = ?',
        [(selectedQuestionIndex + 1) % 3, vault.id]
      );
    }
  }

  const challengeId = `sac_${crypto.randomBytes(24).toString('hex')}`;
  const rawOtp = crypto.randomInt(100000, 1000000).toString();
  const otpHash = hashOtp(`superadmin-${effectivePurpose}`, challengeId, rawOtp);

  await pool.query(
    `INSERT INTO superadmin_otp_challenges
      (challenge_id, authorized_email, purpose, otp_hash, selected_question_index, attempts, max_attempts, expires_at, ip_address, user_agent)
     VALUES (?, ?, ?, ?, ?, 0, 3, DATE_ADD(NOW(), INTERVAL 5 MINUTE), ?, ?)`,
    [
      challengeId,
      SUPERADMIN_EMAIL,
      effectivePurpose,
      otpHash,
      selectedQuestionIndex,
      ipAddress ? String(ipAddress).slice(0, 64) : null,
      userAgent ? String(userAgent).slice(0, 255) : null,
    ]
  );

  await appendVaultAuditLog(pool, {
    actorEmail: SUPERADMIN_EMAIL,
    actionCode: 'OTP_CHALLENGE_ISSUED',
    targetEntity: challengeId,
    payloadSummary: { purpose: effectivePurpose, isOnboarded, selectedQuestionIndex },
    ipAddress,
    userAgent,
  });

  return {
    challengeId,
    rawOtp, // Used ONLY by server mail sender, NEVER sent in HTTP response
    isOnboarded,
    purpose: effectivePurpose,
    expiresInSeconds: 300,
    maxAttempts: 3,
    securityQuestion: isOnboarded
      ? {
          index: selectedQuestionIndex,
          questionNumber: selectedQuestionIndex + 1,
          prompt: selectedQuestionPrompt,
        }
      : null,
  };
}

/**
 * Validates and consumes an OTP challenge (5-min expiry, max 3 attempts).
 */
async function validateOtpChallengeInternal(conn, { challengeId, email, otp, expectedPurpose = null }) {
  const [rows] = await conn.query(
    `SELECT * FROM superadmin_otp_challenges
     WHERE challenge_id = ? AND LOWER(authorized_email) = ?
     FOR UPDATE`,
    [String(challengeId || '').trim(), SUPERADMIN_EMAIL]
  );
  const challenge = rows?.[0];
  if (!challenge) {
    const err = new Error('Verification challenge not found or expired. Request a new email OTP.');
    err.statusCode = 401;
    err.code = 'OTP_CHALLENGE_INVALID';
    throw err;
  }
  if (challenge.consumed_at) {
    const err = new Error('This OTP challenge has already been used. Request a fresh code.');
    err.statusCode = 401;
    err.code = 'OTP_CHALLENGE_CONSUMED';
    throw err;
  }
  if (new Date(challenge.expires_at).getTime() <= Date.now()) {
    const err = new Error('Email OTP has expired (5-minute window). Please request a new code.');
    err.statusCode = 401;
    err.code = 'OTP_EXPIRED';
    throw err;
  }
  if (Number(challenge.attempts) >= Number(challenge.max_attempts || 3)) {
    const err = new Error('Maximum OTP verification attempts (3) exceeded. Please request a new code.');
    err.statusCode = 429;
    err.code = 'OTP_MAX_ATTEMPTS_EXCEEDED';
    throw err;
  }
  if (expectedPurpose && challenge.purpose !== expectedPurpose) {
    const err = new Error('OTP challenge purpose mismatch.');
    err.statusCode = 401;
    err.code = 'OTP_PURPOSE_MISMATCH';
    throw err;
  }

  const cleanOtp = String(otp || '').trim();
  const isValidOtp = compareOtp(`superadmin-${challenge.purpose}`, challenge.challenge_id, cleanOtp, challenge.otp_hash);
  if (!isValidOtp) {
    await conn.query(
      'UPDATE superadmin_otp_challenges SET attempts = attempts + 1 WHERE id = ?',
      [challenge.id]
    );
    const remaining = Math.max(0, Number(challenge.max_attempts || 3) - (Number(challenge.attempts) + 1));
    const err = new Error(`Invalid 6-digit Email OTP. ${remaining} attempt(s) remaining.`);
    err.statusCode = 401;
    err.code = 'OTP_INVALID';
    throw err;
  }

  return challenge;
}

/**
 * First-Time Onboarding Flow for `adminbhumivera27@gmail.com`:
 * Verifies the Email OTP and initializes the Security Vault:
 *  - Primary Master Password (Password 1)
 *  - Secondary Vault Password (Password 2)
 *  - 3 Custom Security Questions & Answers
 *  - 6-Digit Master Action Passcode
 */
async function completeFirstTimeVaultOnboarding(pool, {
  challengeId,
  email,
  otp,
  primaryPassword,
  secondaryVaultPassword,
  securityQuestions,
  actionPasscode,
  ipAddress = null,
  userAgent = null,
}) {
  await ensureSuperAdminFortressTables(pool);
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (normalizedEmail !== SUPERADMIN_EMAIL) {
    const err = new Error('Unauthorized SuperAdmin email.');
    err.statusCode = 403;
    throw err;
  }

  const p1 = String(primaryPassword || '');
  const p2 = String(secondaryVaultPassword || '');
  const passcode = String(actionPasscode || '').trim();

  if (p1.length < 10 || p1.length > 128) {
    const err = new Error('Primary Master Password must be between 10 and 128 characters.');
    err.statusCode = 400;
    throw err;
  }
  if (p2.length < 10 || p2.length > 128) {
    const err = new Error('Secondary Vault Password must be between 10 and 128 characters.');
    err.statusCode = 400;
    throw err;
  }
  if (p1 === p2) {
    const err = new Error('Primary Master Password and Secondary Vault Password must be distinct.');
    err.statusCode = 400;
    throw err;
  }
  if (!/^\d{6}$/.test(passcode)) {
    const err = new Error('Master Action Passcode must be exactly 6 numeric digits.');
    err.statusCode = 400;
    throw err;
  }
  if (!Array.isArray(securityQuestions) || securityQuestions.length !== 3) {
    const err = new Error('Exactly 3 custom security questions and answers are required.');
    err.statusCode = 400;
    throw err;
  }

  const preparedQuestions = securityQuestions.map((item, idx) => {
    const q = String(item?.question || '').trim();
    const a = normalizeSecurityAnswer(item?.answer || '');
    if (q.length < 8 || q.length > 200) {
      const err = new Error(`Security Question #${idx + 1} must be between 8 and 200 characters.`);
      err.statusCode = 400;
      throw err;
    }
    if (a.length < 3 || a.length > 120) {
      const err = new Error(`Answer for Security Question #${idx + 1} must be at least 3 characters.`);
      err.statusCode = 400;
      throw err;
    }
    return {
      index: idx,
      question: q,
      answerHash: hashSecretFortress(a, `vault-sec-q-${idx}`),
    };
  });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [vaultRows] = await conn.query(
      'SELECT * FROM superadmin_security_vault WHERE LOWER(authorized_email) = ? FOR UPDATE',
      [SUPERADMIN_EMAIL]
    );
    const vault = vaultRows?.[0];
    if (vault && Number(vault.is_onboarded) === 1 && vault.primary_password_hash) {
      const err = new Error('Security Vault is already onboarded. Use the standard multi-factor login flow.');
      err.statusCode = 409;
      err.code = 'VAULT_ALREADY_ONBOARDED';
      throw err;
    }

    const challenge = await validateOtpChallengeInternal(conn, {
      challengeId,
      email: SUPERADMIN_EMAIL,
      otp,
      expectedPurpose: 'onboarding',
    });

    await conn.query(
      'UPDATE superadmin_otp_challenges SET consumed_at = NOW() WHERE id = ?',
      [challenge.id]
    );

    const primaryHash = hashSecretFortress(p1, 'vault-primary-password');
    const secondaryHash = hashSecretFortress(p2, 'vault-secondary-password');
    const passcodeHash = hashSecretFortress(passcode, 'vault-action-passcode');
    const encryptedQuestions = encryptVaultJson(preparedQuestions);

    const vaultSignature = computeQuantumHash512(
      {
        email: SUPERADMIN_EMAIL,
        primaryHash,
        secondaryHash,
        passcodeHash,
        questionsCount: 3,
      },
      'SUPERADMIN_VAULT_ROOT_512'
    );

    await conn.query(
      `UPDATE superadmin_security_vault
       SET is_onboarded = 1,
           primary_password_hash = ?,
           secondary_vault_password_hash = ?,
           action_passcode_hash = ?,
           security_questions_encrypted = ?,
           last_rotated_question_index = 0,
           failed_login_attempts = 0,
           locked_until = NULL,
           last_login_at = NOW(),
           last_login_ip = ?,
           vault_signature_sha512 = ?
       WHERE LOWER(authorized_email) = ?`,
      [
        primaryHash,
        secondaryHash,
        passcodeHash,
        encryptedQuestions,
        ipAddress ? String(ipAddress).slice(0, 64) : null,
        vaultSignature,
        SUPERADMIN_EMAIL,
      ]
    );

    await conn.commit();

    await appendVaultAuditLog(pool, {
      actorEmail: SUPERADMIN_EMAIL,
      actionCode: 'SECURITY_VAULT_ONBOARDING_COMPLETED',
      targetEntity: SUPERADMIN_EMAIL,
      payloadSummary: {
        encryption: 'AES-256-GCM + SHA-512 HMAC',
        kdf: 'Scrypt + PBKDF2-HMAC-SHA512 (210k iterations)',
      },
      ipAddress,
      userAgent,
    });

    return {
      success: true,
      email: SUPERADMIN_EMAIL,
      role: 'superadmin',
      isOnboarded: true,
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Standard Multi-Factor SuperAdmin Login Verification:
 * Simultaneously verifies:
 *  1. Authorized Email (`adminbhumivera27@gmail.com`)
 *  2. Time-bound 6-Digit Email OTP (5-min expiry, max 3 attempts)
 *  3. Primary Master Password (Password 1)
 *  4. Secondary Vault Password (Password 2)
 *  5. 1 Randomly Selected Rotating Security Question & Answer
 *  6. 6-Digit Master Action Passcode
 */
async function verifySuperAdminMultiFactorLogin(pool, {
  challengeId,
  email,
  otp,
  primaryPassword,
  secondaryVaultPassword,
  securityAnswer,
  actionPasscode,
  ipAddress = null,
  userAgent = null,
}) {
  await ensureSuperAdminFortressTables(pool);
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (normalizedEmail !== SUPERADMIN_EMAIL) {
    const err = new Error('Unauthorized SuperAdmin email.');
    err.statusCode = 403;
    throw err;
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [vaultRows] = await conn.query(
      'SELECT * FROM superadmin_security_vault WHERE LOWER(authorized_email) = ? FOR UPDATE',
      [SUPERADMIN_EMAIL]
    );
    const vault = vaultRows?.[0];
    if (!vault || Number(vault.is_onboarded) !== 1) {
      const err = new Error('Security Vault has not completed first-time onboarding yet.');
      err.statusCode = 409;
      err.code = 'ONBOARDING_REQUIRED';
      throw err;
    }

    if (vault.locked_until && new Date(vault.locked_until).getTime() > Date.now()) {
      const secondsRemaining = Math.max(0, Math.ceil((new Date(vault.locked_until).getTime() - Date.now()) / 1000));
      const err = new Error('SuperAdmin Security Vault is temporarily locked.');
      err.statusCode = 423;
      err.code = 'VAULT_LOCKED';
      err.secondsRemaining = secondsRemaining;
      throw err;
    }

    // 1. Validate OTP challenge (5-min expiry, max 3 attempts)
    let challenge;
    try {
      challenge = await validateOtpChallengeInternal(conn, {
        challengeId,
        email: SUPERADMIN_EMAIL,
        otp,
        expectedPurpose: 'multi_factor_login',
      });
    } catch (otpErr) {
      await conn.commit(); // Persist incremented OTP attempt count
      throw otpErr;
    }

    // 2. Verify Primary Master Password, Secondary Vault Password, Rotating Security Question, and 6-Digit Action Passcode
    const validPrimary = verifySecretFortress(String(primaryPassword || ''), vault.primary_password_hash, 'vault-primary-password');
    const validSecondary = verifySecretFortress(String(secondaryVaultPassword || ''), vault.secondary_vault_password_hash, 'vault-secondary-password');
    const validPasscode = verifySecretFortress(String(actionPasscode || '').trim(), vault.action_passcode_hash, 'vault-action-passcode');

    const questions = decryptVaultJson(vault.security_questions_encrypted, []);
    const qIndex = Number(challenge.selected_question_index || 0);
    const targetQuestion = Array.isArray(questions) ? questions[qIndex] : null;
    const normalizedCandidateAnswer = normalizeSecurityAnswer(securityAnswer || '');
    const validSecurityAnswer = targetQuestion
      ? verifySecretFortress(normalizedCandidateAnswer, targetQuestion.answerHash, `vault-sec-q-${qIndex}`)
      : false;

    if (!validPrimary || !validSecondary || !validPasscode || !validSecurityAnswer) {
      const nextAttempts = Number(vault.failed_login_attempts || 0) + 1;
      const shouldLock = nextAttempts >= 5;
      await conn.query(
        `UPDATE superadmin_security_vault
         SET failed_login_attempts = ?,
             locked_until = CASE WHEN ? THEN DATE_ADD(NOW(), INTERVAL 15 MINUTE) ELSE locked_until END
         WHERE id = ?`,
        [nextAttempts, shouldLock ? 1 : 0, vault.id]
      );
      await conn.commit();

      await appendVaultAuditLog(pool, {
        actorEmail: SUPERADMIN_EMAIL,
        actionCode: 'MULTI_FACTOR_LOGIN_FAILED',
        targetEntity: challengeId,
        payloadSummary: {
          validPrimary,
          validSecondary,
          validPasscode,
          validSecurityAnswer,
          failedAttempts: nextAttempts,
          locked: shouldLock,
        },
        ipAddress,
        userAgent,
      });

      const err = new Error(
        shouldLock
          ? 'Multiple factor verification failed. Security Vault has been locked for 15 minutes.'
          : 'Multi-factor vault verification failed. Check both passwords, your security answer, and your 6-digit Master Action Passcode.'
      );
      err.statusCode = shouldLock ? 423 : 401;
      err.code = shouldLock ? 'VAULT_LOCKED' : 'MULTI_FACTOR_VERIFICATION_FAILED';
      throw err;
    }

    await conn.query('UPDATE superadmin_otp_challenges SET consumed_at = NOW() WHERE id = ?', [challenge.id]);
    await conn.query(
      `UPDATE superadmin_security_vault
       SET failed_login_attempts = 0,
           locked_until = NULL,
           last_login_at = NOW(),
           last_login_ip = ?
       WHERE id = ?`,
      [ipAddress ? String(ipAddress).slice(0, 64) : null, vault.id]
    );
    await conn.commit();

    await appendVaultAuditLog(pool, {
      actorEmail: SUPERADMIN_EMAIL,
      actionCode: 'MULTI_FACTOR_LOGIN_SUCCEEDED',
      targetEntity: '/superadmin/controlcentre',
      payloadSummary: { questionIndexVerified: qIndex },
      ipAddress,
      userAgent,
    });

    return {
      success: true,
      email: SUPERADMIN_EMAIL,
      role: 'superadmin',
    };
  } catch (err) {
    try { await conn.rollback(); } catch {}
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Verifies the 6-Digit Master Action Passcode for step-up authorization on sensitive/destructive actions.
 */
async function verifyStepUpActionPasscode(pool, candidatePasscode, {
  actionCode = 'SENSITIVE_ACTION',
  targetEntity = null,
  ipAddress = null,
  userAgent = null,
} = {}) {
  await ensureSuperAdminFortressTables(pool);
  const cleanCode = String(candidatePasscode || '').trim();
  if (!/^\d{6}$/.test(cleanCode)) {
    return { valid: false, code: 'ACTION_PASSCODE_REQUIRED', message: 'Enter your 6-Digit Master Action Passcode to authorize this operation.' };
  }

  const [rows] = await pool.query(
    'SELECT action_passcode_hash, is_onboarded FROM superadmin_security_vault WHERE LOWER(authorized_email) = ? LIMIT 1',
    [SUPERADMIN_EMAIL]
  );
  const vault = rows?.[0];
  if (!vault || Number(vault.is_onboarded) !== 1 || !vault.action_passcode_hash) {
    return { valid: false, code: 'VAULT_NOT_ONBOARDED', message: 'Complete Security Vault setup before executing sensitive operations.' };
  }

  const isMatch = verifySecretFortress(cleanCode, vault.action_passcode_hash, 'vault-action-passcode');
  await appendVaultAuditLog(pool, {
    actorEmail: SUPERADMIN_EMAIL,
    actionCode: isMatch ? `STEP_UP_VERIFIED:${actionCode}` : `STEP_UP_REJECTED:${actionCode}`,
    targetEntity,
    payloadSummary: { authorized: isMatch },
    ipAddress,
    userAgent,
  });

  if (!isMatch) {
    return { valid: false, code: 'INVALID_ACTION_PASSCODE', message: 'Invalid 6-Digit Master Action Passcode. Operation blocked.' };
  }
  return { valid: true };
}

/**
 * Lists all staff accounts and their complete 108-module dynamic permission matrix.
 */
async function listStaffAccountsWithMatrix(pool) {
  await ensureSuperAdminFortressTables(pool);
  const [accounts] = await pool.query(
    `SELECT id, username, email, full_name, primary_portal, role_title, department,
            is_active, failed_attempts, locked_until, last_login_at, created_by_email, created_at, updated_at
     FROM staff_accounts
     ORDER BY primary_portal ASC, id ASC`
  );
  const [perms] = await pool.query(
    'SELECT staff_id, module_key, access_level, updated_at FROM staff_module_permissions'
  );

  const permByStaff = new Map();
  for (const row of perms || []) {
    if (!permByStaff.has(row.staff_id)) {
      permByStaff.set(row.staff_id, {});
    }
    permByStaff.get(row.staff_id)[row.module_key] = row.access_level;
  }

  return (accounts || []).map(acc => {
    const existingMap = permByStaff.get(acc.id) || {};
    const completeMatrix = {};
    for (const mod of PLATFORM_MODULES_CATALOG) {
      completeMatrix[mod.key] = existingMap[mod.key] || 'read';
    }
    return {
      id: acc.id,
      username: acc.username,
      email: acc.email,
      fullName: acc.full_name,
      primaryPortal: acc.primary_portal,
      roleTitle: acc.role_title,
      department: acc.department,
      isActive: Boolean(acc.is_active),
      failedAttempts: Number(acc.failed_attempts || 0),
      lockedUntil: acc.locked_until,
      lastLoginAt: acc.last_login_at,
      createdAt: acc.created_at,
      permissions: completeMatrix,
    };
  });
}

/**
 * Creates a new staff login account across Admin, Warehouse, or Support portals with custom per-module permissions.
 */
async function createStaffAccountWithMatrix(pool, {
  username,
  email,
  fullName,
  password,
  primaryPortal = 'admin',
  roleTitle = 'Operations Specialist',
  department = 'Maison Operations',
  permissions = {},
  defaultAccessLevel = 'read',
  actorEmail = SUPERADMIN_EMAIL,
}) {
  await ensureSuperAdminFortressTables(pool);
  const cleanUser = String(username || '').trim().toLowerCase();
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanName = String(fullName || '').trim();
  const rawPass = String(password || '');

  if (!cleanUser || !cleanEmail || !cleanName || rawPass.length < 8) {
    const err = new Error('Username, email, full name, and a password of at least 8 characters are required.');
    err.statusCode = 400;
    throw err;
  }

  const portal = VALID_PORTALS.includes(primaryPortal) ? primaryPortal : 'admin';
  const passHash = hashSecretFortress(rawPass, 'staff-password');

  const [ins] = await pool.query(
    `INSERT INTO staff_accounts
      (username, email, full_name, password_hash, primary_portal, role_title, department, is_active, created_by_email)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    [cleanUser, cleanEmail, cleanName, passHash, portal, roleTitle, department, actorEmail]
  );

  const staffId = ins.insertId;
  for (const mod of PLATFORM_MODULES_CATALOG) {
    let level = permissions[mod.key] || defaultAccessLevel;
    if (!VALID_ACCESS_LEVELS.includes(level)) level = 'read';
    if (mod.key === 'orders.superadmin_cancellation') level = 'hidden';

    const sig = computeQuantumHash512(
      { staffId, moduleKey: mod.key, accessLevel: level },
      'STAFF_RBAC_MATRIX_512'
    );
    await pool.query(
      `INSERT INTO staff_module_permissions (staff_id, module_key, access_level, updated_by, signature_sha512)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE access_level = VALUES(access_level), updated_by = VALUES(updated_by), signature_sha512 = VALUES(signature_sha512)`,
      [staffId, mod.key, level, actorEmail, sig]
    );
  }

  return staffId;
}

/**
 * Updates a staff account's profile and dynamic 108-module permission matrix.
 */
async function updateStaffAccountMatrix(pool, {
  staffId,
  fullName,
  primaryPortal,
  roleTitle,
  department,
  isActive,
  newPassword,
  permissions = {},
  bulkCategory = null,
  bulkAccessLevel = null,
  actorEmail = SUPERADMIN_EMAIL,
}) {
  await ensureSuperAdminFortressTables(pool);
  const id = Number(staffId);
  if (!Number.isSafeInteger(id) || id < 1) {
    const err = new Error('Invalid staff account ID.');
    err.statusCode = 400;
    throw err;
  }

  const updates = [];
  const params = [];

  if (fullName !== undefined) {
    updates.push('full_name = ?');
    params.push(String(fullName).trim());
  }
  if (primaryPortal !== undefined && VALID_PORTALS.includes(primaryPortal)) {
    updates.push('primary_portal = ?');
    params.push(primaryPortal);
  }
  if (roleTitle !== undefined) {
    updates.push('role_title = ?');
    params.push(String(roleTitle).trim());
  }
  if (department !== undefined) {
    updates.push('department = ?');
    params.push(String(department).trim());
  }
  if (typeof isActive === 'boolean') {
    updates.push('is_active = ?');
    params.push(isActive ? 1 : 0);
  }
  if (typeof newPassword === 'string' && newPassword.trim().length >= 8) {
    updates.push('password_hash = ?, failed_attempts = 0, locked_until = NULL');
    params.push(hashSecretFortress(newPassword.trim(), 'staff-password'));
  }

  if (updates.length > 0) {
    params.push(id);
    await pool.query(`UPDATE staff_accounts SET ${updates.join(', ')} WHERE id = ?`, params);
  }

  const effectivePerms = { ...(permissions || {}) };
  if (bulkCategory && VALID_ACCESS_LEVELS.includes(bulkAccessLevel)) {
    for (const mod of PLATFORM_MODULES_CATALOG) {
      if (bulkCategory === 'ALL' || mod.category === bulkCategory) {
        effectivePerms[mod.key] = bulkAccessLevel;
      }
    }
  }

  for (const [moduleKey, rawLevel] of Object.entries(effectivePerms)) {
    if (!VALID_ACCESS_LEVELS.includes(rawLevel)) continue;
    // Order cancellation is exclusively SuperAdmin
    const finalLevel = moduleKey === 'orders.superadmin_cancellation' ? 'hidden' : rawLevel;
    const sig = computeQuantumHash512(
      { staffId: id, moduleKey, accessLevel: finalLevel },
      'STAFF_RBAC_MATRIX_512'
    );
    await pool.query(
      `INSERT INTO staff_module_permissions (staff_id, module_key, access_level, updated_by, signature_sha512)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE access_level = VALUES(access_level), updated_by = VALUES(updated_by), signature_sha512 = VALUES(signature_sha512)`,
      [id, moduleKey, finalLevel, actorEmail, sig]
    );
  }

  return true;
}

module.exports = {
  SUPERADMIN_EMAIL,
  VALID_ACCESS_LEVELS,
  PLATFORM_MODULES_CATALOG,
  initSuperAdminFortressTables,
  ensureSuperAdminFortressTables,
  appendVaultAuditLog,
  getVaultStatus,
  createSuperAdminOtpChallenge,
  completeFirstTimeVaultOnboarding,
  verifySuperAdminMultiFactorLogin,
  verifyStepUpActionPasscode,
  listStaffAccountsWithMatrix,
  createStaffAccountWithMatrix,
  updateStaffAccountMatrix,
};
