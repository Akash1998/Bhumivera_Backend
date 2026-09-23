# Spec: Production Stability & Security Hardening

## Problem

The Bhumivera ecommerce platform is experiencing multiple production issues across security headers, static assets, authentication/authorization, 2FA workflow, and server-side crashes. These manifest as browser CSP/Permissions-Policy warnings, 404 missing assets, 403 RBAC failures on admin routes, 401 unauthorized on user routes, 400/404 on 2FA endpoints, and 500 errors on coupons and warranties.

## Users & Goals

| Actor | Goal |
|---|---|
| End customer | Shop, authenticate, use cart/wishlist/wallet without 401 errors |
| Admin user | Manage inventory, coupons, shipping, warranties without 403 errors |
| DevOps / SRE | Clean console with zero CSP/Permissions-Policy warnings; all assets return 200 |

## Non-Goals

- Complete UX redesign
- Database migration (only add missing indexes/columns required for correctness)
- Full OAuth/OIDC replacement for JWT

---

## Functional Requirements

### FR-1: Permissions-Policy & CSP Header Cleanup
- Remove any Permissions-Policy directives unsupported by the modern browser policy engine (e.g., `run-ad-auction`, `join-ad-interest-group` if present).
- Add `https://vercel.live` to script-src and frame-src CSP allowlists across:
  - Frontend `vercel.json`
  - Frontend `index.html` meta CSP
  - Backend `server.js` Express CSP header
- Ensure script-src explicitly allows: `'self' 'unsafe-inline' 'unsafe-eval' https://challenges.cloudflare.com https://vercel.live https://overbridgenet.com blob:`
- Prevent dynamically-injected `<script>` elements from having empty/undefined `src` or `textContent` before DOM attachment.

### FR-2: Static Asset Path Standardization
- Ensure `placeholder.png` and `logo.webp` exist at `/public/` root (Vite serves this at the site root).
- Standardize all references in `index.html`, `manifest.json`, `sw.js`, `SEO.jsx`, and image fallback helpers to use root-relative paths matching actual public files.
- Case-sensitivity audit: All references must match exact file casing (Linux/Railway is case-sensitive).

### FR-3: Admin RBAC (403 Resolution)
- In the frontend Axios request interceptor (`api.js`), correctly identify ALL admin routes per the backend middleware usage:
  - `GET /api/products` is admin-protected (backend uses `authenticateAdmin`)
  - `GET /api/shipping/zones` is admin-protected
  - `GET /api/warranty` is admin-protected
  - `GET /api/serials/admin/all` is admin-protected
  - All other write/admin endpoints previously listed
- Prevent interceptor from falling back to a regular user `token` when `adminToken` is absent; only use `adminToken` for admin-categorized calls.
- Backend `authenticateAdmin` must accept roles `['admin', 'superadmin', 'warehouse_admin']` for warehouse-scoped admin endpoints when the route requires it (current logic only allows admin/superadmin — break glass: allow warehouse_admin on the specific `/api/warehouse/admin/*` chain via `isWarehouseAdmin`).
- Backend `/api/auth/admin/login` JWT payload must encode the **actual** role from the `admin_users` row (not hardcoded `"admin"`).

### FR-4: User Token Refresh Mechanism (401 Resolution)
- Backend: Create `POST /api/auth/refresh` that accepts the current (possibly expired but still signed) JWT and issues a new JWT for the same user identity, provided the token signature is valid.
- Frontend: Implement a response interceptor in `api.js` that detects 401s on user-protected routes, attempts one refresh via `/api/auth/refresh`, updates `localStorage.token`, then retries the original failed request exactly once; if refresh fails, clear tokens and dispatch `auth-expired`.

### FR-5: 2FA Endpoint Standardization & Validation
- Standardize the single 2FA verify endpoint name to `/api/auth/2fa/verify` everywhere (remove fallback to non-existent `/api/auth/verify-2fa` in Login.jsx).
- Backend `/api/auth/2fa/verify` DTO validation: Accept both legacy `{email, otp}` and authenticator-style `{email, code}` / `{email, twoFactorCode}` fields (normalize `code` → `otp`), respond 400 with message when neither `otp` nor `code` is present.
- Backend `/api/auth/2fa/verify` authenticator flow (TOTP) should compare against the stored TOTP secret for users with `two_factor_enabled=1` (current code compares against reset_otp which is wrong for authenticator 2FA; fix: add TOTP verification fallback or allow `123456` bypass only for development if env flag is set).

### FR-6: 500 Server Crash Hardening
- **Coupons 500**: Ensure `coupons` table is initialized before any route handler accesses it (call `createCouponTable()` inside a route-level middleware in `couponRoutes.js`). Wrap every route handler in `try/catch` (all handlers already wrapped — verify). Ensure DB column names in `public/active` SELECT match schema exactly.
- **Warranties /my 500**: In `warrantyRoutes.js`, the `GET /my` handler's JOIN query can fail if `products.image` column doesn't exist or LEFT JOIN alias is inconsistent. Gracefully handle missing columns (query wrapped with `try/catch` already — verify).
- **`/warranty/serials` 404**: Backend warranty routes currently have no `/serials` sub-router. Either add missing routes (`GET /api/warranty/serials`, `DELETE /api/warranty/serials/:id`) backed by `product_serials` table, or fix frontend `EWarrantyManagement.jsx` to use the correct `/api/serials/...` endpoints.
- All controller-level routes in couponRoutes & warrantyRoutes already wrapped — but add explicit column-existence safe SELECT with fallback columns to avoid 500 from `ER_BAD_FIELD_ERROR`.

### FR-7: Dynamically Injected Script Safety
- In `Breadcrumbs.jsx`, guard `document.createElement('script')` append so that `textContent` is always a valid non-empty JSON string and `src` (if used) is validated before append.

---

## Non-Functional Requirements

| NFR | Criterion |
|---|---|
| NFR-1 Compatibility | All changes backward-compatible with current frontend bundle (no import-breaking changes). |
| NFR-2 Observability | Every catch block logs `console.error` with route/context prefix before returning 500. |
| NFR-3 Security | CSP additions only add explicitly required origins; no wildcards beyond existing policy. |
| NFR-4 Idempotency | Token refresh is single-shot per failed request; no retry storms. |

---

## Constraints & Dependencies

- Backend runs on Node.js + Express + MySQL (Railway).
- Frontend runs on Vite + React, deployed to Vercel.
- Environment variables in Railway: `JWT_SECRET` (required), optional `CLOUDFRONT_BASE_URL`.
- `node_modules` already present; no new mandatory packages allowed unless absolutely necessary (prefer built-in `crypto` for TOTP if needed).

## Assumptions

- `adminUsers.role` values include at least `{admin, superadmin, warehouse_admin}`.
- Regular users cannot have role `admin/superadmin`.
- TOTP authenticator secret storage is handled by existing user model columns (or accepted as out-of-scope if missing; default to `otp`/`reset_otp` flow for all 2FA with clear documentation).

## Open Questions

- **OQ-1**: Is TOTP (authenticator app) 2FA actually live in production, or is the only 2FA path email OTP via `reset_otp` column? Determines FR-5 implementation depth.
- **OQ-2**: Should `/api/warranty/serials` be added (new backend routes) or frontend rewired to `/api/serials/*`?

---

## Acceptance Criteria

### Rule ACs (Binary Pass/Fail)

- **AC-R1**: `vercel.json`, `index.html` meta CSP, and backend `server.js` CSP all include `https://vercel.live` in script-src; Permissions-Policy contains no `run-ad-auction` or `join-ad-interest-group` tokens.
- **AC-R2**: Every file reference to `logo.webp` and `placeholder.png` in frontend resolves to a file that actually exists under `/public/` with exact casing.
- **AC-R3**: Axios request interceptor flags `GET /api/products`, `GET /api/shipping/zones`, `GET /api/warranty`, and `GET /api/serials/admin/*` as admin calls AND uses `adminToken` exclusively for those calls (no fallback to regular `token`).
- **AC-R4**: Admin login JWT contains the actual `role` from the DB row; `authenticateAdmin` passes for roles that the respective route requires.
- **AC-R5**: Backend exposes `POST /api/auth/refresh`; frontend interceptor performs single refresh+retry on 401.
- **AC-R6**: One canonical 2FA endpoint exists: `/api/auth/2fa/verify`; Login.jsx never calls `/api/auth/verify-2fa`; backend accepts both `{otp}` and `{code}` payload shapes.
- **AC-R7**: `GET /api/coupons` and `GET /api/warranty/my` never crash with 500 due to missing tables/columns; worst case returns empty array with 200 or 4xx with message.
- **AC-R8**: `EWarrantyManagement.jsx` never requests a non-existent `/api/warranty/serials` URL (backend route added OR frontend rerouted).

### Rubric ACs (Scored)

- **AC-U1 Console cleanliness (0-2)**: Score 2 if DevTools Console shows zero Permissions-Policy / CSP violation warnings on hard reload. Score 1 if only informational (non-blocking) warnings remain. Score 0 otherwise.
- **AC-U2 Asset loading (0-2)**: Score 2 if `placeholder.png` and `logo.webp` both return 200 on hard refresh with 0 404s in Network tab. Score 1 if one 200 + one gracefully-fallback-to-200 via onError. Score 0 if either returns 404.
- **AC-U3 RBAC correctness (0-2)**: Score 2 if admin UI modules (Inventory, Shipping, Warranty) all respond 200 with admin login and 403 with regular-user token. Score 1 if 1 module still fails. Score 0 otherwise.
- **AC-U4 Recovery resilience (0-2)**: Score 2 if simulating an expired user JWT triggers exactly ONE refresh call (visible in Network), followed by a successful retry of the original request with the new token. Score 1 if refresh happens but retry still fails due to unrelated issues. Score 0 if no refresh occurs.
