# 🤖 Bhumivera Backend — Bot Self-Updating Protocol & Operating Manual

> **SYSTEM LAW FOR ALL AI AGENTS & BOTS**:
> 
> You are operating within the `Bhumivera_Backend` repository.
> 
> **THE USER WILL NOT ALWAYS REMIND YOU TO UPDATE MEMORY.**
> 
> Your instructions to maintain this memory come directly from these repository files. You are expected to honor this self-enforcing protocol on **every single task** that modifies backend code.

---

## 1. The 3-Step Lifecycle

```
1. READ FIRST:
   - Check AI_MEMORY/00_START_HERE.md and AI_MEMORY/03_BOT_STATE_LEDGER.md.
   - Note the existing endpoint or function count in the file you are about to edit.

2. IMPLEMENT:
   - Write clean Express routes and MySQL queries using transaction safety.
   - Maintain the single source of truth for stock (atomicAdjustProductStock).

3. UPDATE MEMORY (MANDATORY):
   - Calculate the delta (e.g., Previous: 57, New: 58).
   - Update the count in AI_MEMORY/02_API_AND_FUNCTION_REGISTRY.md.
   - Append a new row in AI_MEMORY/03_BOT_STATE_LEDGER.md with your changes and instructions for the next bot.
```

---

## 2. Standardized Templates

### When Adding a Route / Endpoint:
1. Edit `routes/<file>.js` and add endpoint.
2. In `AI_MEMORY/02_API_AND_FUNCTION_REGISTRY.md`:
   - Increment the file's endpoint count (e.g., `57` -> `58`).
   - Increment `Total Registered Endpoints` (e.g., `456` -> `457`).
3. In `AI_MEMORY/03_BOT_STATE_LEDGER.md`, append:
   ```markdown
   | #XXX | YYYY-MM-DD HH:MM IST | [Your AI Model] | routes/<file>.js | ADDED | 57 -> 58 endpoints | Added POST /api/... with validation logic. | NEXT BOT: [Instructions] |
   ```

### When Adding a Model Function:
1. Edit `models/<file>.js` and export function.
2. In `AI_MEMORY/02_API_AND_FUNCTION_REGISTRY.md`:
   - Increment the file's export count.
   - Increment `Total Model Exported Entities` (e.g., `354` -> `355`).
3. In `AI_MEMORY/03_BOT_STATE_LEDGER.md`, record the addition.

---

## 3. Verification Command

Verify that memory numbers match actual disk files at any time:

```powershell
node "AI_MEMORY/scripts/audit_memory.js"
```
