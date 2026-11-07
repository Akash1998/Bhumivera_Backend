# ⚙️ Bhumivera Backend — API & Function Registry Manifest

> **Master Backend Inventory**: 41 Route Files | 469 REST API Endpoints | 38 Database Models | 357 Model Functions | 80 Migrations
> **Framework**: Express 5.3 + Node.js 22.x | MySQL 8.0 (`mysql2/promise`) | Redis 7.x  
> **Last Verified Audit**: 2026-11-07 (Migration v80)

---

## 1. Global Backend Counters

The `server.js` CORS configuration allows both `Idempotency-Key` for POS checkout and `X-Idempotency-Key` for request deduplication; this does not change route or model counts.

```
+-------------------------------------------------------------+
| BACKEND METRIC                   | CURRENT VERIFIED COUNT    |
+----------------------------------+---------------------------+
| Total Route Files                | 41 files                  |
| Total Registered Endpoints       | 469 endpoints             |
| Total Model Files                | 38 files                  |
| Total Model Exported Entities    | 357 functions/constants   |
| Database Migrations Defined      | 80 migrations (v1 - v80)  |
+----------------------------------+---------------------------+
```

---

## 2. Complete Inventory of All 41 Route Files

| # | Route File | Total Endpoints | Primary Responsibility | Key HTTP Methods & Paths |
| :---: | :--- | :---: | :--- | :--- |
| **1** | `inventorySoftwareRoutes.js` | **69** | Omnichannel Orders, Labels, RTO, Stock, POS, Scanner Bridge, FEFO, Wave Picklist, Manifest, persistent pack progress, Returns QC, Live Order Item Editor, Package Finder | `GET /bootstrap`, `GET /summary`, `GET /orders` (paginated), `GET /stock/forecast` (AI DOC velocity), `GET /orders/:id/fefo-picks`, `GET /orders/:id/manifest`, `PUT /orders/:id/items`, `GET /package/lookup`, `POST /fulfillment/wave-picklist`, `POST /fulfillment/manifest`, `POST /fulfillment/verify-pack`, `POST /returns/qc-grade`, `POST /pos/checkout` (batch locked); scanner keys expire after 12 hours |
| **2** | `supportRoutes.js` | **50** | L1–L3 Customer Support Desk, Live Chat, Ticket Resolution, Courtesy Coupons | `GET /tickets`, `POST /chat/reply`, `POST /coupons/issue-courtesy`, `POST /rescue-password` |
| **3** | `authRoutes.js` | **32** | User Authentication, OTP Verification, Password Reset, JWT Token Refresh | `POST /register`, `POST /login`, `POST /verify-otp`, `POST /refresh-token`, `POST /logout` |
| **4** | `userRoutes.js` | **22** | Customer Profiles, Address Defaults, User Audit, Profile Preferences | `GET /profile`, `PUT /profile`, `GET /orders`, `PUT /change-password`, `DELETE /account` |
| **5** | `gstRoutes.js` | **22** | GST Ledger, Tax Invoices, B2B/B2C Compliance, GSTR Reports | `GET /profile`, `GET /settings`, `GET /reports`, `POST /products/bulk-tax` |
| **6** | `serialRoutes.js` | **19** | Product Authenticity Verification, Serial QR Generation, Batch Serials | `GET /verify/:serial`, `POST /batch/generate`, `GET /batch/:id/serials`, `POST /claim-box-gift` |
| **7** | `productRoutes.js` | **17** | Public Product Catalog, Slug Resolution, Batch CoA, Potency Tables | `GET /`, `GET /:id`, `GET /slug/:slug`, `POST /`, `PUT /:id`, `DELETE /:id` |
| **8** | `settingsRoutes.js` | **17** | Global System Settings, Shipping Thresholds, Gamification Odds, Site Metadata | `GET /`, `GET /group/:group`, `PUT /`, `POST /cache/flush` |
| **9** | `adminUserRoutes.js` | **16** | Website Admin User Management, Admin Roles, Permissions Matrix | `GET /users`, `PUT /users/:id/role`, `PUT /users/:id/status`, `GET /audit-log` |
| **10** | `warehouseRoutes.js` | **16** | Legacy Warehouse Management, Multi-bin Allocation, Storage Bins | `GET /bins`, `POST /bins/allocate`, `GET /movements` |
| **11** | `notificationRoutes.js` | **15** | Push Notifications, FCM Tokens, Order Alerts, Marketing Broadcasts | `GET /`, `POST /subscribe`, `POST /send`, `PUT /:id/read` |
| **12** | `reviewRoutes.js` | **14** | Database-backed customer reviews, stories and moderation; failed reads and deletes return errors | `GET /product/:id`, `GET /combo/:slug`, `POST /`, `PUT /:id/approve`, `DELETE /:id` |
| **13** | `orderRoutes.js` | **13** | Online Checkout, Delivery Calculation, Razorpay Webhook, Order Checkpoints | `POST /`, `GET /user`, `GET /:id`, `POST /verify-payment`, `POST /cancel` |
| **14** | `couponRoutes.js` | **11** | Promotional Coupons, Cart Discounts, Usage Tracking, First-order Codes | `POST /validate`, `GET /active`, `POST /`, `PUT /:id`, `DELETE /:id` |
| **15** | `returnRoutes.js` | **10** | Customer Return Requests & Courier Tracking Validation | `POST /request`, `GET /status/:id`, `GET /history` |
| **16** | `shippingRoutes.js` | **10** | Indian Shipping Zones, State Pincode Matrix, Free Shipping Rules | `GET /zones`, `POST /calculate-rate`, `PUT /zones/:id` |
| **17** | `affiliateRoutes.js` | **8** | Brand Ambassador Program, Referral Tracking, Commission Payouts | `GET /dashboard`, `POST /apply`, `GET /conversions` |
| **18** | `contactRoutes.js` | **7** | Customer Inquiries, Partnership Forms, Corporate Outreach | `POST /inquiry`, `GET /submissions`, `PUT /:id/resolve` |
| **19** | `flashSalesRoutes.js` | **7** | Scarcity Flash Sales, Timer Triggers, Reserved Quota Badges | `GET /active`, `POST /schedule`, `PUT /:id` |
| **20** | `impactRoutes.js` | **7** | Earth Impact Ledger, Botanical Sourcing Verification, Carbon Offsets | `GET /metrics`, `POST /update`, `GET /ledger` |
| **21** | `walletRoutes.js` | **7** | Customer Shopping Wallets, Refund Balances, Loyalty Cashbacks | `GET /balance`, `POST /redeem`, `GET /history` |
| **22** | `warrantyRoutes.js` | **7** | Formulation Freshness Warranty & Serial Authenticity Registration | `POST /register`, `GET /status/:serial` |
| **23** | `aiRoutes.js` | **6** | Gemini AI Concierge, Deterministic FAQ Matcher, Sentiment Analysis | `POST /ask`, `POST /copilot-rescue`, `POST /sentiment` |
| **24** | `cartRoutes.js` | **6** | Persistent User Carts, Cart Item Sync, Mini-cart Drawer State | `GET /`, `POST /add`, `PUT /update`, `DELETE /remove`, `POST /clear` |
| **25** | `categoryRoutes.js` | **6** | Product Categories & Tax Classification | `GET /`, `GET /:id`, `POST /`, `PUT /:id`, `DELETE /:id` |
| **26** | `passkeyRoutes.js` | **6** | WebAuthn FIDO2 Biometric Passkeys for SuperAdmin & Staff | `POST /register/options`, `POST /register/verify`, `POST /auth/options`, `POST /auth/verify` |
| **27** | `shippingLabelRoutes.js` | **6** | 4x6 Thermal Courier Label Generation & Shiprocket/Delhivery Bridge | `GET /labels/:orderId`, `POST /generate-batch`, `GET /manifest` |
| **28** | `subcategoryRoutes.js` | **6** | Botanical Formulation Subcategories | `GET /`, `POST /`, `PUT /:id`, `DELETE /:id` |
| **29** | `addressRoutes.js` | **5** | Customer Delivery Address Book (GST/Pincode validation) | `GET /`, `POST /`, `PUT /:id`, `DELETE /:id`, `PUT /:id/default` |
| **30** | `analyticsRoutes.js` | **5** | Marketing Analytics, LTV, Conversion Funnels, Daily Revenue | `GET /summary`, `GET /traffic`, `GET /conversions` |
| **31** | `gamificationRoutes.js` | **5** | Lucky Wheel Reward Spins, Win Rates, Prize Distribution | `GET /wheel-config`, `POST /spin`, `POST /claim` |
| **32** | `inventoryRoutes.js` | **5** | Public Product Availability & Stock Buffer Badges | `GET /status`, `GET /availability/:id` |
| **33** | `wishlistRoutes.js` | **5** | Customer Wishlist, Restock Alerts | `GET /`, `POST /add`, `DELETE /:id` |
| **34** | `taxRoutes.js` | **4** | HSN/SAC Codes, GST Percentages (5%, 12%, 18%) | `GET /hsn`, `POST /rates`, `PUT /:id` |
| **35** | `systemAdminRoutes.js` | **3** | Server Health, Railway DB Heartbeat, Redis Ping | `GET /health`, `GET /ping`, `GET /version` |
| **36** | `paymentRoutes.js` | **2** | Razorpay Order Creation & Webhook Verification | `POST /razorpay/create-order`, `POST /razorpay/webhook` |
| **37** | `recommendationRoutes.js` | **2** | Personalized Botanical Formulations Engine | `GET /suggested/:productId`, `GET /home-curated` |
| **38** | `searchRoutes.js` | **2** | Catalog Full-Text Search & Live Search Suggestions | `GET /query`, `GET /autocomplete` |
| **39** | `clientLogRoutes.js` | **1** | Frontend Client-side Error Ingestion & Telemetry | `POST /log` |
| **40** | `logsRoutes.js` | **1** | System Error & Activity Log Streaming | `GET /` |
| **41** | `newsletterRoutes.js` | **1** | Botanical Journal Email Subscription | `POST /subscribe` |

---

## 3. Database Models & Exported Functions (38 Files | 357 Functions)

1. **`inventorySoftwareModel.js` (23 items)**: `VALID_INVENTORY_ROLES`, `INVENTORY_PERMISSION_DEFINITIONS`, `ROLE_DEFAULT_INVENTORY_PERMISSIONS`, `resolveInventoryPermissions`, `generateTotpSecret`, `verifyTotpCode`, `calculateEstimatedDeliveryDate`, `initInventorySoftwareTables`, `ensureInventorySoftwareTables`, `syncWebsiteProductsToInventoryMeta`, `recalculateAllBundleStocks`, `appendInventoryAuditLog`, `recordStockMovement`, `atomicAdjustProductStock`, `resolveProductByQrOrCode`, `generateFullDatabaseBackup`, `ensureDailyAutoBackup`, `restoreFullDatabaseBackup`, `calculateInventoryVelocityAndDoc`, `allocateFefoBatchesForOrder`, `generateWavePicklist`, `generateCarrierManifest`, `processReturnQcGrade`.
2. **`userModel.js` (33 items)**: `createUsersTable`, `createUser`, `getUserByEmail`, `getUserById`, `verifyPassword`, `updateUserPassword`, `ensureUserColumns`, `listUsers`, `searchUsers`.
3. **`aiSupportModel.js` (25 items)**: `VALID_CHAT_STATUSES`, `VALID_SUPPORT_ROLES`, `ROLE_DEFAULT_PERMISSIONS`, `createChatSession`, `addChatMessage`, `escalateToHuman`, `resolveChat`.
4. **`reviewModel.js` (16 items)**: `createReviewTable`, `createReview`, `createReviewAsAdmin`, `getReviewsByProduct`, `getReviewsByComboName`, `getPublicCustomerStories`, `getProductRatingSummary`, `getAllReviews`, `approveReview`, `archiveReview`, `deleteReviewPermanently`, `getUserReviews`, `updateReviewAsAdmin`, `syncProductStats`, `PRODUCT_SLUGS`, `PRODUCT_NAMES`, `COMBO_BY_KEY`.
5. **`productModel.js` (19 items)**: `initProductsTable`, `getAllProducts`, `getActiveProducts`, `getProductById`, `getProductBySlug`, `createProduct`, `updateProduct`, `deleteProduct`.
6. **`couponModel.js` (17 items)**: `createCouponTable`, `sanitizeCouponCode`, `validateCouponCode`, `getUserCouponRedemptionCount`, `recordCouponUsage`.
7. **`gstAccountingModel.js` (16 items)**: `enrichGstDocument`, `numberToIndianRupeeWords`, `initGstAccountingTables`, `generateTaxInvoiceNumber`, `recordGstInvoice`.
8. **`referralModel.js` (15 items)**: `ensureReferralCode`, `findReferralUser`, `creditReferralBonus`, `calculateReferralCommission`.
9. **`superAdminVaultModel.js` (14 items)**: `SUPERADMIN_EMAIL`, `VALID_ACCESS_LEVELS`, `initSuperAdminFortressTables`, `verifySuperAdminPasskey`, `logAdminSecurityEvent`.
10. **`adminModel.js` (12 items)**: `getAdminByEmail`, `getAdminById`, `verifyPassword`, `updateAdminPassword`, `initAdminTable`.
11. **`orderModel.js` (10 items)**: `createOrder`, `getDeliveredOrderCount`, `getOrdersByUser`, `getAllOrders`, `getOrderById`, `updateOrderStatus`.
12. **`productBatchModel.js` (10 items)**: `MAX_BATCH_SIZE`, `createProductBatch`, `createGenuinitySerialQR`, `listGenuinitySerials`, `deleteGenuinitySerial`.
13. **`loyaltyTierModel.js` (10 items)**: `createLoyaltyTierTable`, `listLoyaltyTiers`, `getLoyaltyConfig`, `saveLoyaltyConfig`, `computeUserTier`.
14. **`shippingLabelModel.js` (9 items)**: `initShippingLabelTables`, `getCarrierAccount`, `saveCarrierAccount`, `listCarrierAccounts`, `beginShippingLabel`.
15. **`notificationModel.js` (8 items)**: `createNotificationTable`, `createNotification`, `logSystemEvent`, `getNotificationsForUser`, `markAsRead`.
16. **`serialModel.js` (8 items)**: `initSerialTable`, `getAllSerials`, `getProductSerials`, `addProductSerials`, `deleteProductSerial`.
17. **`shippingModel.js` (8 items)**: `createShippingTable`, `getAllZones`, `getActiveZones`, `getZoneById`, `createZone`.
18. **`returnModel.js` (8 items)**: `initReturnsTable`, `createReturn`, `createReturnRequest`, `getReturnsByUser`, `getReturnById`.
19. **`categoryModel.js` (8 items)**: `getAllCategories`, `getCategoryById`, `createCategory`, `updateCategory`, `deleteCategory`.
20. **`cartModel.js` (7 items)**: `getCartByUser`, `upsertCartItem`, `updateCartItemQuantity`, `removeCartItem`, `clearCart`.
21. **`cartRulesModel.js` (7 items)**: `createCartRulesTable`, `listCartRules`, `getCartRuleById`, `createCartRule`, `updateCartRule`.
22. **`impactModel.js` (5 items)**: `initImpactTables`, `upgradeImpactContributionSchema`, `getPublicImpact`, `getAllContributions`.
23. **`shoppingWalletRewardModel.js` (7 items)**: `calculateShoppingWalletReward`, `issueOrderShoppingWalletReward`.
24. **`warrantyModel.js` (6 items)**: `validateSerial`, `registerWarranty`, `getAllRegistrations`.
25. **`settingsModel.js` (6 items)**: `createSettingsTable`, `getAllSettings`, `getSettingsByGroup`, `getSetting`, `updateSetting`.
26. **`wishlistModel.js` (5 items)**: `createWishlistTable`, `addToWishlist`, `removeFromWishlist`, `getWishlistByUser`.
27. **`deviceTokenModel.js` (5 items)**: `ensureDeviceTokensTable`, `registerDeviceToken`, `unregisterDeviceToken`, `getAllActiveTokens`.
28. **`subcategoryModel.js` (7 items)**: `initSubcategoriesTable`, `getAllSubcategories`, `getSubcategoryById`.
29. **`clientErrorModel.js` (3 items)**: `createClientErrorTable`, `createClientError`, `getClientErrors`.
30. **`recommendationModel.js` (3 items)**: `createRecommendationTables`, `recordProductView`, `getPersonalizedRecommendations`.
31. **`warehouseModel.js` (3 items)**: `initWarehouseTables`, `restoreLegacyBackup`, `logWalkinSale`.
32. **`addressModel.js` (2 items)**: `createAddressTable`, `AddressModel`.
33. **`contactModel.js` (2 items)**: `initContactTable`, `ContactModel`.
34. **`newsletterModel.js` (2 items)**: `createNewsletterTable`, `subscribeNewsletter`.
35. **`walletModel.js` (2 items)**: `initWalletTables`, `WalletModel`.
36. **`otpModel.js` (19 items)**: `saveOtp`, `verifyOtp`, `clearOtp`, `rateLimitOtp`.
37. **`returnRefundModel.js` (1 item)**: `initReturnRefundTable`.
38. **`smsService.js` (1 item)**: `sendOTP`.

---

## 4. Sequential Database Migrations (v1 – v79)

* **`v1`–`v74`**: Core eCommerce schema, luxury catalog seed, regimen bundles, and 1,500 pan-India customer reviews.
* **`v75`**: Traceable micro-batches and bottle serial numbers (`product_batches`, `product_serials`).
* **`v76`**: One-time delivered-order box gift claims (`box_gift_claims`).
* **`v77`**: Free shipping threshold ₹599, referral threshold ₹799, loyalty cap 10%.
* **`v78`**: Welcome bonus balance in referral wallets.
* **`v79`**: Omnichannel inventory software, storage keeper, POS billing, and staff IAM schema (`initInventorySoftwareTables`).
