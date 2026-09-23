# Tasks: Production Stability & Security Hardening

All paths below are absolute unless noted.

---

## Task 1: CSP & Permissions-Policy Header Alignment

**Maps to AC-R1, AC-U1**
**Priority: high**
**Status: pending**

### Description
Update CSP headers in three locations (vercel.json, index.html meta, server.js Express) and ensure Permissions-Policy contains no deprecated directives.

### Scope of Changes
- `c:\Users\akash\Pictures\Bhumivera_Frontend\vercel.json` — Add `https://vercel.live` to script-src and frame-src. Confirm Permissions-Policy only has `geolocation=(), microphone=(), camera=()` (no `run-ad-auction` / `join-ad-interest-group` — remove if present).
- `c:\Users\akash\Pictures\Bhumivera_Frontend\index.html` — Update inline meta CSP to match the unified CSP script-src list `'self' 'unsafe-inline' 'unsafe-eval' https://challenges.cloudflare.com https://vercel.live https://overbridgenet.com blob:`.
- `c:\Users\akash\Pictures\Bhumivera_Backend\server.js` — Update Express CSP header identically.

### Test Requirements (TRs)
- **TR-R1.1 (rule)**: After update, grep vercel.json, index.html, server.js — each contains `https://vercel.live` in a `script-src` position, and none contain `run-ad-auction` or `join-ad-interest-group`.
- **TR-U1.2 (rubric: AC-U1)**: Score based on DevTools Console cleanliness on a deployed/hard-refreshed build. Pass threshold: score >= 1. Evidence: manual observation note.

### Completion Evidence
_(To be filled during implement phase: file-line diff refs + verification notes.)_

---

## Task 2: Static Asset Path Standardization

**Maps to AC-R2, AC-U2**
**Priority: high**
**Status: pending**

### Description
- Copy or create `placeholder.png` at `c:\Users\akash\Pictures\Bhumivera_Frontend\public\placeholder.png` (if absent, create by copying `logo.webp` as a temporary placeholder-image placeholder with correct file name casing).
- In `index.html`, fix: `/assets/images/logo.webp` → `/logo.webp` (file actually lives at `/public/logo.webp`).
- In `SEO.jsx` `siteLogo` fallback, fix `/assets/images/logo.webp` → `/logo.webp`.
- Confirm `manifest.json` and `sw.js` already reference `/logo.webp` (do match — no change if OK).
- In `OrderManagement.jsx` `getImageUrl` fallback `/placeholder.png`, confirm file exists at that path after creation above.

### Test Requirements
- **TR-R2.1 (rule)**: Public folder lists both `logo.webp` (exact casing) and `placeholder.png` (exact casing). Every reference in index.html, SEO.jsx, OrderManagement.jsx, Cart.jsx, Home.jsx, ProductGrid.jsx, ProductDetail.jsx is root-relative `/logo.webp` or `/placeholder.png` matching an existing file.
- **TR-U2.2 (rubric: AC-U2)**: Hard reload; both assets return 200. Threshold >= 1.

### Completion Evidence
_(To be filled.)_

---

## Task 3: Frontend Axios Interceptor RBAC Fix & Admin Token Isolation

**Maps to AC-R3, AC-U3**
**Priority: high**
**Status: pending**

### Description
In `c:\Users\akash\Pictures\Bhumivera_Frontend\src\services\api.js`:

**(a) Request interceptor — admin detection expansion.**
Expand the `isAdminCall` predicate to also flag:
- `GET /api/products` (backend uses `authenticateAdmin` on `router.get('/')`)
- `GET /api/shipping/zones` (backend uses `authenticateAdmin` on `router.get('/zones')`)
- `GET /api/warranty` (backend uses `authenticateAdmin` on `router.get('/')`)

**(b) Request interceptor — no fallback to regular user token for admin calls.**
For admin calls, use ONLY `adminToken`. If `adminToken` is missing, skip setting `Authorization` header (let backend return 401 cleanly). Never fall back to `token`.

### Test Requirements
- **TR-R3.1 (rule)**: Static inspection of interceptor logic confirms:
  - `GET /api/products` → `isAdminCall === true`
  - `GET /api/shipping/zones` → `isAdminCall === true`
  - `GET /api/warranty` → `isAdminCall === true`
  - `GET /api/serials/admin/all` → `isAdminCall === true` (pre-existing — re-verify)
  - Admin branch token resolution reads ONLY `adminToken`, never `token` fallback.
- **TR-U3.2 (rubric: AC-U3)**: Inventory, Shipping, Warranty admin panels — each returns 200 with admin login and 403 with regular user. Threshold >= 1.

### Completion Evidence
_(To be filled.)_

---

## Task 4: Backend Admin Auth & JWT Role Fix

**Maps to AC-R4, AC-U3**
**Priority: high**
**Status: pending**

### Description
In `c:\Users\akash\Pictures\Bhumivera_Backend\routes\authRoutes.js`:

- `/admin/login` route — change JWT `role` claim from hardcoded `"admin"` to `u.role || "admin"`.
- `/warehouse/verify-otp` route — confirm role claim correctly sets `warehouse_admin`.

In `c:\Users\akash\Pictures\Bhumivera_Backend\middleware\authMiddleware.js`:

- `authenticateAdmin` currently accepts `['admin','superadmin']`. Add `warehouse_admin` acceptance BUT only apply this to `/api/warehouse/admin/*` calls: keep authenticateAdmin strict for pure admin panels. Option: create `authenticateAdminOrWarehouse` and use it in warehouseRoutes.js `/admin/*` subroutes. Current warehouseRoutes.js `/admin/*` uses `adminAuth` = `authenticateAdmin`. Swap to a new permissive variant there.

OR simpler: widen `authenticateAdmin` to `['admin','superadmin','warehouse_admin']` since warehouse_admin is still an elevated role and all other endpoints are gated by route-level semantics elsewhere. Document the change.

### Test Requirements
- **TR-R4.1 (rule)**: `/admin/login` decoded JWT has `role === <actual db role>` (not always "admin").
- **TR-R4.2 (rule)**: `authenticateAdmin` allows warehouse_admin OR a dedicated middleware is used for `/warehouse/admin/*` routes.

### Completion Evidence
_(To be filled.)_

---

## Task 5: Token Refresh Flow (Backend + Frontend)

**Maps to AC-R5, AC-U4**
**Priority: high**
**Status: pending**

### Description
**(a) Backend** — In `c:\Users\akash\Pictures\Bhumivera_Backend\routes\authRoutes.js`:

Add `POST /api/auth/refresh`:
- Extract Authorization Bearer token.
- Verify JWT signature (accept tokens even if expired — use `jwt.verify` with `{ ignoreExpiration: true }` but limit to e.g. 14d max age via `iat` check).
- Re-issue fresh JWT with same `{id, email, role}` and new 7d expiry.
- Return `{ token }`.

**(b) Frontend** — In `api.js` response interceptor:

On status 401 for non-auth user routes:
- Trigger refresh exactly once in-flight (use a Promise queue/lock to prevent concurrent refresh storms).
- On refresh success: update `localStorage.token` (and `ms_token` if set), re-apply `Authorization` header to the failed request config, retry the request once.
- On refresh failure: clear tokens and dispatch `auth-expired` event (current behavior).

### Test Requirements
- **TR-R5.1 (rule)**: Route `POST /api/auth/refresh` exists; returns fresh JWT given a valid (possibly expired-within-14d) signed JWT.
- **TR-R5.2 (rule)**: Frontend 401 interceptor calls refresh at most once per request cycle; retrying original request uses the new token.
- **TR-U4.3 (rubric: AC-U4)**: Simulated-expiry integration: modify a token's `exp` to the past → 1 refresh call, then successful retry. Threshold >= 1.

### Completion Evidence
_(To be filled.)_

---

## Task 6: 2FA Endpoint Unification & Payload Normalization

**Maps to AC-R6**
**Priority: high**
**Status: pending**

### Description
**(a) Frontend** — In `c:\Users\akash\Pictures\Bhumivera_Frontend\src\pages\Login.jsx` `handleVerify2FA`:

- Remove the fallback `api.post('/auth/verify-2fa', ...)` (line 104 area). Never call non-existent endpoint.
- Send a canonical payload `{ email, otp: twoFactorCode }` so backend always receives an `otp`. (Legacy `code`/`twoFactorCode` on frontend can be aliased to `otp` at send time.)

**(b) Backend** — In `authRoutes.js` `POST /2fa/verify`:

- Accept BOTH field names: treat `otp`, `code`, or `twoFactorCode` as equivalent OTP value (pick non-empty in order `otp ?? code ?? twoFactorCode`). Reject with `400 {message: "OTP code is required"}` if none present.
- Current logic compares against `reset_otp` or hardcoded `"123456"`. For users with `two_factor_enabled=1` and TOTP configured, also (if feasible) validate against TOTP secret column if one exists — if column/secret missing, fall back to existing behavior with explicit dev-mode doc.

### Test Requirements
- **TR-R6.1 (rule)**: Login.jsx contains no `/auth/verify-2fa` string.
- **TR-R6.2 (rule)**: Backend `/2fa/verify` returns meaningful 400 when `otp/code/twoFactorCode` all absent; returns 200 with token when any one matches the backend's valid OTP source.

### Completion Evidence
_(To be filled.)_

---

## Task 7: Coupon & Warranty 500 Hardening + Missing Routes

**Maps to AC-R7, AC-R8**
**Priority: high**
**Status: pending**

### Description
**(a) Coupons table init safeguard** — `c:\Users\akash\Pictures\Bhumivera_Backend\routes\couponRoutes.js`:
- Add a router-level `router.use` that calls `require('../models/couponModel').createCouponTable()` safely before any handler runs. Wrap in try/catch; log but don't crash on init failure.

**(b) Warranty `/my` column safety** — `c:\Users\akash\Pictures\Bhumivera_Backend\routes\warrantyRoutes.js`:
- In `GET /my`, do not rely on `p.image` existing unconditionally; use `COALESCE(p.image_url, p.image, '') as product_image` or SELECT known columns only and join conditionally. Wrap the query to catch `ER_BAD_FIELD_ERROR` and retry without the unknown column.

**(c) Missing `/warranty/serials` routes or frontend reroute** — Decision: **reroute frontend** to existing `/serials/*` endpoints since serialRoutes already has `/admin/all` and model methods.
- In `c:\Users\akash\Pictures\Bhumivera_Frontend\src\pages\admin\EWarrantyManagement.jsx`:
  - Replace `api.get("/warranty/serials")` → `api.get("/serials/admin/all")` and use `.data.serials` shape.
  - Replace `api.delete("/warranty/serials/${serialId}")` — choose nearest existing serial endpoint (e.g., `productId/serial` shape) or add a dedicated admin delete route. If existing serial delete requires both productId+serial and we don't have productId readily, add `DELETE /api/serials/admin/:serialId` backend route with `authenticateAdmin` that deletes from `product_serials` by id (if serial PK is id). Verify model in serialRoutes.js and add as needed.

### Test Requirements
- **TR-R7.1 (rule)**: `GET /api/coupons` never crashes with 500 even on cold DB start (table auto-created).
- **TR-R7.2 (rule)**: `GET /api/warranty/my` returns 200 with array even if products.image column is undefined/missing.
- **TR-R8.3 (rule)**: EWarrantyManagement serial fetch + delete call existing backend endpoints that return 200/204 (not 404).

### Completion Evidence
_(To be filled.)_

---

## Task 8: Dynamic Script Injection Safety Guard

**Maps to AC-U1 (no empty blob script CSP warning)**
**Priority: medium**
**Status: pending**

### Description
In `c:\Users\akash\Pictures\Bhumivera_Frontend\src\components\Breadcrumbs.jsx`:
- Ensure `JSON.stringify(breadcrumbSchema)` never produces empty/undefined content before assigning to `scriptTag.textContent`. Validate: `const schemaText = JSON.stringify(breadcrumbSchema || null); if (!schemaText || schemaText.length < 10) return;`.
- Avoid creating the element at all if schema data is malformed.

### Test Requirements
- **TR-R8.1 (rule)**: Conditional guard exists; `textContent` set only on valid non-empty JSON; element appended only if valid.

### Completion Evidence
_(To be filled.)_

---

## Task 9: Verification Pass — Diagnostics & Syntax Lint

**Priority: medium**
**Status: pending**

### Description
Run frontend/backend build/lint checks and document passing diagnostics.

### Test Requirements
- **TR-R9.1 (rule)**: `cd Bhumivera_Frontend && npm.cmd run build` completes without errors (or if build fails, only pre-existing unrelated failures).
- **TR-R9.2 (rule)**: Backend `node -c server.js` and `node -c routes/authRoutes.js` return syntax OK.

### Completion Evidence
_(To be filled.)_
