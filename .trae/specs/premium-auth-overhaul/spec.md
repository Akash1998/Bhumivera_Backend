# Premium Auth Overhaul - Product Requirements Document

## Overview
- **Summary**: Upgrade Bhumivera's customer, admin, and warehouse authentication panels (Login / Register / Forgot Password / MFA / Sessions / Magic Link / Google OAuth) to a production-grade, enterprise-security, UX-polished "super heavy" tier that rivals the best ecommerce platforms (Shopify, Amazon, Cred, PhonePe).
- **Purpose**: (1) Eliminate security weaknesses (brute-force, credential-stuffing, pwned-password reuse, session hijacking, weak password choices). (2) Provide a premium UX with animations, accessibility, clear flows, and multi-channel recovery. (3) Cover every panel: customer Login/Register/Forgot, admin Login/Forgot, warehouse Login/Forgot, plus the customer Profile Security tab.
- **Target Users**: Customers (buyers on bhumivera.com), Admins / Superadmins, Warehouse admins, and future call-center staff using the admin panel.

## Goals
1. **Login panel**: Email/password + Google OAuth + Magic Link + TOTP 2FA + remember-device + new-device email challenge with IP/UA/geo.
2. **Register panel**: Email OTP verify + Turnstile + security question choice (multiple options, not just 1) + instant password strength (including pwned-check client hint) + disposable-email blocklist.
3. **Forgot Password (3-step)**: Step 1 email → Step 2 OTP-or-security-answer verify → Step 3 set new password (with server-side policy + password-history check + confirmation email).
4. **Admin & Warehouse panels**: Same premium UX (sci-fi dark/cyan theme per existing profile) with their own forgot-password flow via email OTP.
5. **Security engine**: Per-IP + per-user + per-email tiered rate-limits, account lockout after N wrong passwords (time-based auto-unlock), haveibeenpwned k-anonymity check (or local bloom if no API), password history (cannot reuse last 5), server-side password policy enforcement, session tokens with device fingerprint, session management UI (list + revoke single/all).
6. **Email**: Every event branded HTML (welcome, new login, 2FA OTP, reset OTP, password changed, magic link, new device alert) using existing Mailrelay REST transport in `utils/mail.js`.

## Non-Goals
- No native-mobile biometric login, no SMS/Twilio (user only selected Google + Magic-link).
- No WebAuthn / passkey hardware keys in this spec.
- No LDAP/SAML, no SSO beyond Google OAuth 2.0 authorization-code flow.
- Do NOT change the existing customer earth-tone palette (#0B2419, #8B5A2B, #D4AF37, #F3F9F1, #FAF8F5) or the existing admin sci-fi dark/cyan palette.
- No bcrypt library swap (bcryptjs is mandated, do NOT touch).
- No changes to the role matrix (`customer` / `admin` / `superadmin` / `warehouse_admin`).
- Do not refactor Axios interceptor or AuthContext token lifecycle unless strictly required by new login channels (Google, magic link).

## Background & Context
Audit performed 2026-09-23 against:
- Backend: `Bhumivera_Backend/` (Express + MySQL2 + bcryptjs + JWT + express-rate-limit + otplib + qrcode + Mailrelay REST API via `utils/mail.js`). Working rate limiters in `middleware/rateLimiter.js` cover register/login/otp (100/30/30) but lack per-user tier and account lockout.
- `routes/authRoutes.js` already implements `/login`, `/register` + `/verify-email`, `/forgot-password`, `/reset-password`, `/2fa/verify`, `/security-question/verify`, `/refresh`, `/admin/login` + `/admin/verify-otp`, `/warehouse/*` — but forgot HTML templates are raw monospace "Hardware access Access" sci-fi junk, and reset lacks password policy, security-question bypass is server-only (no frontend page), and userRoutes `POST /change-password` has 6-char minimum with no history/no-pwned check.
- `models/userModel.js` has `reset_otp / reset_otp_expires / two_factor_secret / two_factor_enabled / security_question / security_answer_hash` columns, but no `failed_attempts / locked_until / password_history_table / sessions_table / google_id / magic_token / remember_device`.
- Frontend: Login.jsx, Register.jsx exist. **No ForgotPassword.jsx, no ResetPassword.jsx, no MagicLinkVerify.jsx, no GoogleCallback.jsx, no Profile Security tab in Profile.jsx** — user currently has no way to click "Forgot Password" on Login page. Turnstile key VITE_TURNSTILE_SITE_KEY or fallback `0x4AAAAAAADBENLaxaG5Y9r6D` is used by Register but not Login.
- Admin panels: AdminLogin.jsx exists (dark/cyan sci-fi) but **no forgot-password UI for admins**.
- Google OAuth tokens: require `GOOGLE_OAUTH_CLIENT_ID` + `GOOGLE_OAUTH_CLIENT_SECRET` Railway env vars; frontend needs `VITE_GOOGLE_CLIENT_ID`. Missing env vars must result in graceful "Sign in with Google temporarily unavailable" message, NOT crash.

## Functional Requirements

### Customer Auth
- **FR-C1: Login page** – Login.jsx must present: Email, Password (show/hide toggle), "Remember me" (30-day), "Forgot password" link, primary "Log In", secondary divider + "Continue with Google" + "Send me a magic link", "Create account" link. Must render Turnstile widget before first submit attempt (enabled after 1 failed attempt to reduce friction for honest users; always-on for password auth after threshold).
- **FR-C2: TOTP 2FA Step** – After password submit, if user has `two_factor_enabled=1` return 202 with `requires2FA=true`; frontend must show 6-digit TOTP input with backspace nav and "Use backup codes / Use security question" fallback links. Verify must compare TOTP via otplib authenticator.verify with window:1, or allow 123456 ONLY if `process.env.NODE_ENV !== 'production'`.
- **FR-C3: Google OAuth 2.0** – Frontend "Continue with Google" → opens Google OAuth consent (via @react-oauth/google if available; fallback to window.open popup). Backend `/api/auth/google/callback` exchanges `code` for tokens, reads `openid email profile`, finds-or-creates customer by email (sets `google_id` column, does NOT overwrite password_hash of existing user), issues same 7d JWT, redirects to `/profile` with `?auth=google`.
- **FR-C4: Magic Link** – Login "Send me a magic link" opens email input; frontend calls `/api/auth/magic-link` (rate-limited: 5 / 10min / email). Backend generates single-use 32-byte token, stores `magic_token + magic_token_expires (15 min)` column, sends branded HTML email. Click → `/api/auth/magic-verify?token=...` → if unused+valid, single-swap token to NULL, issue 7d JWT, redirect to `/profile` with `?auth=magic`. Any reused token returns 410 "Link expired or already used".
- **FR-C5: Register flow 2-step** – Step 1 (Register.jsx INIT view): Name, Email, Phone (optional), Password + live strength meter (0-4 bars, min score 2 = Weak amber, min allowed score 2+ AND pwned-not-detected or user overrides with confirm). + 1-of-N security questions (dropdown: 6 curated Qs) + answer + Turnstile. Submit calls `/api/auth/register`. Step 2 (OTP view): 6-box input + resend OTP button with 30s cooldown.
- **FR-C6: Disposable email blocklist** – `/api/auth/register` and `/api/auth/forgot-password` must reject 3000+ common disposable domains (throwaway, temp-mail, 10minutemail, etc.) with "Disposable emails are not permitted; please use a permanent email address." Keep blocklist in `utils/disposableEmails.js` as a Set (NOT in DB).
- **FR-C7: Forgot Password 3-step** –
  1. `ForgotPassword.jsx` Step 1: email input + Turnstile → POST `/api/auth/forgot-password`. Always returns generic "If this email is registered, a reset OTP has been sent" (no email-enumeration). Resend with 60s cooldown.
  2. Step 2: 6-digit OTP OR "Answer security question" toggle (both paths call `/api/auth/verify-reset-otp` or `/api/auth/security-question/verify`). Server returns `resetJwt` (5-minute, scoped only to reset-password).
  3. Step 3 (ResetPassword.jsx): New password + confirm new password + live strength (min 2). Calls `/api/auth/reset-password` with `resetJwt` (Bearer) + `newPassword`.
- **FR-C8: Password change (Profile)** – Existing `/users/change-password` backend strengthened (see FR-S3). Profile Security tab: show current password + new password + confirm, alongside 2FA toggle, security question edit, and sessions list.
- **FR-C9: Session Management** – Backend: create `user_sessions` table (id, user_id, token_jti, device_info json, ip, user_agent, created_at, last_seen_at, expires_at, revoked_at, is_current). On every issue/refresh write row with jti, rotate jti on refresh. Profile UI: table of sessions (device icon, OS, browser, approximate city from IP, last seen, "This device" badge), "Revoke" per row + "Sign out of all other sessions".
- **FR-C10: New device challenge** – If login from IP + UA fingerprint combo that user has never used → issue a short-lived `challengeJwt` (instead of full session JWT), send email with 6-digit verification code + IP/geo/UA info. User enters challenge code (or clicks "This was me" one-click link) → only then issue full JWT and remember device.
- **FR-C11: Resend OTP cooldown** – Every OTP endpoint (register verify, login 2FA, forgot password, admin verify-otp) must enforce per-email exponential backoff: 30s → 60s → 180s → 600s. Track in `otp_attempts` table.

### Admin & Warehouse Auth
- **FR-A1: Admin login page** – AdminLogin.jsx must mirror Login.jsx polish (sci-fi dark/cyan theme) with email/password, show/hide, Turnstile after 1 fail, "Forgot admin password" link. No Google/magic for admins (stay with email+password+OTP, already exists).
- **FR-A2: Admin forgot password** – WarehouseAdminLogin.jsx + AdminLogin.jsx "Forgot password" → page collects email → OTP sent to registered admin email → verify OTP → set new password (backend: `/api/auth/admin/forgot-password`, `/api/auth/admin/verify-reset-otp`, `/api/auth/admin/reset-password`; separate columns in `admin_users`: `reset_otp`, `reset_otp_expires` — sync columns if missing in adminModel.js).
- **FR-A3: Admin password policy & lockout** – Same policy FR-S3 + lockout FR-S1 applied to admin_users table. 2FA enforced for all admins (server: if admin.two_factor_enabled=0, after login force step-up to enable TOTP before dashboard access).

### Security Engine (Applies to ALL panels)
- **FR-S1: Account lockout** – After 6 consecutive wrong passwords for same email in 15min → set `locked_until = NOW() + 15 MIN`, return 423 "Account temporarily locked due to multiple failed attempts. Try again in 15 minutes or reset your password." Email the registered user "Too many failed login attempts" alert. Lockout lifts automatically at locked_until or after a successful password reset.
- **FR-S2: Tiered rate limiters** – Add rate-limits in `middleware/rateLimiter.js`:
  - `forgotLimiter`: 10 / 10min / IP + 3 / 1h / email (using `keyGenerator` that falls back to IP if no email in body).
  - `magicLinkLimiter`: 5 / 10min / email.
  - `googleCallbackLimiter`: 20 / min / IP.
  - `adminStrictLimiter`: 10 / 1h / IP for all `/api/auth/admin/*`.
  - `challengeLimiter`: 10 / 10min / user.
- **FR-S3: Server-side password policy** –
  - Min length 12, max 128 (NIST SP 800-63B).
  - Must contain 3/4: uppercase, lowercase, digit, symbol.
  - Cannot be one of top 10,000 common passwords (bundled in `utils/commonPasswords.js`).
  - k-anonymity HIBP check: SHA-1 prefix 5 chars against `https://api.pwnedpasswords.com/range/{prefix}`. If range call fails (no network) log warn and SKIP (do NOT block). If match count >= 1 → reject password with "This password has been exposed in data breaches; choose a different one."
  - Password history: cannot reuse any of last 5 password hashes (stored in `password_history` table: user_id, password_hash, created_at).
- **FR-S4: Session JWT & jti** – JWT payloads issued by `/login`, `/verify-email`, `/refresh`, `/magic-verify`, `/google/callback`, `/2fa/verify`, `/admin/verify-otp`, `/warehouse/verify-otp` must include a cryptographically random `jti` (uuid v4), which is written to sessions table and checked for revocation in `authenticateUser` / `authenticateAdmin`. `POST /refresh` must rotate jti (old jti → revoked_at).
- **FR-S5: CSRF & token transport** – Keep current Bearer localStorage (no httpOnly cookie refactor, align with existing api.js interceptor contract). All POST/PUT forms must continue using CSRF-free Bearer pattern; Turnstile already mitigates abuse of unauthenticated endpoints.
- **FR-S6: Email enumeration prevention** – `/forgot-password`, `/register` must NEVER leak whether an email already exists: `/forgot-password` always returns 200 same message. `/register` already returns 409 conflict — acceptable because UX shows "Log In Instead" link; but rate-limit 409 responses per email.

### Email Templates
- **FR-E1: Branded templates** for the following events, all in Bhumivera visual language (green/cream/gold for customers, dark/cyan for admin events):
  1. Registration OTP — "Verify your email to join the registry"
  2. Welcome — "Welcome to Bhumivera, [name]" (sent after email verify success)
  3. Login OTP / Login 2FA code (admin)
  4. New login alert with IP/city/UA + "Not you? Secure your account." button
  5. New device challenge code email (step-up)
  6. Password reset OTP
  7. Password changed confirmation email (alert, always-on; informs user password was just changed — not a reset request to be confused with reset OTP)
  8. Magic link email — one-click 15-min button
  9. Admin forgot password OTP
  10. Account locked (too many failed attempts)
  11. Google account linked (first login)
- **FR-E2: All templates** include: footer unsubscribe / manage-preferences text, legal links, logo, responsive ≤600px tables, fallback text_part.

## Non-Functional Requirements
- **NFR-1 Performance**: Login/Register page load (TTI) unchanged vs current — new deps (React OAuth Google, password strength + hibp client) can be loaded via dynamic import only when user clicks that button.
- **NFR-2 Accessibility (WCAG 2.1 AA)**: All auth forms: labels + aria-invalid on errors, focus management between OTP digits, keyboard-only navigation, color contrast ≥ 4.5:1 (earth tones + dark sci-fi both already pass generally; re-verify). Success/error alerts live `role="status"` and announced via screen reader.
- **NFR-3 Security**: OWASP A07 Identification & Auth Failures compliance — credential stuffing protection, no parallel OTP brute-force (1 attempt per 1s per session), fixed-amount hashing rounds (bcrypt cost 12 minimum, up from 10).
- **NFR-4 Error consistency**: All new backend error messages follow `{ message: string, code?: string, details?: object }` envelope with correct HTTP codes (400 = invalid input, 401 = bad cred, 403 = disabled, 409 = conflict, 423 = locked, 410 = expired, 429 = rate limit).
- **NFR-5 Resilience**: All third-party calls (HIBP, Google token-exchange, Mailrelay send) wrapped in try/catch with fallback; missing env vars → graceful skip; DB init safeCreate idempotent ALTER guards (existing pattern).
- **NFR-6 Compatibility**: Existing API endpoints for login/register/verify-email/refresh/change-password MUST remain backward compatible — old frontend builds without new panels must not break.
- **NFR-7 Zero new npm packages unless absolutely necessary**. Check package.json for existing availability: `jsonwebtoken`, `bcryptjs`, `otplib`, `qrcode`, `express-rate-limit`, `axios` are present. HIBP can use built-in `https`. Google OAuth can use built-in `https` POST to `oauth2.googleapis.com/token`, no SDK needed. UUID jti with Node `crypto.randomUUID()`. Disposable email list as JSON file, no package.

## Constraints
- **Technical**:
  - Backend stack frozen: Node.js + Express 4.x + mysql2 promise pool + JWT auth (localStorage Bearer) + bcryptjs only (no native bcrypt).
  - Frontend stack frozen: Vite + React 18 + React Router v6 + Tailwind (earth palette) + framer-motion + lucide-react + @marsidev/react-turnstile already installed.
  - Mail transport ONLY via `utils/mail.js` Mailrelay REST API (no SMTP).
  - Deployment: Backend Railway, Frontend Vercel.
  - No `.env.example` hardcoding of secrets; docs warn if env vars are missing.
- **Business**:
  - Support@bhumivera.com reply-to on every mail.
  - Customer pages palette strict (no new colors). Admin palette strict.
  - Keep existing OTP code 123456 bypass ONLY when NODE_ENV != production.
- **Dependencies**:
  - If `@react-oauth/google` not present, install it as single new dependency (user-visible Google button). If already present, use existing.
  - Use `https` built-in module for Google token exchange, HIBP k-anonymity requests — NO new backend deps.

## Assumptions
1. Railway has env capacity for: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI` (https://service.Bhumivera.com/api/auth/google/callback or localhost dev fallback).
2. Vercel can expose `VITE_GOOGLE_CLIENT_ID`.
3. Railway has outbound HTTPS to `api.pwnedpasswords.com` and Google; if blocked, it fails closed gracefully (log.warn only, don't block signup).
4. Existing JWT_SECRET ≥ 32 chars.
5. `authenticateUser` / `authenticateAdmin` middleware can be safely extended to check revoked jti against sessions table without performance regression (index on (jti) + in-memory LRU TTL cache of revoked jtis for 60s).

## Acceptance Criteria

### AC-1: Login — password, Google, magic-link, 2FA all functional end-to-end
- **Type**: `rule`
- **Given**: Backend running, Mailrelay env vars present (or no-mail dev mode logs the OTPs), database migrated
- **When**: Four separate tests are executed: (a) customer email+password login, (b) Google OAuth consent with a real Google test account (or simulated code), (c) magic-link email clicked within 15 minutes, (d) user with 2FA enabled logs in and submits correct TOTP code
- **Then**: Every path returns a valid JWT; jti row exists in user_sessions; login alert email is dispatched (case a+d+g); magic link reused returns 410
- **Pass Condition**: All 4 flows complete with 200/201 final code AND jti row present AND token verified with `jwt.verify(jwt, JWT_SECRET)` → decoded.jti matches session row
- **Evidence**: Unit-style curl logs + DB select + Mailrelay logs (or dev console mail dumps) for each of the 4 flows

### AC-2: Forgot password 3-step — OTP path, security answer path, policy check
- **Type**: `rule`
- **Given**: Existing test user with known password + configured security question
- **When**: (a) POST /forgot-password with user's email → 200; open mail, extract OTP → POST /verify-reset-otp {email,otp} → resetJwt → POST /reset-password {resetJwt as Bearer, newPassword='correcthorsebatterystaple123!' with policy pass} → 200 + "Password changed" email dispatched. (b) Security answer path: skip OTP, call /security-question/verify with correct answer → resetJwt → /reset-password with new password equal to SAME as old → 400 with "Cannot reuse a previous password". (c) new password is "password123" (common and likely pwned) → 400 with pwned/common message.
- **Then**: Exactly the outcomes described occur
- **Pass Condition**: (a) 200 + mail; (b) 400 "Cannot reuse"; (c) 400 "common/pwned"
- **Evidence**: Request/response logs for each step + password_history table hashes count >= last 5 recorded after first reset

### AC-3: Disposable emails rejected, registration OTP verified, rate-limits active
- **Type**: `rule`
- **Given**: Backend live; disposable test email like `foo@temp-mail.org`; valid real test email
- **When**: (a) POST /register with disposable email → 400 "Disposable emails not permitted". (b) Valid real email flow → 200 pending; OTP entered within expiry → account created, Welcome mail dispatched. (c) POST /register 101 times from same IP in 1h → 429 Too Many after 100 (existing limiter; confirm behavior).
- **Then**: Outcomes match
- **Pass Condition**: 400 disposable + 200 pending + 201 create + 429 rate limit
- **Evidence**: Curl logs for each; pending_registrations row present then deleted after verify; users row created

### AC-4: Account lockout + challenge flow
- **Type**: `rule`
- **Given**: Valid user, valid password
- **When**: Submit 6 wrong passwords in 15min → 7th attempt (either wrong or right) returns 423. Wait 15.5 min → correct password works. (b) First login from new IP/UA → challengeJwt issued + challenge mail sent + code entered correctly → full JWT issued.
- **Then**: Locked at 7th, unlocked after timer; challenge code step works
- **Pass Condition**: 423 on 7th → 200 after wait; challenge 2-step completes with session jti saved
- **Evidence**: Request logs + `locked_until` column value + new_device_alerts table row

### AC-5: Admin/WH forgot password flow works, 2FA step-up enforced
- **Type**: `rule`
- **Given**: Admin user (superadmin) in admin_users, admin password known
- **When**: Click "Forgot admin password" on AdminLogin, enter admin email → receive OTP → submit OTP → set new 14-char strong password → 200. Login with new password, admin has no 2FA enabled → backend returns 202 step-up `requires2FA=true` (action=enable), frontend shows setup QR → user enables via /2fa/enable → next login skips step-up and returns 200 only after TOTP code.
- **Then**: Every step succeeds
- **Pass Condition**: Reset → login → step-up → enable 2FA → full login
- **Evidence**: Request/response logs + admin_users.two_factor_enabled = 1

### AC-6: Sessions UI — list + revoke single + revoke all other works
- **Type**: `rule`
- **Given**: Customer logged into 2 different browsers (session A current, session B other)
- **When**: (a) Open Profile / Security → Sessions tab shows 2 rows, one with "This device" badge. (b) Click "Revoke" on session B → next request with session B token → 401 "Session revoked". (c) Click "Sign out of all other sessions" → all sessions except current have revoked_at=NOW().
- **Then**: Outcomes above
- **Pass Condition**: Revoke works, all-other works
- **Evidence**: API calls + user_sessions rows revoked_at non-null

### AC-7: Email templates branded for every event — no more monospace sci-fi
- **Type**: `rubric`
- **Dimension**: Visual quality and completeness of all 11 required email templates vs top 10 ecommerce sites (Amazon, Shopify, Ajio, Tata CLiQ, Myntra)
- **Scale**: 1-5
- **Anchors**:
  - 1 = Templates are missing or raw monospace/sci-fi (current state of reset mail)
  - 3 = 7/11 templates exist, look OK but no consistent brand identity, no proper header/footer
  - 5 = All 11 templates rendered in correct Bhumivera palette, responsive, correct hero, signature, CTA buttons, legal links, "This is an automated email" footer, Reply-To set; text_part non-empty
- **Pass Threshold**: >= 4
- **Evidence**: Screenshots or rendered HTML of all 11 templates

### AC-8: Accessibility (WCAG 2.1 AA) on Login/Register/Forgot
- **Type**: `rubric`
- **Dimension**: Accessibility score across customer + admin auth pages using axe-core DevTools rules + manual keyboard-only walkthrough
- **Scale**: 0-5
- **Anchors**:
  - 1 = Keyboard traps, no labels on OTP inputs, contrast < 3:1 on primary CTAs
  - 3 = Labels present, keyboard works; some color-only status (no icons/text duplicates)
  - 5 = All axe rules pass (no A/AA violations), focus rings visible, skip link present, OTP digits aria-labeled "Digit N of 6", success/error `role=status`, contrast >= 4.5:1 on every text+icon pair
- **Pass Threshold**: >= 4
- **Evidence**: axe-core automated scan report + manual walkthrough log

### AC-9: Password policy server-enforced (client bypass attempt via curl)
- **Type**: `rule`
- **Given**: Valid customer JWT
- **When**: (a) curl -X POST /users/change-password -d '{"currentPassword":"<known>","newPassword":"abc"}' → 400 min length. (b) 12 char all lowercase "aaaaaaaaaaaa" → 400 3/4 complexity. (c) "Password123!" (common top-10k + pwned) → 400 common/pwned. (d) Strong 16 char new unique → 200 + password_history row created.
- **Then**: Outcomes match; all rejections contain code field
- **Pass Condition**: a=400, b=400, c=400, d=200
- **Evidence**: Curl logs with response body (code present) + password_history table after step d

### AC-10: No-regressions — existing interceptor + refresh flow unaffected
- **Type**: `rule`
- **Given**: Existing AuthContext + api.js interceptor
- **When**: (a) Old existing endpoints `/login`, `/verify-email`, `/refresh`, `/users/change-password`, `/admin/login`, `/warehouse/*` are exercised with their PRE-SPEC payloads (no google/magic/challenge fields)
- **Then**: Every endpoint returns the same status codes and body shapes as before (shapes = same keys present, new keys OPTIONAL/additive only); api.js 401/403 interceptor still wipes correct role tokens only, 403 never wipes
- **Pass Condition**: Full backward compatibility for pre-overhaul clients
- **Evidence**: Snapshot curl outputs from pre-implementation vs post-implementation (compare keyset differences as set-ops)

## Open Questions
- [ ] Does Bhumivera have a Google Cloud project with OAuth consent screen already configured (for client ID/secret)? If not, we ship graceful fallback: Google button hidden when VITE_GOOGLE_CLIENT_ID missing.
- [ ] User wants IP→City geo: can we use a free in-memory DB-IP CSV, or do we skip rough-location and display only IP+ISP?
- [ ] Do we need admin impersonate feature? (Not in current scope; spec Non-Goals excludes it, but confirmation welcome.)
- [ ] What is the reply-to email name you prefer on all mails? Default: "Bhumivera Concierge <support@bhumivera.com>".
