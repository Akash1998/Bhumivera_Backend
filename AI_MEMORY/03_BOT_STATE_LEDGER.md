# 📜 Bhumivera Backend — Bot State Ledger & Change Delta Tracker

> **MANDATORY FOR ALL AI AGENTS & BOTS (Claude, Gemini, GPT, Cursor, Copilot, etc.):**  
> 
> When entering `Bhumivera_Backend`:
> 1. **LOOK HERE FIRST**: See what the previous bot completed, what files were touched, and what instructions were left for you.
> 2. **BEFORE COMPLETING YOUR TURN**: You **MUST** add a new entry to the table below detailing:
>    - What route or model you changed.
>    - The function/endpoint count **BEFORE** vs **AFTER** (e.g., Previous: 3, New: 4).
>    - Exactly what functions or queries you created/modified.
>    - Specific handoff instructions for the next bot.
> 
> *Even if the user forgot to remind you in their prompt, you are strictly bound by this ledger to record your work.*

---

## 1. Backend Baseline Counters (Verified: 2026-11-03)

| Metric | Baseline Count | Target Registry File |
| :--- | :---: | :--- |
| **Backend Route Files** | `41` | [`AI_MEMORY/02_API_AND_FUNCTION_REGISTRY.md`](./02_API_AND_FUNCTION_REGISTRY.md) |
| **Backend Total Endpoints** | `458` | [`AI_MEMORY/02_API_AND_FUNCTION_REGISTRY.md`](./02_API_AND_FUNCTION_REGISTRY.md) |
| **Backend Model Files** | `38` | [`AI_MEMORY/02_API_AND_FUNCTION_REGISTRY.md`](./02_API_AND_FUNCTION_REGISTRY.md) |
| **Backend Exported Entities** | `352` | [`AI_MEMORY/02_API_AND_FUNCTION_REGISTRY.md`](./02_API_AND_FUNCTION_REGISTRY.md) |
| **Database Migrations** | `80` (`v1` to `v80`) | [`migrations/index.js`](../migrations/index.js) |

---

## 2. Chronological Bot State & Delta Log (Living Ledger)

| Entry | Timestamp | AI Agent / Model | Target File & Module | Action | Count Delta | Exact Changes Done | Next Bot Handoff Directive |
| :---: | :---: | :---: | :--- | :---: | :---: | :--- | :--- |
| **#001** | `2026-11-03 09:46 IST` | Database Architect | `migrations/index.js` | ADDED | `78 -> 79` | Applied Migration `v79`: Omnichannel inventory software, storage keeper bins, POS billing, and staff IAM schema (`initInventorySoftwareTables`). | All subsequent warehouse and stock features must interface with `v79` tables. |
| **#002** | `2026-11-03 11:30 IST` | Full-Stack Architect | `routes/inventorySoftwareRoutes.js` | ADDED | `0 -> 57` | Created 57 omnichannel endpoints: order lifecycle, 4x6 labels, RTO returns, POS checkout, scanner bridge, and daily SQL backup. | Endpoints authenticated with `requireInventoryPermission` and `x-scanner-api-key`. |
| **#003** | `2026-11-03 17:15 IST` | Antigravity AI (Master Memory) | `AI_MEMORY/` inside Backend | ADDED | `Init` | Initialized Backend AI Memory system: `00_START_HERE.md`, `01_BACKEND_ARCHITECTURE`, `02_API_AND_FUNCTION_REGISTRY`, `03_BOT_STATE_LEDGER`, `04_BOT_SELF_UPDATE_PROTOCOL`, and audit CLI. | **NEXT BOT DIRECTIVE**: Whenever adding routes or functions, increment counters and record delta `N -> N+1`. |
| **#004** | `2026-11-05 19:45 IST` | Antigravity AI (Pricing & Combos) | `data/luxuryCatalog.js`, `models/inventorySoftwareModel.js`, `models/reviewModel.js` | MODIFIED | 3 -> 4 Combos | Implemented 3-tier combo pricing (₹1,199, ₹1,299, ₹1,499) based on founder landed costs (Soap: ₹35, FW: ₹85, Shampoo: ₹120, Tulsi: ₹70, Box: ₹100, Ship: ₹150). Added 4-piece Flagship Apothecary (`BV-BND-DAILY-01` @ ₹1,499), 3-piece Royal Trio (`BV-BND-ROYAL-03` @ ₹1,299), and Inside-Out Ritual (`BV-BND-INSIDEOUT-02` @ ₹1,199). Updated keeper costs & test suite. | **NEXT BOT**: Component stock reservation is handled atomically in `orderModel.js` via `getBundleAvailableStock`. |
| **#005** | `2026-11-06 12:17 IST` | Copilot | `routes/inventorySoftwareRoutes.js`, `test/inventoryBootstrapOrders.test.js` | MODIFIED | 57 -> 57 endpoints | Bootstrap now reports order and order-item query failures instead of returning an empty or incomplete order list; added failure tests. Audit reports 457 total endpoints and 352 model exports, differing from the older baseline. | NEXT BOT: Lifecycle refresh uses bootstrap and its latest-250-order limit; preserve explicit failure reporting if the feed is refactored. |
| **#006** | `2026-11-06 13:49 IST` | Copilot | `server.js`, `test/corsPreflight.test.js`, `docs/production-release.md`, `AI_MEMORY/02_API_AND_FUNCTION_REGISTRY.md` | MODIFIED | 457 -> 457 endpoints; 352 -> 352 model exports | Added `Idempotency-Key` to the existing CORS header allowlist while retaining `X-Idempotency-Key`; added POS preflight regression tests and deployment guidance. | NEXT BOT: POS uses `Idempotency-Key`, whereas generic request deduplication uses `X-Idempotency-Key`; keep both headers allowed without relaxing the origin allowlist. |
| **#007** | `2026-11-06 20:15 IST` | Gemini 3.8 Flash (High) | `routes/gstRoutes.js`, `server.js`, `middleware/authMiddleware.js`, `models/superAdminVaultModel.js` | MODIFIED | 457 -> 458 endpoints | Added `GET /api/gst/settings` profile alias, added graceful 30-day default date range and top-level summary/pnl payload to `GET /api/gst/reports`, added telemetry/matrix aliases (`/api/system/health` -> `systemAdminRoutes`, `/api/loyalty-tiers/matrix` -> `userRoutes`), added auth permission mappings for system health and loyalty matrix in `authMiddleware.js`, and updated RBAC catalog prefixes. Resolves admin telemetry probe 403 and 404 failures. | NEXT BOT: When adding admin audit/health probes, ensure paths are registered in both `authMiddleware.js` permission routes and `PLATFORM_MODULES_CATALOG` in `superAdminVaultModel.js`. |
| **#008** | `2026-11-06 20:42 IST` | Copilot | `routes/inventorySoftwareRoutes.js`, `Bhumivera_Frontend/src/pages/InventorySoftware.jsx` | MODIFIED | 458 -> 458 endpoints | Reduced MySQL wake-ups: `GET /bootstrap` runs the product-meta sync and daily-backup check at most once per 5 minutes per process (reads still run every load); cashier queue poll slowed from 1.5s to 4s and paused while the tab is hidden. | NEXT BOT: Do not put write-heavy work back on every `/bootstrap` call; `GET /scanner/queue` is still a DB read per poll. |
| **#009** | `2026-11-06 21:15 IST` | Antigravity AI | `data/luxuryCatalog.js`, `data/bhumiveraCatalog.js`, `models/inventorySoftwareModel.js`, `models/gstAccountingModel.js`, `routes/gstRoutes.js`, `routes/inventorySoftwareRoutes.js`, `migrations/index.js`, `test/inventorySoftware.test.js` | MODIFIED | Migrations: 79 -> 80 | Replaced all legacy cosmetic HSN `33049990` fallbacks with official manufacturer Ayurvedic drug license HSN `30049011` (and `20099000` for Kalpvriksh Satva Tulsi extract) at statutory 5% GST rate from manufacturer invoice #MGP/26-27/02 (Sitashi Herbal Industry, Jaipur, GSTIN: `08AEQFS1102P1ZM`). Updated product keeper configurations, cost prices (Sea Buckthorn ₹62, Charcoal FW ₹60, Shampoo ₹85, Soaps ₹24, Tulsi ₹40), manufacturer batch codes (`SFW26H`, `SCFW26H`, `SHS26H`, `SACHS26I`, `SANTS26I`, `SPTD26I`), supplier registry seeds, and added Migration v80. | **NEXT BOT DIRECTIVE**: All new products and bundles default to Ayurvedic HSN `30049011` @ 5% GST unless categorized as edible extract (`20099000`). Maintain `DEFAULT_PRODUCT_KEEPER_CONFIG` synchronization with `inventory_product_meta`. |
| **#010** | `2026-11-06 21:51 IST` | Copilot | `models/reviewModel.js`, `routes/reviewRoutes.js`, `test/reviewModel.test.js`, `test/migrationRunner.test.js` | FIXED | 458 -> 458 endpoints; 352 -> 352 model exports; 80 -> 80 migrations | Review list failures now propagate; permanent deletion reports missing rows or SQL failures rather than success; admin updates propagate SQL failures; empty product ratings sync to zero. Regression tests cover deletion, empty/error reads and retired review seed migrations 69–71 and 73–74. | NEXT BOT: Review seed migrations are no-ops; never repopulate deleted reviews from bundled data. Existing database records are not modified by this fix. |

---

## 3. Example Reference Pattern (How Future Bots Must Record Changes)

> **Scenario**: Suppose a developer asks: *"Add a function to move stock between bins."*

Here is how the bot that executes that task must record its action in this table:

```markdown
| #004 | 2026-11-04 10:00 IST | Gemini 3.8 Flash | routes/inventorySoftwareRoutes.js | ADDED | 57 -> 58 endpoints | Added `POST /api/inventory-software/stock/move-bin` with body `{ productId, fromBinId, toBinId, quantity }`. Added `moveStockBetweenBins()` in `models/inventorySoftwareModel.js` (exports: 18 -> 19). | NEXT BOT: When updating POS or physical audit, verify that `fromBinId` has sufficient stock before deduction. |
```
