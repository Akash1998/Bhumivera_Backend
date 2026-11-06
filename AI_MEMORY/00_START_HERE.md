# 🧠 Bhumivera Backend — Master AI Memory & Self-Enforcing Agent Protocol

> **CRITICAL DIRECTIVE FOR ALL AI AGENTS & BOTS (Claude, Gemini, GPT, Cursor, Copilot, Cline, Windsurf, etc.):**
> 
> **STOP & READ THIS FIRST BEFORE PROPOSING OR EXECUTING ANY CODE EDITS!**
> 
> Even if the USER DID NOT explicitly say *"update AI memory"* in their prompt, you are **STRICTLY REQUIRED** by this repository's architecture to:
> 1. Consult the **Current Inventory Counters** below before modifying files.
> 2. Ensure all database operations use transaction safety and honor the single source of truth for stock (`products.quantity` synced with `inventory_product_meta.physical_stock`).
> 3. **Immediately record any route/function additions or modifications in [`AI_MEMORY/03_BOT_STATE_LEDGER.md`](./03_BOT_STATE_LEDGER.md)**, incrementing the respective counters (e.g., from 3 functions to 4 functions).
> 4. Leave explicit **Next Bot Handoff Directives** so subsequent AI sessions never analyze from scratch.

---

## 1. Quick Master Navigation (Inside `Bhumivera_Backend`)

| Document | Purpose | Core Contents |
| :--- | :--- | :--- |
| **[`01_BACKEND_ARCHITECTURE.md`](./01_BACKEND_ARCHITECTURE.md)** | **Architecture Blueprint** | Node.js 22, Express 5.3, MySQL pool (`mysql2/promise`), Redis cache invalidation, Railway deployment, Vercel cron, and 5-panel backend routing. |
| **[`02_API_AND_FUNCTION_REGISTRY.md`](./02_API_AND_FUNCTION_REGISTRY.md)** | **Backend Manifest** | **41 Route Files \| 456 API Endpoints \| 38 Models \| 354 Exported Entities \| 79 Migrations**. Exact counts and signatures per file. |
| **[`03_BOT_STATE_LEDGER.md`](./03_BOT_STATE_LEDGER.md)** | **Living State & Bot Relay** | **The delta ledger**. Chronological log of bot edits, previous count vs new count, exact changes made, and instructions for next bot. |
| **[`04_BOT_SELF_UPDATE_PROTOCOL.md`](./04_BOT_SELF_UPDATE_PROTOCOL.md)** | **Bot Operating Manual** | Step-by-step instructions and templates for bots to maintain this memory system autonomously. |

---

## 2. Global Backend Counters (Verified Baseline)

*Audit verified via `node AI_MEMORY/scripts/audit_memory.js` on 2026-11-06.*

```
======================================================================
  BHUMIVERA BACKEND METRIC BASELINE
======================================================================
• Total Route Files:          41 files
• Total API Endpoints:        458 endpoints
• Total Model Files:          38 files
• Total Model Exported Items: 352 functions & constants
• Sequential Migrations:      79 (Current: v79)
• Main Framework:             Node.js 22.x / Express 5.3
• Database Engine:            MySQL 8.0 (Railway)
• Cache / Rate Limit:         Redis 7.x
======================================================================
```

---

## 3. The 5-Panel Backend Routing Rules (Zero Confusion)

1. **Storefront Endpoints (`/api/products`, `/api/orders`, `/api/reviews`)**: Public customer catalog, batch verification, checkout, and live order tracking.
2. **Website Admin Endpoints (`/api/admin-users`, `/api/gamification`, `/api/affiliates`, `/api/gst`)**: Reserved strictly for Website Marketing Governance.
   - **CRITICAL**: Do NOT add order fulfillment, shipping labels, RTO returns, or warehouse stock adjustments to `/admin`.
3. **Support Desk Endpoints (`/api/support/*`)**: L1–L3 Support Agent ticketing, live customer chat, courtesy coupons, 30-min password rescue.
4. **SuperAdmin Fortress Endpoints (`/api/passkeys`, `/api/system-admin`)**: Staff IAM, WebAuthn biometric passkeys, TOTP 2FA, 108-module RBAC matrix.
5. **Omnichannel Inventory Software Endpoints (`/api/inventory-software/*`)**:
   - Contains 57 dedicated endpoints for order lifecycle (`pending` -> `delivered`), 4x6 thermal courier labels, undelivered RTO return/restock, master stock lock, offline POS checkout, Android mobile QR scanner bridge, storage bin keeper, and daily SQL disaster-recovery backup/restore.

---

## 4. The Bot Rule: How to Handle Function Additions

Suppose you (the AI) are asked:
> *"Add a new endpoint to cancel orders after 1 hour"* or *"Add a move function to inventory stock"*

**Your mandatory workflow:**
1. **Check existing count**: E.g., `inventorySoftwareRoutes.js` currently has **57 endpoints**.
2. **Implement the function**: Write the route and model cleanly with MySQL transactions.
3. **Update Memory Ledger**:
   - Open `AI_MEMORY/03_BOT_STATE_LEDGER.md`.
   - Add a row:
     `inventorySoftwareRoutes.js` | Endpoint Count: `57 -> 58` | Added `POST /api/inventory-software/orders/:id/move` | Note for next bot: *"Function `moveOrderBin` added in model, verified with transaction lock."*
   - Update `AI_MEMORY/02_API_AND_FUNCTION_REGISTRY.md` to reflect the new count `457`.

**By following this rule, any future bot entering `Bhumivera_Backend` will immediately see what you did, the new count, and can continue building without re-reading or guessing!**
