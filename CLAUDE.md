# CLAUDE.md — Instructions for Claude Code in Bhumivera_Backend

## Repository Overview
Node.js 22 + Express 5.3 + MySQL + Redis core REST backend for Bhumivera Organics India Private Limited.

## Core Protocols for Claude
1. **Always Read AI Memory First**:
   - Check `AI_MEMORY/00_START_HERE.md` and `AI_MEMORY/03_BOT_STATE_LEDGER.md` before analyzing code.
2. **Current Baseline**:
   - 41 route files (456 endpoints), 38 models (354 functions), 79 migrations.
3. **Mandatory Memory Update Protocol**:
   - Whenever you add or alter endpoints or model queries, you MUST update `AI_MEMORY/03_BOT_STATE_LEDGER.md` with count deltas (`Prev -> New`) and next bot instructions, even if the user did not explicitly remind you in their prompt.
4. **Validation**:
   - Run `node AI_MEMORY/scripts/audit_memory.js` to verify counters against disk.
