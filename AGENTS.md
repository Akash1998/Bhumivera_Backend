# 🤖 AGENTS.md — Bhumivera Backend Agent Directives

> **APPLIES TO ALL AUTONOMOUS AGENTS (Gemini, Claude, GPT, Antigravity, Aider, Roo Code, Cline, Windsurf, Cursor):**

Welcome, Agent. You have arrived at the **`Bhumivera_Backend`** repository.

## 🛑 MANDATORY FIRST ACTION
Do NOT guess or analyze the backend codebase from scratch.
**Your very first action MUST be to inspect:**
* [`AI_MEMORY/00_START_HERE.md`](./AI_MEMORY/00_START_HERE.md) — Architecture & protocols
* [`AI_MEMORY/03_BOT_STATE_LEDGER.md`](./AI_MEMORY/03_BOT_STATE_LEDGER.md) — What the last bot changed & handoff notes

---

## 📊 CURRENT SYSTEM BASELINE COUNTERS
* **Backend Route Files**: 41 files
* **Backend Total Endpoints**: 456 endpoints
* **Backend Model Files**: 38 files
* **Backend Exported Entities**: 354 functions & constants
* **Database Migrations**: 79 migrations (`v1` to `v79`)

---

## ✍️ SELF-UPDATING REQUIREMENT (MANDATORY ON EVERY CHANGE)
Even if the user's prompt DOES NOT mention updating memory:
Whenever you add, modify, or delete code:
1. Recalculate the count of functions/endpoints in that module.
2. Update the counter in [`AI_MEMORY/02_API_AND_FUNCTION_REGISTRY.md`](./AI_MEMORY/02_API_AND_FUNCTION_REGISTRY.md).
3. Append a new chronological entry to [`AI_MEMORY/03_BOT_STATE_LEDGER.md`](./AI_MEMORY/03_BOT_STATE_LEDGER.md) with:
   - File touched
   - Delta (`Previous Count -> New Count`)
   - Exact description of changes
   - Handoff note for the NEXT bot.
4. Verify using: `node AI_MEMORY/scripts/audit_memory.js`.
