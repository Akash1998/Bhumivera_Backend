# Deep Scan Pending Upgrades — Consolidated Spec

## Problem Statement

A full repository deep scan across **Bhumivera_Backend** and **Bhumivera_Frontend** was performed against the 3 existing in-progress specs:
1. Premium Auth Overhaul ([spec.md](file:///C:/Users/akash/OneDrive/Documents/GitHub/Bhumivera_Backend/.trae/specs/premium-auth-overhaul/spec.md))
2. Production Stability & Security Hardening ([spec.md](file:///C:/Users/akash/OneDrive/Documents/GitHub/Bhumivera_Backend/.trae/specs/production-stability-hardening/spec.md))
3. Bhumivera Production Hardening (Frontend) ([spec.md](file:///C:/Users/akash/OneDrive/Documents/GitHub/Bhumivera_Frontend/.trae/specs/production-hardening-ecommerce/docs/spec.md))

Deep scan results show that **~82% of the frontend/backend production-hardening tasks are already implemented and working** (role-scoped token separation, interceptor 401/403 logic, order admin bypass, order indexes, coupon table init guard, warranty column-safe SELECT, breadcrumb script guard, wallet top-up remove, dead tab cleanup, etc.). GetDiagnostics reports **0 lint/type errors**.

However, **8 concrete, verifiable pending upgrades** remain across security headers, dead-code removal, dependency cleanup, and the gap between already-deployed premium-auth DB+utils layer and actual route enforcement. This spec targets only those 8 items with binary-verifiable pass criteria. Items requiring full frontend pages (magic link UI, Google OAuth consent, Profile Security tab sessions UI, 11 HTML email templates) are explicitly **scoped out** and deferred to a dedicated Premium Auth Frontend Phase.

## Goals

1. Eliminate DevTools Permissions-Policy deprecation warnings by removing unsupported directives.
2. Unify Express CSP headers (Backend `server.js`) with Vercel edge CSP headers (`vercel.json`) so both layers send the same allowlist.
3. Permanently remove 3 dead stub files (`bannerRoutes.js`, `bannerModel.js`, `fitmentRoutes.js`) that are never mounted in `server.js` and whose frontend UI counterparts were already deleted in the prior hardening pass.
4. Remove the unused native `bcrypt` package (all 6 `require()` callsites use pure-JS `bcryptjs`).
5. Actually **wire up** the already-deployed Premium Auth DB schema + utils modules into the 3 routes they are designed to protect: `POST /users/change-password`, `POST /auth/reset-password`, `POST /auth/login` (customer + admin).
6. Add the 5 missing tiered rate-limiters from the auth spec to `rateLimiter.js` exports and apply them to the matching auth endpoints.
7. Add `verify-reset-otp` + security-question alt-path reset endpoints, returning a short scoped `resetJwt` that the current `reset-password` route accepts as Bearer (backward compat preserved).

## Non-Goals

- **No new frontend pages.** ForgotPassword.jsx / ResetPassword.jsx / GoogleCallback.jsx / MagicCallback.jsx / AdminForgotPassword.jsx are deferred to a Premium Auth Frontend Phase.
- **No Google OAuth, magic-link, device-challenge, or new-device email step-up flows implemented.** Backend DB schema and utility modules for these already exist (idempotent, safe to leave as-is for future wiring); route-level integration is deferred.
- **No 11-brand-HTML-email template rewrite.** Existing mail transport (`utils/mail.js`) is unchanged.
- **No session/jti revocation / user_sessions UI / Profile Security tab rewrite.** Backend tables and `jtiCache.js` exist for future wiring.
- **No npm-major-version bumps for existing dependencies** (Node/npm PATH unavailable in the current shell; dependency version upgrades require a separate tooling pass).
- **No Frontend page or route changes are required** for the 8 accepted items in this pass.

## Users & Blast Radius

| Actor | Impact of this pass |
|---|---|
| End customer | No visual UX change; stronger password policy on password change/reset; account lockout after 6 wrong passwords; CSP/Permissions headers produce cleaner DevTools |
| Admin user | Same as customer for password change/reset/login lockout; stronger admin rate limits via new `adminStrictLimiter` |
| Warehouse admin | Same admin strict rate limits; warehouse admin role still accepted by `authenticateAdmin` (unchanged) |
| DevOps / SRE | Cleaner console 0 deprecation warnings; dead files removed reduce scanner surface; 1 unused native dep removed from build/install |

## Functional Requirements (FR)

### Group A — Security Headers & Dead Code (No DB, No Auth Flow Change)

- **FR-A1 (Permissions-Policy)**: In `server.js` the Permissions-Policy header MUST NOT contain `run-ad-auction` or `join-ad-interest-group` tokens. The remaining directives SHALL mirror `vercel.json` Permissions-Policy order and set exactly `camera=(), microphone=(), geolocation=()` or add `browsing-topics=()` if already present.
- **FR-A2 (CSP Unification)**: The `Content-Security-Policy` header emitted by `server.js` MUST, at minimum, include every origin that `vercel.json` includes in its matching directive. Specifically:
  - `script-src` adds `https://www.google-analytics.com https://ssl.google-analytics.com https://www.googletagmanager.com`
  - `frame-src` adds `https://*.google.com`
  - `connect-src` adds `https://bhumiverabackend-production.up.railway.app https://analytics.google.com https://*.google-analytics.com https://*.analytics.google.com`
  - `img-src` adds `https://*.google-analytics.com https://*.analytics.google.com`
  - `style-src` is explicitly set to `'self' 'unsafe-inline'`
- **FR-A3 (Dead Stub Delete)**: The following 3 files are deleted and their imports (if any) are removed from `server.js`:
  - `routes/bannerRoutes.js` (never `app.use()` mounted; `BannerManagement.jsx` already deleted from Frontend AdminDashboard)
  - `models/bannerModel.js` (no caller after bannerRoutes deletion)
  - `routes/fitmentRoutes.js` (never mounted; `FitmentMatrix.jsx`/`FitmentEngine.jsx` already deleted from Frontend)
  - If `server.js` requires or mounts either `bannerRoutes` or `fitmentRoutes`, those lines are also removed. (Deep scan found 0 requires, but verify-and-remove-if-present.)
- **FR-A4 (Unused bcrypt native Dependency Removal)**: Remove the native `bcrypt` package (NOT `bcryptjs`) from Backend `package.json` `dependencies`. All 6 existing `require()` callsites in the repo MUST continue to use `bcryptjs` exclusively and MUST NOT reference `bcrypt`.

### Group B — Premium Auth Layer → Route Wiring (DB + Utils Already Deployed)

The following modules **already exist on disk** and are initialized idempotently; this pass wires them into the correct route handlers:

- **FR-B1 (Password Policy + History Enforcement in change-password)**: `POST /users/change-password` in `userRoutes.js` MUST call:
  1. `validatePassword(newPassword)` from `utils/passwordPolicy.js` → if `valid === false` return `400 {code, message}`.
  2. HIBP check via `isPwned(newPassword)` from `utils/hibp.js` → if `pwned === true && skipped === false` return 400.
  3. Password-history check: fetch last 5 hashes from `password_history` table (role=`customer`) via existing helper in `models/userModel.js`, `bcrypt.compare` each → any match → `400 { code: 'PASSWORD_REUSED', message: 'Cannot reuse any of your last 5 passwords.' }`.
  4. On success: `INSERT` new hash into `password_history` table, update `users.password_hash`, set `users.last_password_change = NOW()`.
  Backward compat note: existing payload shape `{currentPassword, newPassword}` unchanged.

- **FR-B2 (Same Policy in reset-password)**: `POST /auth/reset-password` in `authRoutes.js` MUST run identical `validatePassword + HIBP + password_history (role=customer) + INSERT history` checks. Existing backward-compat body payload (`email` + `otp`) path is preserved; this pass additionally accepts a Bearer `resetJwt` (issued by the new `verify-reset-otp` endpoint below) and prefers the Bearer path if present (per current `utils/passwordPolicy.js` design spec FR-C7 step 3). On success: also dispatch a confirmation (existing email wrapper in `utils/mail.js` if/when available; log dev-mode fallback if no template) and clear `reset_otp`.

- **FR-B3 (Account Lockout + Failed Attempt Tracking)**: `POST /auth/login` for the customer branch AND the admin branch MUST:
  1. Before password compare: check `locked_until > NOW()` via existing `checkLockout(userId)` helper in userModel/adminModel → if locked return `423 {code:'ACCOUNT_LOCKED', secondsRemaining: N}`.
  2. Wrong password: `recordFailedLogin(userId)` → increments `failed_attempts`, at `>= 6` sets `locked_until = NOW() + 15 MIN` and dispatches an "Account locked" alert (existing mail wrapper if present; dev-mode console dump as fallback).
  3. Correct password: `resetFailedAttempts(userId)`.
  Admin lockout uses the same thresholds but writes to `admin_users.failed_attempts / locked_until` columns.

- **FR-B4 (5 New Tiered Rate Limiters Exported + Applied)**: In `middleware/rateLimiter.js`, add (and export alongside existing 3):
  - `forgotLimiter`: `10 / 10min / IP` with per-email sub-limit of `3 / 1h / email` (keyGenerator falls back to IP if body.email missing).
  - `magicLinkLimiter`: `5 / 10min / email`.
  - `googleCallbackLimiter`: `20 / 1min / IP`.
  - `adminStrictLimiter`: `10 / 1h / IP` applied to `/api/auth/admin/*` family.
  - `challengeLimiter`: `10 / 10min / user`.
  All response bodies on 429 SHALL include `{code, message}` consistent with FR-A4 envelope shape. Then apply them to the correct endpoints in `authRoutes.js`:
    - `forgotLimiter` on `POST /forgot-password` (currently uses `otpLimiter`; swap).
    - `adminStrictLimiter` on `/auth/admin/*` family.
    - `magicLinkLimiter` / `googleCallbackLimiter` / `challengeLimiter` mounted as middleware on those future paths (safe no-ops until routes are added in the next phase).

- **FR-B5 (Forgot 3-step endpoints)**: Add 2 new routes and refactor reset-password in `routes/authRoutes.js`:
  1. `POST /auth/verify-reset-otp` body `{email, otp}` → compare against `users.reset_otp + expires` → issue 5-min `resetJwt` (aud:`reset`, scope:`reset-password`, no jti/session). Return `{resetJwt}`.
  2. `POST /auth/security-question/verify-for-reset` body `{email, answer}` → compare against `security_answer_hash` → issue same `resetJwt`.
  3. Refactor existing `POST /auth/reset-password` to accept both the legacy body shape AND Bearer `resetJwt` (prefer Bearer). Ensure the admin mirror endpoints (FR-B5.admin) are added as well (`/auth/admin/forgot-password`, `/auth/admin/verify-reset-otp`, `/auth/admin/reset-password`) using `admin_users` columns (reset_otp, reset_otp_expires) + `password_history` role=`admin`. (These 3 admin routes mirror the same logic used in customer; they use `adminStrictLimiter` from FR-B4.)

## Non-Functional Requirements

| NFR | Requirement | Type |
|---|---|---|
| NFR-1 | Zero syntax errors in all touched backend JS files. Verifiable via `node --check <file>` | rule |
| NFR-2 | No import/reference of deleted files remains in `server.js`, `routes/*`, `models/*`, `middleware/*`, `utils/*`. Verifiable via `grep`. | rule |
| NFR-3 | All touched route handlers keep existing payload shapes as additive-only backward-compatible. Old pre-upgrade clients still work. | rule |
| NFR-4 | Third-party calls (HIBP range GET, Mailrelay send, Google token exchange placeholder) wrapped in `try/catch`; failures fall back without 500s. | rule |
| NFR-5 | `bcryptjs` only — no file references the deleted `bcrypt` package after removal. | rule |
| NFR-6 (0-2 rubric) | Clean DevTools Console: 0 Permissions-Policy deprecated directive warnings, 0 CSP blocked-uri warnings on a hard reload of a deployed or local build (best-effort; env: network-available machine). | rubric |

## Constraints & Dependencies

- **Stack frozen per existing specs**: Node + Express 4.x + mysql2 + JWT + bcryptjs (pure JS only).
- **No new npm packages installed or removed** beyond `bcrypt` native. If any FR truly requires a new dep, it is deferred.
- **No DB migration files.** All schema work uses the existing idempotent `safeCreate` / `addCol` / `SHOW COLUMNS` guard style in `userModel.js syncColumns`, `addIndex` helpers already in `orderModel.js`, etc. Tables for `password_history`, `failed_attempts/locked_until cols`, `otp_attempts`, `user_sessions`, `new_device_alerts` already exist.
- **No Frontend page file changes are required** for this upgrade pass. All acceptance evidence comes from backend curls + grep + syntax checks.
- **Node/npm PATH unavailable in current shell** → dependency-install step (`npm uninstall bcrypt`) is documented as a manual run command; the spec edits `package.json` directly and self-verifies the edit diff. User will be advised to run `npm.cmd uninstall bcrypt` once in Backend dir.

## Open Questions (Resolved During Specify)

1. **Q**: Remove `browsing-topics=()` as well in Permissions-Policy? **A**: Keep it (non-deprecated, clean). Keep `browsing-topics` if already present; only remove explicitly-named deprecated `join-ad-interest-group / run-ad-auction`.
2. **Q**: Delete `models/fitmentModel.js` too? **A**: Deep scan found 0 `fitmentModel.js` file on disk. Only `routes/fitmentRoutes.js` exists. Delete only what exists: bannerRoutes, bannerModel, fitmentRoutes.
3. **Q**: Remove `exceljs` and `@pinecone-database/pinecone` per prior hardening spec? **A**: Deep scan showed:
   - `exceljs` still actively used in [serialRoutes.js](file:///C:/Users/akash/OneDrive/Documents/GitHub/Bhumivera_Backend/routes/serialRoutes.js#L4) serial CSV export → **KEEP**.
   - `@pinecone-database/pinecone` actively used in [vectorService.js](file:///C:/Users/akash/OneDrive/Documents/GitHub/Bhumivera_Backend/services/vectorService.js#L1) and `aiRoutes.js` AI integration → **KEEP**.
   Only `bcrypt` native is confirmed 0-use.
4. **Q**: Should admin login lockout also apply to warehouse_admin? **A**: Yes — `authenticateAdmin` already accepts all 3 elevated roles; FR-B3 applies uniform lockout to all `admin_users` rows regardless of role.

## Assumptions

1. All 6 utility files in `utils/` (`passwordPolicy.js`, `commonPasswords.js`, `disposableEmails.js`, `hibp.js`, `jtiCache.js`, `otpBackoff.js`) export the function signatures documented in premium-auth-overhaul Task 2 and are syntactically valid `node --check` clean modules. If signature mismatches exist, FR-B1/FR-B2 call-sites will be adapted to the *actual* exported names; no semantic changes to the utils.
2. `password_history` DB helpers (`getLast5PasswordHashes(userId, role)`, `insertPasswordHash(userId, role, hash)`) are present as exported methods on `models/userModel.js` per Task 1. If names differ, adapt callers to actual signatures.
3. Failed-login helpers (`recordFailedLogin`, `checkLockout`, `resetFailedAttempts`) exist on userModel and adminModel per Task 1.
4. Mail templates for account_locked / password_changed_confirmation don't exist yet in branded form — fall back to existing `utils/mail.js` generic send wrapper OR safe dev-mode `console.log` mail dump Promise.resolve path per existing mailer convention — this pass enforces **calling** the mailer with a known template ID, not inventing HTML.

---

## Acceptance Criteria (Typed: rule / rubric)

### Rule ACs (Binary Pass/Fail)

- **AC-A1**: `grep -E "(join-ad-interest-group|run-ad-auction)" server.js` returns **0 matches** after edit.
- **AC-A2**: `server.js` CSP `script-src` contains the string `https://www.googletagmanager.com`; `frame-src` contains `https://*.google.com`; `connect-src` contains `https://*.analytics.google.com`; `img-src` contains `https://*.google-analytics.com`; explicit `style-src` directive is present.
- **AC-A3**: After delete pass, `dir`/`ls` of `routes/` lists **no** `bannerRoutes.js` nor `fitmentRoutes.js`; `dir` of `models/` lists **no** `bannerModel.js`; `server.js` require/mount lines for any of the 3 are 0 via grep.
- **AC-A4**: Backend `package.json` `dependencies` object does **not** contain a `bcrypt` key (lowercase, no `-js` suffix); `grep -r "require(['\"]bcrypt['\"])" --exclude-dir=node_modules` returns 0 matches outside the `package.json` diff (i.e., all 6 continue to use `bcryptjs`).
- **AC-B1 (change-password policy)**: Simulated via Node inline REPL or file-based unit test: calling `/users/change-password` (a) with newPassword=`"a"` → 400 with MIN_LENGTH code; (b) newPassword=`"Password123!"` (common top-10k) → 400 with COMMON_PASSWORD or PWNED code; (c) newPassword equal to a prior hash known in last-5 of the test user → 400 PASSWORD_REUSED; (d) strong 16-char new password → 200, and `SELECT COUNT(*) FROM password_history WHERE user_id=X` increments by exactly 1. Evidence: inline JS + DB query log.
- **AC-B2 (reset-password policy mirror)**: Same 4 sub-cases as AC-B1, targeted at `/auth/reset-password` (both the legacy body path AND the new Bearer resetJwt path).
- **AC-B3 (Lockout)**: 6 consecutive wrong passwords in POST /auth/login → 7th submission (correct OR wrong) returns HTTP **423** with JSON key `secondsRemaining` that is a positive number. `SELECT locked_until FROM users WHERE email=?` returns a non-null datetime. After 0 correct submissions but waiting >15 min (simulated via DB UPDATE for evidence), the next correct password returns 200.
- **AC-B4 (Rate Limiters)**: `node --check middleware/rateLimiter.js` passes; `require('./middleware/rateLimiter')` exports object has **8** total keys (3 original registerLimiter/loginLimiter/otpLimiter + 5 new forgot/magicLink/googleCallback/adminStrict/challenge). In authRoutes.js, `forgot-password` route handler line uses `forgotLimiter` not `otpLimiter`; `/auth/admin/*` handlers have `adminStrictLimiter`.
- **AC-B5 (Forgot 3-step + admin mirror)**: `grep "router\.(post|get)" routes/authRoutes.js` shows: (1) `verify-reset-otp`, (2) `security-question/verify-for-reset`, (3) `admin/forgot-password`, (4) `admin/verify-reset-otp`, (5) `admin/reset-password` all present. A valid OTP POST to verify-reset-otp returns a JWT whose `jwt.decode().aud === 'reset'`.

### Rubric ACs (Scored)

- **AC-U1 (Console Cleanliness 0-2)**. Pass threshold ≥ 1.
  - 0/2: Deprecated Permissions-Policy directive warnings still visible + new CSP blocks on page load.
  - 1/2: 0 Permissions-Policy deprecation warnings; at most non-blocking CSP report-only or info-level messages.
  - 2/2: Zero warnings of any kind in DevTools Console → Security tab / Issues drawer for headers.
  Evidence: Screenshot or manual observer note if browser unavailable.

- **AC-U2 (Backward Compatibility Fidelity 0-2)**. Pass threshold ≥ 2.
  - 0/2: Pre-existing POST /change-password payload shape broke; old reset-password body path 404s; GET /orders/all pagination broke; admin 403 → token wipe.
  - 1/2: One pre-existing contract breaks in a minor, recoverable way (default-valued new field).
  - 2/2: Zero pre-existing contracts break; every prior endpoint accepts the exact same payloads and returns JSON with the exact same top-level keys as before.
  Evidence: diff of pre-upgrade vs post-upgrade JSON keysets for 5 touched endpoints.
