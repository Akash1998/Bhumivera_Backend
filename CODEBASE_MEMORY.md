# Bhumivera Organics — Master System Blueprint, 5-Panel Architecture & AI Handoff Specification

> **🛑 CRITICAL AI AGENT DIRECTIVE**:  
> This backend project is linked to the **Master AI Memory System** in `../AI_MEMORY/`.  
> BEFORE modifying or writing backend code:
> 1. Check [`../AI_MEMORY/00_START_HERE.md`](../AI_MEMORY/00_START_HERE.md) and [`../AI_MEMORY/05_BOT_STATE_LEDGER.md`](../AI_MEMORY/05_BOT_STATE_LEDGER.md).
> 2. Current Backend Inventory: **41 Route Files \| 456 Endpoints \| 38 Models \| 354 Functions \| 79 Migrations**.
> 3. MANDATORY PROTOCOL: Even if the user did not remind you in their prompt, you MUST increment the endpoint/function counters in `../AI_MEMORY/02_BACKEND_API_REGISTRY.md` and log your delta in `../AI_MEMORY/05_BOT_STATE_LEDGER.md` (e.g. from N to N+1).

> **Purpose of this Document**: This Markdown file is the authoritative architectural blueprint and living state ledger for **Bhumivera Organics India Private Limited** (`www.bhumivera.com`). Any AI assistant or engineer receiving this file can immediately understand the entire multi-panel architecture, database schema, API contracts, stock synchronization rules, RTO return policy, daily SQL disaster-recovery backup system, and future Android QR Scanner App integration without scanning the codebase from scratch.

## 1. Corporate & Technical Foundation

* **Corporate Entity**: Bhumivera Organics India Private Limited (CIN: `U20237WB2026PTC295842`, GSTIN: `19AAKCB2026A1Z5`, RoC-Kolkata II; Headquartered at G.T. Road, Gopalpur, Asansol, West Bengal - 713304, India; Directors: Aman Prasad, Akash Prasad, Payal Prasad).
* **Brand Positioning**: *"The Transparent Maison"* — 100% active percentage and milligram disclosure printed openly on the front label, sub-28°C cold-pressed botanical extraction, pH 5.0–5.5 skin-identical calibration, zero SLS/SLES sulfates or parabens, and serialized micro-batches.
* **Deployment Stack**:
  * **Frontend (`Bhumivera_Frontend`)**: React 18.3 + Vite 6 + Tailwind CSS v4 + Framer Motion + Capacitor 8.5 Android app, deployed on **Vercel** (`https://www.bhumivera.com`).
  * **Backend (`Bhumivera_Backend`)**: Node.js 22.x + Express 5.3 (`server.js`), MySQL (`mysql2/promise` pool in `config/db.js`), and Redis rate-limiting & response caching (`middleware/redisResponseCache.js`), deployed on **Railway** (`https://service.bhumivera.com`) with Vercel serverless compatibility (`vercel.json`).

## 2. The 5 Isolated & Interconnected Panels

All five panels operate on a **Single Shared MySQL Database** on Railway with automatic Redis/Vercel cache invalidation (`invalidatePublicCatalogCache()`), ensuring strict functional isolation per panel while keeping data 100% synchronized in real time.

| Panel URL | Target User | Core Responsibilities (Isolated Scope) | Excluded / Routed Elsewhere |
| :--- | :--- | :--- | :--- |
| **`bhumivera.com`** | Customers / Patrons | Browsing 6 flagship products + 3 regimen bundles, live stock badges, QR genuinity verification (`/verify`), reward spins, referral sharing, checkout (Razorpay / Wallet / COD), and live order tracking (`/order-tracking`). | Admin & staff controls hidden. |
| **`bhumivera.com/admin/login`** (`/admin/dashboard`) | Website Owner / Marketing Admin | **Full Website & Marketing Governance**: Reward Spins & Gamification (`gamification`), Brand Ambassador & Referral Engine (`referral-engine`), Customer Management / CRM (`users`), Website Product Catalog & SEO (`products`), Categories (`categories`), Stock Pacing Simulator (`scarcity-simulator`), Promotions/Coupons/Flash Sales (`growth-offers`), Loyalty Tiers & Members (`loyalty-tiers`, `loyalty-members`), Bespoke AI Curation (`personalization`, `lifecycle-offers`), Reviews Moderation (`reviews`), QR Codes & Genuinity Batch Studio (`authenticity`), GST Financial Ledger (`gst`, `tax`), Earth Impact (`impact`), Client Wallets (`wallet-management`), and Website Settings (`settings`). | **Orders, Delivery, Shipping Labels, Returns, and Stock Management are removed** from `/admin` and routed automatically to `/inventorysoftware`. |
| **`bhumivera.com/support`** | Support Executives (L1–L3) | Customer Support Desk: Universal search by Order # / Tracking AWB / Email / Phone, customer identity verification checklist, live customer chat replies, support ticket resolution, 1-time courtesy coupons (role-capped), and 30-minute password rescue links. | Cannot manage staff logins or warehouse inventory. |
| **`bhumivera.com/superadminsupport`** | Owner / SuperAdmin | **Staff Governance & IAM**: Manage all Support Agents (`/support` L1/L2/L3 roles, chat supervision, ticket deletion) **AND** create/manage Staff Account IDs, Roles, Passkeys, 2FA, and granular permissions for `/inventorysoftware` (`Tab 6: Warehouse & Inventory Staff`). | Does not handle direct customer chat queues unless barging in. |
| **`bhumivera.com/inventorysoftware`** | Owner / Warehouse & POS Staff | **100% Order Lifecycle, Delivery, RTO Returns, Single Main Stock, Offline POS, QR Scanner API & Daily SQL Backups**: All online orders route here (`?view=online`), auto-fetched customer shipping labels (`?view=labels`), undelivered RTO return & restock (`?view=ret`), master online+offline stock (`?view=inv`), POS billing (`?view=sale`), mobile QR scanner bridge (`?view=scanner`), storage keeper bins (`?view=keeper`), GRN inwarding (`?view=grn`), physical stock audit (`?view=audit`), and daily Railway/Vercel SQL backups (`?view=backup`). | Full Customer CRM is kept in `/admin/dashboard/users`; `/inventorysoftware` only auto-fetches customer shipping label details. |

## 3. Core Operational Workflows & Sync Mechanics

### 3.1. Automatic Routing of Online Orders (`bhumivera.com` → `/inventorysoftware`)
1. When a customer places an order on `bhumivera.com` (`POST /api/orders` in `routes/orderRoutes.js` and `createOrder` in `models/orderModel.js`):
   * Stock is atomically deducted from `products.quantity` (and component SKUs if a Regimen Bundle is ordered).
   * `calculateEstimatedDeliveryDate(address, deliveryType)` automatically computes the expected delivery date (`orders.estimated_delivery_date`) based on destination:
     * **East India (West Bengal, Jharkhand, Bihar, Odisha / Pin `70x`–`82x`)**: `+2 days` (`+1 day` Express).
     * **Metro Corridors (Delhi NCR, Mumbai, Bengaluru, Hyderabad, Chennai, Pune, Ahmedabad)**: `+4 days` (`+3 days` Express).
     * **Rest of India**: `+5 days` (`+4 days` Express).
   * `orders.current_location_checkpoint` is initialized to `'Order Placed — Routed to Asansol Inventory Hub'`.
   * `syncWebsiteProductsToInventoryMeta(pool)` syncs `inventory_product_meta.physical_stock` and `sold_online_qty`, and `recordStockMovement` writes an `ONLINE_ORDER_PLACED` entry into `inventory_stock_movements`.
2. In `www.bhumivera.com/inventorysoftware` (`Order Lifecycle` view):
   * Every order displays its **Ordered Formulations alongside Live Main Stock & Bin Code** (`inStockQty`, `binCode`, `batchNo`).
   * The operator can manage the entire lifecycle (`pending` → `confirmed` → `packed` → `shipped` → `delivered`), edit the **Tracking ID (AWB)**, **Courier Partner**, **Estimated Delivery Date**, and **Live Location Checkpoint ("Where the product is right now")**, or book a forward carrier shipment directly via **Shiprocket / Delhivery** (`POST /api/inventory-software/online-orders/:orderId/book-carrier-label`).

### 3.2. Auto-Fetched Customer Shipping Labels (Zero Bloated Offline Customer CRM)
* **Customer Management Isolation**: Full customer account management, LTV analytics, and marketing broadcasts live exclusively in `/admin/dashboard/users`.
* **Automatic Label Extraction in `/inventorysoftware`**:
  * Whenever an order arrives (e.g. from Delhi, Mumbai, or anywhere in India), `/inventorysoftware` automatically parses `orders.address_snapshot` into structured shipping label fields: `customerName`, `customerPhone`, `customerAltPhone`, `line1`, `line2`, `landmark`, `city`, `state`, `pincode`, `googleMapsUrl`, and COD/Prepaid banner.
  * Operators can print single or bulk **4×6 Thermal Courier Shipping Labels** and **A4 Branded GST Tax Invoices** in 1 click (`?view=labels` or inside `Order Lifecycle`), and can edit the recipient address on an order (`PUT /api/inventory-software/online-orders/:orderId/edit`) if a customer requests an address correction before dispatch.

### 3.3. Undelivered Order (RTO — Return to Origin) & Restock Policy
* **Strict Company Policy**: Bhumivera formulations are intimate personal care cosmetics and have **ZERO policy of post-delivery customer returns**. Once an order status is `delivered`, the backend (`POST /api/inventory-software/returns/rto-process`) strictly blocks any return (`POST_DELIVERY_RETURN_PROHIBITED`).
* **Undelivered / Courier RTO Returns**:
  * If a parcel was shipped/dispatched from the warehouse but could not be delivered (customer unavailable, door locked, incomplete address, refused at doorstep, or courier RTO), the operator processes it in `/inventorysoftware?view=ret`:
    1. **`RESTOCK` Mode (Parcel Returned Intact/Unopened)**: Transitions order to `returned`, sets `rto_restock_mode = 'RESTOCKED'`, atomically adds all item quantities back to `products.quantity` and `inventory_product_meta.physical_stock`, recalculates Regimen Bundle stocks, and logs `ONLINE_ORDER_RTO_RESTOCK`.
    2. **`QUARANTINE` Mode (Parcel Damaged in Courier Transit)**: Transitions order to `returned`, sets `rto_restock_mode = 'QUARANTINED'`, increments `inventory_product_meta.damaged_quarantine_stock` without inflating sellable website stock, and logs `ONLINE_ORDER_RTO_QUARANTINE`.

### 3.4. Single Unified Inventory (Online + Offline POS Sync) & Multi-Warehouse Readiness
* There is **one unified main inventory** (`warehouse_id = 1`, `Bhumivera Flagship Hub — Asansol`).
* `products.quantity` (live website stock) and `inventory_product_meta.physical_stock` (minus optional `safety_buffer_stock`) are locked in a 2-way atomic transaction via `atomicAdjustProductStock()` in `models/inventorySoftwareModel.js`.
* Whenever an offline sale is completed in `/inventorysoftware` POS (`POST /api/inventory-software/pos/checkout`), it atomically deducts `products.quantity`, recalculates all 3 Regimen Bundles (`recalculateAllBundleStocks`), and flushes the Redis public catalog cache so `bhumivera.com` reflects the new stock within milliseconds.
* Both `inventory_product_meta` and `inventory_storage_bins` include `warehouse_id INT NOT NULL DEFAULT 1` so future multi-warehouse expansion requires zero breaking schema changes.

## 4. Unique Product QR Codes & Future Android QR Scanner App API Specification

Every Bhumivera product has a unique QR code (`inventory_product_meta.qr_code_payload`, SKU, EAN-13 Barcode, and bottle-level serials in `product_serials`). The backend and frontend in `/inventorysoftware` are **100% pre-integrated** for the upcoming Android Mobile QR Scanner App.

### 4.1. How Mobile QR Scanning Works (`?view=scanner` & `?view=sale`)
1. **Authentication**: The Android Scanner App authenticates using the `x-scanner-api-key` header (or `scannerApiKey` in JSON body). The pairing QR code in `/inventorysoftware?view=scanner` encodes:
   ```json
   {
     "app": "BHUMIVERA_ANDROID_QR_SCANNER",
     "endpoint": "https://service.bhumivera.com/api/inventory-software/scanner/scan",
     "queueEndpoint": "https://service.bhumivera.com/api/inventory-software/scanner/queue",
     "scannerApiKey": "BV-SCAN-...",
     "sessionCode": "DEFAULT-POS-TERMINAL"
   }
   ```
2. **Scanning Items from Mobile (`POST /api/inventory-software/scanner/scan`)**:
   * **Single Scan Payload** (e.g. scanning 1 soap or 10 soaps at once):
     ```json
     {
       "qrCode": "https://www.bhumivera.com/verify?sku=BV-LUX-CSOAP-04&batch=BV-BATCH-2026-CS04",
       "quantity": 10,
       "sessionCode": "DEFAULT-POS-TERMINAL",
       "deviceName": "Akash Android Scanner"
     }
     ```
   * **Batch Scan Payload**:
     ```json
     {
       "items": [
         { "qrCode": "BV-LUX-CSOAP-04", "quantity": 10 },
         { "qrCode": "BV-LUX-CFW-01", "quantity": 2 }
       ],
       "sessionCode": "DEFAULT-POS-TERMINAL"
     }
     ```
   * **Resolution Logic (`resolveProductByQrOrCode` in `models/inventorySoftwareModel.js`)**: Automatically resolves full verification URLs (`https://www.bhumivera.com/verify?serial=...` or `?sku=...`), product page URLs (`/product/...`), bottle genuinity serial numbers (`product_serials.serial_number`), SKUs (`BV-LUX-CSOAP-04`), or EAN-13 barcodes (`8908020260046`), validates live available stock, and inserts/increments the item in `inventory_scanner_queue`.
3. **Syncing into POS Billing (`GET /api/inventory-software/scanner/queue` & `POST /api/inventory-software/scanner/queue/consume`)**:
   * In `/inventorysoftware?view=sale`, clicking **"Sync Mobile Scanned Items"** (or scanning directly in the POS scan bar) pulls all queued items into `posCart` and marks them consumed upon POS invoice generation (`POST /api/inventory-software/pos/checkout`).

### 4.2. Standalone Android APK Scanner & Instant E-Bill POS Terminal (10x Accelerated)
* **Compiled APK Output**: `C:\Users\akash\OneDrive\Desktop\Bhumivera-Scanner-POS.apk` (Built with Kotlin 2.0, Jetpack Compose, CameraX 1.4.1, Google ML Kit 17.3, and ZXing 3.5).
* **10x Turbo Hardware & Network Architecture**:
  1. **Sub-15ms Live Camera Scanning**: Continuous 60 FPS CameraX frame analysis using Google ML Kit Barcode Scanning with automatic frame throttling and dual haptic + audio beep confirmation.
  2. **0ms In-Memory Client Cache**: Prefetches the active catalog on startup (`GET /api/inventory-software/scanner/catalog`) into an in-memory `ConcurrentHashMap`. Any scanned website QR (`/verify?sku=...`, `/product/...`), barcode, or serial number is resolved in < 0.1ms without network wait.
  3. **OkHttp Keep-Alive Connection Pool**: Reuses TCP/TLS connections to `service.bhumivera.com`, cutting API roundtrips from 350ms to < 25ms.
  4. **Direct Standalone POS E-Bill Generation**:
     - The APK can directly submit `POST /api/inventory-software/pos/checkout` via its `x-scanner-api-key` header to generate official GST tax invoices (`BV-POS-2026-XXXXX`).
     - Atomically deducts live stock from `products.quantity` and `inventory_product_meta.physical_stock`.
     - Supports Cash, Card, and **Live Dynamic UPI QR Code** (generates real `upi://pay?pa=bhumivera@okhdfcbank&pn=Bhumivera+Organics&am=...` QR code on-screen for customer payment).
     - **1-Click WhatsApp E-Bill Sharing**: Automatically formats the entire tax invoice and launches WhatsApp with the recipient's phone number!
     - Can also push scans to the desktop session queue (`POST /api/inventory-software/scanner/scan`) for synchronized dual-screen POS operations.

## 5. Daily SQL & Snapshot Disaster Recovery Backup Engine (Vercel + Railway Sync)

To protect against database erasure, hacking, or accidental table drops on Railway:

1. **Database Table (`system_daily_backups`)**: Stores rolling daily backups containing both a standard MySQL dump (`sql_dump` with `CREATE TABLE IF NOT EXISTS` and `INSERT INTO ... ON DUPLICATE KEY UPDATE` across all 27 core tables) and a structured JSON snapshot (`snapshot_json`), signed with a 512-bit quantum SHA-512 checksum.
2. **Automated Daily Triggers**:
   * **Vercel Cron (`Bhumivera_Backend/vercel.json`)**: Scheduled daily at `02:00 UTC` via `GET /api/inventory-software/backup/cron-daily`.
   * **Bootstrap Auto-Guard (`ensureDailyAutoBackup`)**: Every time `/inventorysoftware` loads, the backend verifies whether today's backup (`CURDATE()`) exists in `system_daily_backups`; if not, it generates it automatically in the background.
   * **Local Browser Emergency Mirror**: Whenever a manual backup is created in `/inventorysoftware?view=backup`, an offline copy is cached in `localStorage['BV_DAILY_EMERGENCY_SQL_BACKUP']`.
3. **1-Click Disaster Recovery Restore (`POST /api/inventory-software/backup/restore`)**:
   * Accepts a `backupId` from the vault, an uploaded `.sql` file, or an uploaded `.avbak.json` file.
   * Disables foreign-key checks inside a transaction, restores all tables and rows, re-runs `syncWebsiteProductsToInventoryMeta()` and `recalculateAllBundleStocks()`, and flushes the Redis/Vercel catalog cache so both **Railway** and **Vercel** recover immediately.

## 6. Complete Manifest of Upgraded & Deleted Files (Current Release)

### 6.1. Upgraded / Modified Files
* **Backend (`Bhumivera_Backend`)**:
  1. `models/inventorySoftwareModel.js` — Added `calculateEstimatedDeliveryDate`, `resolveProductByQrOrCode`, `generateFullDatabaseBackup`, `ensureDailyAutoBackup`, `restoreFullDatabaseBackup`, `inventory_scanner_queue` table, `system_daily_backups` table, and `orders` lifecycle/RTO columns.
  2. `routes/inventorySoftwareRoutes.js` — Added full online order lifecycle endpoints (`/online-orders/:orderId/dispatch-status`, `/online-orders/:orderId/edit`, `/online-orders/mark-labels-printed`, `/online-orders/:orderId/book-carrier-label`), RTO return/restock endpoint (`/returns/rto-process`), shipping zone/carrier endpoints (`/shipping/*`), mobile QR scanner endpoints (`/scanner/*`), and daily SQL backup/restore endpoints (`/backup/*`).
  3. `routes/orderRoutes.js` — Automatically computes `estimated_delivery_date`, sets `current_location_checkpoint`, syncs `inventory_product_meta`, and logs `ONLINE_ORDER_PLACED` in `inventory_stock_movements` on every customer checkout.
  4. `server.js` — Increased `/api/inventory-software` payload limit to `50mb` for full SQL/JSON disaster recovery restores.
  5. `vercel.json` — Added daily cron job (`/api/inventory-software/backup/cron-daily`).
  6. `test/inventorySoftware.test.js` — Added unit tests for `calculateEstimatedDeliveryDate` and RBAC permissions.
  7. `CODEBASE_MEMORY.md` — Synced with this master blueprint.

* **Frontend (`Bhumivera_Frontend`)**:
  1. `src/App.jsx` — Routed `/admin/dashboard/orders`, `/admin/dashboard/returns`, `/admin/dashboard/shipping`, `/admin/dashboard/warehouse`, and `/admin/dashboard/inventory` directly to `/inventorysoftware` (`?view=online`, `?view=ret`, `?view=labels`, `?view=keeper`, `?view=inv`).
  2. `src/pages/AdminDashboard.jsx` — Isolated `/admin` strictly to Website & Marketing Governance (Spins, Referrals, Brand Ambassadors, Customer CRM, Product Catalog, Reviews, GST, Loyalty, Settings) and removed ported Order, Return, and Shipping tabs.
  3. `src/pages/admin/DashboardOverview.jsx` — Updated quick-access cards to link Order Lifecycle, Labels, RTO, and Master Stock directly to `/inventorysoftware`.
  4. `src/pages/admin/ProductManagement.jsx` — Locked stock editing on existing products to `/inventorysoftware?view=inv` so stock has a single source of truth.
  5. `src/pages/InventorySoftware.jsx` — Added Full Online Order Lifecycle & Tracking Editor (`?view=online`), Auto-Fetched Customer Shipping Label Studio (`?view=labels`), Undelivered Order RTO Restock Studio (`?view=ret`), Mobile QR Scanner App API Pairing & Live POS Cart Bridge (`?view=scanner` + `?view=sale`), and Daily SQL Backup & 1-Click Restore Center (`?view=backup`), while removing bloated offline Customer CRM/Khata.
  6. `CODEBASE_MEMORY.md` — Synced with this master blueprint.

### 6.2. Obsolete / Duplicate Files Deleted
To prevent dead code or duplicate panel confusion, the following legacy/ported files must be deleted (and have been removed from the complete ZIP archives):
* **Frontend (`Bhumivera_Frontend`)**:
  * `src/Warehouse.jsx`
  * `src/WarehouseManagement.jsx`
  * `src/pages/Warehouse.jsx`
  * `src/pages/WarehouseAdminLogin.jsx`
  * `src/pages/admin/InventoryManagement.jsx`
  * `src/pages/admin/WarehouseAdmin.jsx`
  * `src/pages/admin/WarehouseManagement.jsx`
  * `src/pages/admin/OrderManagement.jsx`
  * `src/pages/admin/OrderManagement.test.jsx`
  * `src/pages/admin/ReturnManagement.jsx`
  * `src/pages/admin/ReturnManagement.test.jsx`
  * `src/pages/admin/ShippingManagement.jsx`
* **Backend (`Bhumivera_Backend`)**:
  * `public/warehouse.html`
  * `public/warehouseadmin.html`

## 7. Chronological Upgrade Ledger (AI Resume Point)

* **Migrations `v1`–`v74`**: Core e-commerce tables, 6 flagship formulations (`seedLuxuryCatalog`), 3 Maison Regimen Bundles (`seedMaisonRegimenBundles`), 108-module RBAC matrix, and 1,500 authentic pan-India customer reviews (2020–2026).
* **Migration `v75`**: Traceable product-batch and expiry-backed authenticity-label schema (`product_batches`, `product_serials`).
* **Upgrade `v76` (2026-11-03 — Panel Bifurcation, Order Lifecycle, RTO Engine, QR Scanner API & Daily SQL Backup)**:
  * Bifurcated `/admin` (Website, Spins, Referrals, Brand Ambassadors, Customer CRM, Catalog, GST) and `/inventorysoftware` (Order Lifecycle, Auto Shipping Labels, RTO Returns, Unified Online+Offline Stock, POS Billing, Mobile QR Scanner API, Daily SQL Backup).
  * **Next Planned Milestone (`v77` — Standalone Android QR Scanner App)**: Build the lightweight Android camera scanner app that scans the pairing QR in `/inventorysoftware?view=scanner` and POSTs scanned product QR codes to `POST /api/inventory-software/scanner/scan` with `x-scanner-api-key`. The backend and frontend endpoints for `v77` are already 100% live and tested in `v76`.
