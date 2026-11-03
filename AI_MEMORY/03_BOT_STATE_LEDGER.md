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
| **Backend Total Endpoints** | `456` | [`AI_MEMORY/02_API_AND_FUNCTION_REGISTRY.md`](./02_API_AND_FUNCTION_REGISTRY.md) |
| **Backend Model Files** | `38` | [`AI_MEMORY/02_API_AND_FUNCTION_REGISTRY.md`](./02_API_AND_FUNCTION_REGISTRY.md) |
| **Backend Exported Entities** | `354` | [`AI_MEMORY/02_API_AND_FUNCTION_REGISTRY.md`](./02_API_AND_FUNCTION_REGISTRY.md) |
| **Database Migrations** | `79` (`v1` to `v79`) | [`migrations/index.js`](../migrations/index.js) |

---

## 2. Chronological Bot State & Delta Log (Living Ledger)

| Entry | Timestamp | AI Agent / Model | Target File & Module | Action | Count Delta | Exact Changes Done | Next Bot Handoff Directive |
| :---: | :---: | :---: | :--- | :---: | :---: | :--- | :--- |
| **#001** | `2026-11-03 09:46 IST` | Database Architect | `migrations/index.js` | ADDED | `78 -> 79` | Applied Migration `v79`: Omnichannel inventory software, storage keeper bins, POS billing, and staff IAM schema (`initInventorySoftwareTables`). | All subsequent warehouse and stock features must interface with `v79` tables. |
| **#002** | `2026-11-03 11:30 IST` | Full-Stack Architect | `routes/inventorySoftwareRoutes.js` | ADDED | `0 -> 57` | Created 57 omnichannel endpoints: order lifecycle, 4x6 labels, RTO returns, POS checkout, scanner bridge, and daily SQL backup. | Endpoints authenticated with `requireInventoryPermission` and `x-scanner-api-key`. |
| **#003** | `2026-11-03 17:15 IST` | Antigravity AI (Master Memory) | `AI_MEMORY/` inside Backend | ADDED | `Init` | Initialized Backend AI Memory system: `00_START_HERE.md`, `01_BACKEND_ARCHITECTURE`, `02_API_AND_FUNCTION_REGISTRY`, `03_BOT_STATE_LEDGER`, `04_BOT_SELF_UPDATE_PROTOCOL`, and audit CLI. | **NEXT BOT DIRECTIVE**: Whenever adding routes or functions, increment counters and record delta `N -> N+1`. |

---

## 3. Example Reference Pattern (How Future Bots Must Record Changes)

> **Scenario**: Suppose a developer asks: *"Add a function to move stock between bins."*

Here is how the bot that executes that task must record its action in this table:

```markdown
| #004 | 2026-11-04 10:00 IST | Gemini 3.8 Flash | routes/inventorySoftwareRoutes.js | ADDED | 57 -> 58 endpoints | Added `POST /api/inventory-software/stock/move-bin` with body `{ productId, fromBinId, toBinId, quantity }`. Added `moveStockBetweenBins()` in `models/inventorySoftwareModel.js` (exports: 18 -> 19). | NEXT BOT: When updating POS or physical audit, verify that `fromBinId` has sufficient stock before deduction. |
```
