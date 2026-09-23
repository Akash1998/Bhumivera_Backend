# Premium Auth Overhaul - Implementation Plan

This plan decomposes the 10 Acceptance Criteria in spec.md into 21 implementation tasks.
Dependency order (vertical slices): DB/models first → security utils → rate limiters → backend routes → email templates → frontend pages → route wiring → verify.

---

## Task 1: DB schema extensions (users, admin_users, tables for sessions, password_history, otp_attempts, new_device_alerts)
- **Status**: `pending`
- **Priority**: high
- **Depends On**: None
- **Description**:
  - In `models/userModel.js` sync `users` columns: `failed_attempts INT DEFAULT 0`, `locked_until DATETIME`, `google_id VARCHAR(255)`, `magic_token VARCHAR(255)`, `magic_token_expires DATETIME`, `last_password_change DATETIME`, `remember_device_hash VARCHAR(255)`.
  - In `models/adminModel.js` sync `admin_users` columns: `failed_attempts INT DEFAULT 0`, `locked_until DATETIME`, `reset_otp VARCHAR(10)`, `reset_otp_expires DATETIME`, `two_factor_secret VARCHAR(255)`, `two_factor_enabled TINYINT(1) DEFAULT 0`.
  - Safe-create 4 new tables via idempotent CREATE TABLE IF NOT EXISTS:
    - `user_sessions` (id PK, user_id, jti UNIQUE, device_info JSON, ip VARCHAR(64), user_agent TEXT, created_at, last_seen_at, expires_at, revoked_at, is_current TINYINT, INDEX(jti), INDEX(user_id))
    - `admin_sessions` same for admins
    - `password_history` (id PK, user_id, role ENUM('customer','admin','warehouse_admin'), password_hash VARCHAR(255), created_at, INDEX(user_id,role))
    - `otp_attempts` (id PK, scope ENUM('register','login2fa','forgot','admin_forgot','challenge'), email VARCHAR(150), attempt_count INT, backoff_seconds INT DEFAULT 30, last_attempt_at, next_allowed_at, INDEX(scope,email))
    - `new_device_alerts` (id PK, user_id, role ENUM(...), ip, user_agent, city VARCHAR(128), challenge_code CHAR(6), expires_at, used TINYINT DEFAULT 0)
  - All ALTERs wrapped in SHOW COLUMNS guards (existing pattern in userModel.js syncColumns).
- **Acceptance Criteria Addressed**: AC-1, AC-4, AC-5, AC-6
- **Test Requirements**:
  - `rule` TR-1.1: `node --check models/userModel.js` && `node --check models/adminModel.js` → exit 0. Server boot logs `[DB_SYNC] Adding missing column...` messages only on first run; no SQL errors after 3 consecutive cold starts.
  - `rule` TR-1.2: After first boot, `SHOW TABLES` returns 4 new table names; every column in task description present via `SHOW COLUMNS`.
- **Notes**: No DB migration files; use existing safeCreate server boot pattern invoked from `server.js`.

## Task 2: Security utility modules (password policy, disposable email blocklist, common passwords, HIBP k-anonymity, jti revocation cache)
- **Status**: `pending`
- **Priority**: high
- **Depends On**: None (parallel with T1)
- **Description**:
  - Create `utils/passwordPolicy.js`: exports `validatePassword(pw) → { valid, errors:[{code,message}], score04 }`. NIST 12 min / 128 max; 3/4 uppercase/lowercase/digit/symbol; reject 10k common passwords; optional HIBP prefix; return score 0-4 (same bars as UI).
  - Create `utils/commonPasswords.js`: exports Set of top 10,000 common passwords (source: SecLists 10k-most-common). Use bundled raw list file; Set lookup O(1).
  - Create `utils/disposableEmails.js`: exports Set of ~3000 disposable domains.
  - Create `utils/hibp.js`: exports async `isPwned(pw) → { pwned:boolean, count:number, skipped:boolean }`. SHA-1, prefix 5 → GET https://api.pwnedpasswords.com/range/{prefix}. Skip on network fail, never throw.
  - Create `utils/jtiCache.js`: in-memory LRU (max 10,000 keys, TTL 60s) with `markRevoked(jti)`, `isRevoked(jti)` — used by authMiddleware before DB fallback hit.
- **Acceptance Criteria Addressed**: AC-2, AC-3, AC-9
- **Test Requirements**:
  - `rule` TR-2.1: `validatePassword('a')` → valid=false, code='MIN_LENGTH'; validatePassword('aaaaaaaaaaaa') → valid=false code='COMPLEXITY'; validatePassword('Password123!') → valid=false code='COMMON_PASSWORD' (since present in top-10k).
  - `rule` TR-2.2: `isDisposable('foo@temp-mail.org')` → true; `isDisposable('foo@gmail.com')` → false.
  - `rubric` TR-2.3: *Performance* — 100 sequential `isDisposable` checks complete in < 5ms on a 2.4 GHz laptop. Scale 1-5. Anchors: 1=100ms+, 3=10-100ms, 5=<5ms. Threshold >= 4. Evidence: `console.time` 100 runs.
- **Notes**: No packages; Set + built-in crypto + https.

## Task 3: Rate limiter extension (5 new limiters: forgot/magic/googleCallback/adminStrict/challenge)
- **Status**: `pending`
- **Priority**: high
- **Depends On**: None (parallel with T1, T2)
- **Description**:
  - Edit `middleware/rateLimiter.js` add 5 rateLimit instances (see spec FR-S2 table for window/max values).
  - `forgotLimiter`: keyGenerator returns body.email if present else req.ip; standardHeaders true; legacy false; message 429 with code='TOO_MANY_RESET_REQUESTS'.
  - Re-export all in module.exports block; do not remove existing registerLimiter/loginLimiter/otpLimiter.
- **Acceptance Criteria Addressed**: AC-1, AC-2, AC-3, AC-5
- **Test Requirements**:
  - `rule` TR-3.1: `node --check middleware/rateLimiter.js` → exit 0; exports object has 8 keys (3 old + 5 new).
  - `rule` TR-3.2: After 11 forgot requests within 10 minutes from same email → 11th response status=429 body.code='TOO_MANY_RESET_REQUESTS'.
- **Notes**: Use `express-rate-limit` — already installed.

## Task 4: Extend auth middleware (jti revocation check + jti DB write on issue)
- **Status**: `pending`
- **Priority**: high
- **Depends On**: T1 (sessions tables), T2 (jtiCache)
- **Description**:
  - Edit `middleware/authMiddleware.js`: inside `authenticateUser`, after jwt.verify, if `decoded.jti`: (1) jtiCache.isRevoked → 401 SESSION_REVOKED. (2) DB `SELECT revoked_at FROM user_sessions WHERE jti=?` → if revoked_at not null → 401 + markCache. (3) Update `last_seen_at = NOW()` in that session row (non-blocking fire-and-forget).
  - Same additions for `authenticateAdmin` against admin_sessions.
  - Export a new helper `issueToken({payload, secret, opts, sessionMeta})` that attaches jti (crypto.randomUUID), writes sessions table row, returns token. Called from all route files that sign JWTs.
- **Acceptance Criteria Addressed**: AC-1, AC-6, AC-10
- **Test Requirements**:
  - `rule` TR-4.1: After login, SELECT jti FROM user_sessions WHERE user_id=? returns non-null jti; calling the revoke endpoint (later in T9) makes next authenticateUser call return 401 code=SESSION_REVOKED.
  - `rule` TR-4.2: POST /refresh rotates jti (old jti revoked_at set, new jti present). api.js interceptor's `_attemptRefresh` receives fresh JWT with new jti.
- **Notes**: Keep existing authenticate signatures backward compatible; do not break existing users of the middleware.

## Task 5: Password engine integration + password_history enforcement in userRoutes.change-password + authRoutes.reset-password
- **Status**: `pending`
- **Priority**: high
- **Depends On**: T1 (password_history table), T2 (passwordPolicy + hibp)
- **Description**:
  - Edit `userRoutes.js` POST `/change-password`: replace 6-char min with passwordPolicy.validatePassword + history check: fetch last 5 hashes from password_history for user, bcrypt.compare newPw against each → any match → 400 code='PASSWORD_REUSED'. On success, INSERT new hash into password_history, UPDATE users.password_hash + last_password_change.
  - Edit `routes/authRoutes.js` POST `/reset-password`: same policy + same password_history INSERT; use resetScope-jwt user_id from decoded resetJwt (new endpoint below creates resetJwt; update current /reset-password to accept resetJwt as Bearer instead of email+otp body for security — keep backward compat by allowing BOTH old body OR new Bearer, deprecate body).
  - Same logic applied to `/api/auth/admin/reset-password` (T13 creates route) against password_history with role='admin'.
- **Acceptance Criteria Addressed**: AC-2, AC-9
- **Test Requirements**:
  - `rule` TR-5.1: New password equal to any of last 5 → 400 code='PASSWORD_REUSED' with details showing 'Cannot reuse any of your last 5 passwords'.
  - `rule` TR-5.2: New password 'Password1!' → rejected with code='COMMON_PASSWORD' (or PWNED if HIBP live).
  - `rule` TR-5.3: After successful change, `SELECT COUNT(*) FROM password_history WHERE user_id=X` increments by exactly 1.

## Task 6: Login security upgrade — account lockout + failed attempt tracking
- **Status**: `pending`
- **Priority**: high
- **Depends On**: T1 (failed_attempts, locked_until cols), T5 (password engine), T4 (issueToken helper)
- **Description**:
  - Edit `routes/authRoutes.js` POST `/login` for customer and admin branches:
    1. Before compare: check locked_until > NOW() → 423 code='ACCOUNT_LOCKED' with secondsRemaining.
    2. Wrong password → UPDATE users failed_attempts = failed_attempts + 1; IF failed_attempts >= 6 → SET locked_until = NOW() + INTERVAL 15 MINUTE; dispatch ACCOUNT_LOCKED alert email.
    3. Correct password → reset failed_attempts=0, locked_until=NULL, proceed.
  - Send "New login alert" email (T10 templates path) on every successful login containing IP, UA, approximate city (if geo available, else IP only), link "Not you? Secure your account" pointing to `/profile?tab=security`.
- **Acceptance Criteria Addressed**: AC-1, AC-4
- **Test Requirements**:
  - `rule` TR-6.1: 6 wrong passwords → 7th (correct) returns 423 with secondsRemaining ~900; locked_until column non-null; 15.5 min later correct password 200.
  - `rule` TR-6.2: After each successful login → user_sessions row inserted with is_current=1.
  - `rule` TR-6.3: Account lock email dispatched (or dev console dump) with template ID 'account_locked'.

## Task 7: New Device Challenge flow + remember-device
- **Status**: `pending`
- **Priority**: high
- **Depends On**: T1 (new_device_alerts + remember_device_hash cols), T6 (login)
- **Description**:
  - Compute device fingerprint: hash SHA-256(`${ip}|${ua.browser}|${ua.os}|${ua.platform}`) → `deviceHash`.
  - On successful customer login password (before issueToken): check if user has previous session with same deviceHash OR remember_device_hash == deviceHash. If NO previous match: INSERT new_device_alerts row; send challenge email containing 6-digit code + "This was me" one-click link; return HTTP 202 `{ requiresDeviceChallenge: true, challengeToken: shortLivedJwt }` instead of full session JWT.
  - Add new endpoint POST `/api/auth/device-challenge/verify` → body: `{ challengeToken, code }` OR `{ oneTimeLinkToken }` → if valid → SET remember_device_hash = deviceHash for user; issue full session JWT.
  - Add frontend payload (later T16): user login response 202 device challenge → show code input.
- **Acceptance Criteria Addressed**: AC-4, AC-1
- **Test Requirements**:
  - `rule` TR-7.1: First login from a never-seen device → response status=202 body.requiresDeviceChallenge=true; email contains 6-digit code. Correct code POSTed → 200 + JWT.
  - `rule` TR-7.2: Second login from same deviceHash → no challenge (direct 200).
  - `rule` TR-7.3: Challenge code reused after success → returns 410.

## Task 8: Google OAuth 2.0 integration endpoints (backend)
- **Status**: `pending`
- **Priority**: high
- **Depends On**: T4 (issueToken), T6 (login alert dispatch)
- **Description**:
  - New routes in `routes/authRoutes.js`:
    - GET `/api/auth/google/url` → returns `{ url: googleAuthorizeUrl }` using scopes openid+email+profile; include redirect_uri=process.env.GOOGLE_OAUTH_REDIRECT_URI || fallback.
    - GET/POST `/api/auth/google/callback` → exchange `code` via POST https://oauth2.googleapis.com/token → decode id_token (or GET userinfo) → email, sub(google_id), name, picture.
    - findOrCreate customer in users table by email: if user exists → link (UPDATE google_id=sub if null); if new user → INSERT name/email, password_hash set to NULL (impossible password login), role='customer'. Dispatch "Welcome" email for new users.
    - Issue full session JWT via issueToken (writes user_sessions); redirect 302 to `${FRONTEND_URL}/google-callback?token=JWT&status=success` OR status=error&msg=...
  - All wrapped in try/catch; missing env vars → google/url returns `{ enabled: false, reason='GOOGLE_OAUTH_CLIENT_ID not configured' }` (safe fallback).
- **Acceptance Criteria Addressed**: AC-1, AC-10
- **Test Requirements**:
  - `rule` TR-8.1: Missing env vars → `/api/auth/google/url` → 200 `{ enabled:false }`; no errors.
  - `rule` TR-8.2: With valid env vars, simulated Google code exchange → user row created OR google_id linked; JWT jti present in user_sessions; redirect to frontend success URL.
  - `rule` TR-8.3: Existing user's password_hash is NEVER overwritten during Google link (check users.password_hash unchanged).

## Task 9: Magic Link backend flow (issue + verify single-use)
- **Status**: `pending`
- **Priority**: high
- **Depends On**: T1 (magic_token cols), T3 (magicLinkLimiter), T4 (issueToken), T10 (email template — called but templates created in parallel)
- **Description**:
  - Add POST `/api/auth/magic-link` → payload { email } → validate email format, check disposable; if user exists → generate `crypto.randomBytes(32).toString('hex')` as token; UPDATE users magic_token, magic_token_expires = NOW()+15min; dispatch magic link email (T10 template).
  - Add GET `/api/auth/magic-verify` → query `token` → SELECT user WHERE magic_token = token AND magic_token_expires > NOW() AND magic_token IS NOT NULL → if found: single-swap magic_token=NULL, magic_token_expires=NULL (prevents replay); issue session JWT; 302 redirect to `${FRONTEND_URL}/magic-callback?token=JWT&status=success`. If token not found → redirect to `${FRONTEND_URL}/login?error=magic_link_invalid`. If expired → `?error=magic_link_expired`.
- **Acceptance Criteria Addressed**: AC-1
- **Test Requirements**:
  - `rule` TR-9.1: Issued magic link works on first GET → user session created, magic_token cleared.
  - `rule` TR-9.2: Second GET of same magic URL → redirect to login?error=magic_link_invalid (410 semantics via redirect param).
  - `rule` TR-9.3: After 15+ minutes, valid unused link → redirect expired.

## Task 10: All 11 branded email templates (render helpers in utils/mail.js)
- **Status**: `pending`
- **Priority**: high
- **Depends On**: None (parallel with most tasks; templates referenced by T6, T7, T8, T9, T12, T13, T14)
- **Description**:
  - Create `utils/emailTemplates.js` (NOT a new package; pure template literals) with named exports for each event (11 in FR-E1 list).
  - Customer palette: header cream + #0B2419 serif title + #D4AF37 accent bars, CTA buttons rounded 6px, legal footer (Privacy / Terms / Contact), "This is an automated email, do not reply directly" note.
  - Admin palette: dark #0A0F1E background, cyan #22D3EE accent CTA, white body text, monospace secondary.
  - Each template exports `{ subject, html, text }`.
  - Add helper `sendTemplate(to, templateName, vars={})` that wraps mail.js sendMail; logs "Mail would be sent" + template dump when MAILRELAY_API_KEY env missing (dev convenience, never throw).
- **Acceptance Criteria Addressed**: AC-7
- **Test Requirements**:
  - `rule` TR-10.1: 11 templates named exactly `['registration_otp','welcome','login_otp_admin','new_login_alert','new_device_challenge','password_reset_otp','password_changed_confirmation','magic_link','admin_forgot_otp','account_locked','google_account_linked']` all have non-empty subject+html+text.
  - `rubric` TR-10.2: Visual quality of 3 key templates (welcome + magic_link + password_changed) per AC-7 rubric anchors. Scale 1-5, threshold >= 4. Evidence: rendered PNG/html-preview screenshots.
  - `rule` TR-10.3: Missing MAILRELAY_API_KEY → sendTemplate logs template dump and resolves (silent success, never throw Promise rejection).
- **Notes**: Template HTML must use inline styles + table layout, no external images (except logo as data URI of logo.webp public file, embed as base64 < 5KB; if too large, just text BHUMIVERA header).

## Task 11: Customer Register upgrade (6 question choice, phone, strengthened validation, disposable block, pwned hint client)
- **Status**: `pending`
- **Priority**: high
- **Depends On**: T10 (templates, server side ready in T2 parallel)
- **Description**:
  - Edit existing `Register.jsx`:
    1. Replace hardcoded "mother's maiden name" with dropdown `<select>` of 6 security questions (pick any 6 standard: pet name, first car, high school mascot, city born, mother maiden, father middle). Select value sent as `securityQuestion` text to backend.
    2. Add Phone input (optional, E.164 format pre-check /^\(?\+?[0-9\s\-)]{7,}$/).
    3. Password input under label: show live text hints (e.g., "Add a number", "Add uppercase") — one line per missing constraint with icon ✅/❌.
    4. Register init: client-side disposable email check (copy of Set or lightweight top ~200 quick reject; server full blocklist authoritative). If detected → show "Disposable emails not permitted" BEFORE submit (UX).
    5. Keep Turnstile widget. Keep existing OTP step animation; add RESEND OTP button disabled for 30s after click (uses exponential backoff — server tracks).
- **Acceptance Criteria Addressed**: AC-3, AC-8
- **Test Requirements**:
  - `rule` TR-11.1: Disposable email entered → client validation error before submit; submit also blocked by server with 400 'DISPOSABLE_EMAIL'.
  - `rule` TR-11.2: 6 security question options present; value correctly attached to formData.securityQuestion and sent to backend.
  - `rubric` TR-11.3: WCAG AA accessibility score for Register.jsx. Scale 0-5 threshold >= 4 per AC-8 anchors.
- **Notes**: Backend already accepts security_question; frontend just must pass it instead of using hardcoded.

## Task 12: Customer Forgot Password — backend 3-step endpoints (verify-otp returns scoped resetJwt)
- **Status**: `pending`
- **Priority**: high
- **Depends On**: T1 (users reset cols), T3 (forgotLimiter), T5 (password engine for reset step), T10 (templates)
- **Description**:
  - Refactor existing `/forgot-password` and `/reset-password` in `routes/authRoutes.js`:
    1. POST `/api/auth/forgot-password` → use forgotLimiter; save reset_otp 6-digit + reset_otp_expires=10min; dispatch template 'password_reset_otp' with OTP + 1-click token link (optional convenience). Always return 200 generic body (no leak): `{ message:'If this email is registered, a reset OTP has been sent.' }`.
    2. NEW POST `/api/auth/verify-reset-otp` → body { email, otp } → compare otp + expires; valid → issue resetJwt (5min TTL, scope:'reset-password', aud:'reset', no jti session). Return `{ resetJwt }`.
    3. NEW POST `/api/auth/security-question/verify-for-reset` → body { email, answer } → compare security answer hash; valid → same resetJwt returned (FR-C7 step 2 alternative path).
    4. Refactor POST `/api/auth/reset-password` → accepts Bearer resetJwt (preferred) OR legacy body.email+otp (backward compat); run passwordPolicy + passwordHistory rules (T5). On success: clear reset_otp; set users.last_password_change=NOW(); INSERT password_history row; dispatch 'password_changed_confirmation' email. Return 200 `{ message:'Password updated successfully', code:'PASSWORD_CHANGED' }`.
- **Acceptance Criteria Addressed**: AC-2, AC-9
- **Test Requirements**:
  - `rule` TR-12.1: All 3 forgot steps end-to-end: (1) forgot returns 200 regardless of email validity; (2) verify-otp correct → resetJwt issued (jwt.decode shows scope=reset-password); (3) reset with strong password → 200 + password_changed_confirmation email dispatched.
  - `rule` TR-12.2: resetJwt used with POST /users/change-password (wrong route) → rejected; resetJwt expires after 5 min.
  - `rule` TR-12.3: New password == old one → 400 code='PASSWORD_REUSED' (from T5 history enforcement).

## Task 13: Admin + Warehouse forgot password flow (3 new endpoints + admin reset step-up 2FA enforce)
- **Status**: `pending`
- **Priority**: high
- **Depends On**: T1 (admin_users reset cols), T3 (adminStrictLimiter), T5 (password engine), T10 (templates)
- **Description**:
  - Add routes in authRoutes.js:
    - POST `/api/auth/admin/forgot-password` (adminStrictLimiter) → lookup admin_users.email → set reset_otp, expires; dispatch template 'admin_forgot_otp'. Generic 200.
    - POST `/api/auth/admin/verify-reset-otp` → verify otp + expiry; return admin resetJwt (same 5min).
    - POST `/api/auth/admin/reset-password` → Bearer admin resetJwt + newPassword; run policy + admin password_history (role='admin'); update admin_users.password_hash + INSERT password_history row; clear reset_otp.
  - Step-up 2FA enforce: after ANY successful admin login (/admin/login or /warehouse/*), if admin.two_factor_enabled=0 → return 202 `{ requires2FA: true, action: 'setup' }` (do not issue admin JWT). New endpoint POST `/api/auth/admin/2fa/generate-setup` + POST `/api/auth/admin/2fa/verify-and-enable` → only after successful enable → issue admin JWT.
  - Apply same reset 3-step endpoints for warehouse admin (/api/auth/warehouse/forgot-password etc.) using admin_users or warehouse joined users table per existing warehouse pattern.
- **Acceptance Criteria Addressed**: AC-5
- **Test Requirements**:
  - `rule` TR-13.1: Admin without 2FA enabled logs in correctly → 202 requires2FA=setup; no adminToken issued until setup complete + verify-and-enable returns 200.
  - `rule` TR-13.2: Admin forgot 3-step works exactly like customer (T12 rules mirrored) → ends in 200 + password_history row with role='admin'.
  - `rule` TR-13.3: Too many admin forgot requests (11/h) → 429 adminStrictLimiter kicks in.

## Task 14: Resend OTP exponential backoff — otp_attempts table use in all 6 OTP endpoints
- **Status**: `pending`
- **Priority**: medium
- **Depends On**: T1 (otp_attempts table), T11 (Register frontend button disable), T12 (forgot), T13 (admin forgot), T6 (lockout after fails)
- **Description**:
  - Write helper `canSendOtp(scope,email) → { allowed, nextAllowedAt, retryAfterSec }` reading otp_attempts row; write `recordOtpAttempt(scope,email)` that increments attempt_count with `backoff_seconds = CASE WHEN attempt_count=1 THEN 30 WHEN 2 THEN 60 WHEN 3 THEN 180 ELSE 600 END` + `next_allowed_at = NOW() + INTERVAL backoff_seconds SECOND`.
  - Apply helper at top of every resend-capable OTP endpoint: register / 2fa-verify / forgot / admin forgot / challenge / warehouse.
  - Add header `Retry-After: sec` on 429 responses.
- **Acceptance Criteria Addressed**: AC-3
- **Test Requirements**:
  - `rule` TR-14.1: Sequential resends → backoff sequence 30/60/180/600 seconds enforced; Retry-After header present on 429 response.
- **Notes**: Helper file `utils/otpBackoff.js`.

## Task 15: Sessions + device management endpoints (list, revoke single, revoke all other)
- **Status**: `pending`
- **Priority**: high
- **Depends On**: T1 (user_sessions), T4 (authenticateUser jti check), T2 (jtiCache)
- **Description**:
  - New routes in `routes/userRoutes.js` (or authRoutes; place under authenticateUser):
    - GET `/api/users/sessions` → SELECT user_sessions for req.user.id; join (via subquery) current jti from authenticateUser compare to mark is_current. Compute device info from user_agent into OS/browser fields. Return array sorted by last_seen_at DESC.
    - POST `/api/users/sessions/:id/revoke` → UPDATE revoked_at=NOW() WHERE id=:id AND user_id=req.user.id; jtiCache.markRevoked(session.jti); return 200.
    - POST `/api/users/sessions/revoke-others` → UPDATE all sessions for user_id WHERE jti != currentJti → revoked_at=NOW(); mark cache.
    - Same 3 routes for admin `/api/admin/sessions/*` under authenticateAdmin.
  - In `server.js` existing app mount: if sessions routes are in userRoutes, already mounted at /api/users — no new mounts needed.
- **Acceptance Criteria Addressed**: AC-6
- **Test Requirements**:
  - `rule` TR-15.1: GET /users/sessions returns array including current with `is_current:true` badge correctly attached.
  - `rule` TR-15.2: Revoke-others → count of revoked_at rows in user_sessions = (total rows − 1).
  - `rule` TR-15.3: Next request with revoked token → 401 code='SESSION_REVOKED'.

## Task 16: Frontend Login.jsx full rewrite (channels, show/hide, Turnstile after fails, MFA step, device challenge, 3rd-party buttons state)
- **Status**: `pending`
- **Priority**: high
- **Depends On**: T11 pattern reference, T6 (202 from server for 2FA/device-challenge step-ups)
- **Description**:
  - Replace existing Login.jsx with multi-step state machine (`INIT`, `MFA`, `DEVICE_CHALLENGE`, `SOCIAL_WAIT`):
    1. INIT view: Email, Password (EyeToggle component for show/hide), Remember 30d, Forgot link, Submit. Divider "OR" → Continue with Google (if VITE_GOOGLE_CLIENT_ID present) → Send magic link button. Bottom: Create account.
    2. MFA view: 6 digit OTP input (auto advance + backspace nav) → Submit; fallback links "Use backup codes", "Answer security question" → open mini modals.
    3. DEVICE_CHALLENGE view (on 202 requiresDeviceChallenge): 6-digit input + Submit; also "Resend code" disabled 30s; info card showing detected IP, UA string summary.
    4. SOCIAL_WAIT: Magic link sent → large success card "Check your inbox for a sign-in link. You may close this page."; timer 15 min countdown; button "Send a new link" (backoff).
    5. Turnstile widget: Initially hidden. Show after first wrong submit OR after 2+ character password length typed (lazy render with dynamic import).
  - Add AuthContext.login() → if response 202 requires2FA → return state; if 202 device challenge → return; else log in as now.
- **Acceptance Criteria Addressed**: AC-1, AC-8
- **Test Requirements**:
  - `rule` TR-16.1: States flow correctly on matching mock server responses: INIT (pw wrong) → Turnstile appears; INIT correct+2FA enabled → MFA step → 200 → localStorage.token set.
  - `rule` TR-16.2: Click "Forgot password" → React Router navigates to `/forgot-password`.
  - `rubric` TR-16.3: Accessibility; axe scan of Login.jsx passes 0 serious/critical; keyboard-only walkthrough completes login flow. Scale 0-5 threshold >= 4.
- **Notes**: Keep existing palette; do not change earth-tone colors.

## Task 17: New Frontend pages — ForgotPassword.jsx + ResetPassword.jsx + GoogleCallback.jsx + MagicCallback.jsx + Register minor step 1 fields
- **Status**: `pending`
- **Priority**: high
- **Depends On**: T12 (forgot endpoints), T13 (admin forgot endpoints mirror later T19), T8 (google), T9 (magic)
- **Description**:
  - Create `src/pages/ForgotPassword.jsx`: 3-step wizard component with framer-motion. Step 1 email + Turnstile → Step 2 toggle between "Enter OTP code" and "Answer my security question" (OTP default) → Step 3 redirect to `/reset-password?token=resetJwt`.
  - Create `src/pages/ResetPassword.jsx`: reads resetJwt from URL query or localStorage temp key; renders New Password + Confirm with live strength bars + constraint list (✅/❌). Submit → POST /reset-password Bearer resetJwt. On 200 redirect to `/login?reset=success` with banner toast.
  - Create `src/pages/GoogleCallback.jsx`: reads `?token=&status=` from query; if status=success → decode token, write token + user to localStorage, redirect to `/profile`.
  - Create `src/pages/MagicCallback.jsx`: same pattern for magic ?token/JWT.
  - Update Register.jsx security question drop-down (overlap T11 — same file, no conflict) → done as part of T11.
- **Acceptance Criteria Addressed**: AC-2, AC-1
- **Test Requirements**:
  - `rule` TR-17.1: Forgot 3-step wizard progresses through states only when prior step returns 2xx/valid data.
  - `rule` TR-17.2: ResetPassword succeeds → navigate to /login?reset=success; URL token NOT present in browser history after redirect (use replace).
  - `rule` TR-17.3: GoogleCallback with status=error&msg=... shows alert box with reason; localStorage untouched.

## Task 18: Profile Security tab + Sessions UI + 2FA enablement flow UI + security question update
- **Status**: `pending`
- **Priority**: high
- **Depends On**: T15 (sessions endpoints), existing users.generate2FA / verifyAndEnable2FA / disable2FA / updateSecurityQuestion / changePassword already in api.js
- **Description**:
  - Edit `Profile.jsx` (or create Security tab if profile uses tab system):
    1. **Password card** — Change password form (current, new, confirm) with client-side policy constraints, error/success toasts.
    2. **Two-Factor Authentication card** — Status: Enabled/Disabled; enable button → opens 3-step modal: (a) POST generate2FA, render QR code + secret text, (b) Enter 6-digit code, (c) POST verifyAndEnable2FA → show "Backup codes" (note: backup codes not implemented, fallback "Store secret safely" — later out-of-scope). Disable button calls disable2FA.
    3. **Security Question card** — Current question display; edit modal: dropdown 6 questions + answer + confirm answer.
    4. **Sessions card** — Table (or card list) from GET /users/sessions: device emoji (browser), OS string, city-or-IP, Last Seen X ago, "This device" pill, per-row Revoke button (danger red + confirm dialog). Bottom: "Sign out of all other sessions" secondary button.
- **Acceptance Criteria Addressed**: AC-6, AC-8
- **Test Requirements**:
  - `rule` TR-18.1: Revoke-others button press → calls endpoint; list rerenders with is_current row only; other rows removed.
  - `rule` TR-18.2: 2FA enable modal 3 steps → POST verifyAndEnable2FA 200 → status badge Enabled (confirmed by GET /users/profile refreshed includes two_factor_enabled=1).
  - `rule` TR-18.3: Change password success → toast + resets all form inputs; fail due to reuse → error "Cannot reuse last 5 passwords" mapped from T5 code PASSWORD_REUSED.

## Task 19: AdminLogin.jsx + WarehouseAdminLogin.jsx polish + Admin forgot password page + admin route wiring
- **Status**: `pending`
- **Priority**: high
- **Depends On**: T13 (admin forgot endpoints)
- **Description**:
  - Rewrite `AdminLogin.jsx` (dark/cyan sci-fi palette per existing profile): email input with Mail icon, password with Lock + show/hide, Turnstile after 1 fail, "Forgot admin password?" link, brand header with cyan neon BHUMIVERA logo + subtitle. After submit: if server 202 requires2FA=setup → redirect to `/admin/2fa-setup` new page for step-up flow (mirrors T18 modal).
  - Rewrite `WarehouseAdminLogin.jsx` with warehouse-specific theme (slightly different accent: #10B981 green), otherwise same features.
  - Create `src/pages/AdminForgotPassword.jsx` — 2-step (email+otp → new password). Uses admin forgot/verify-reset-otp/reset-password endpoints.
  - Forgot admin link in AdminLogin.jsx → `to="/admin/forgot-password"`.
  - Add App.jsx routes: `/admin/forgot-password` (public), `/admin/2fa-setup` (protected by temp step-up token — can read from localStorage step-up JWT; accessible if admin has valid requires2FA temp token; otherwise redirect to /admin/login).
- **Acceptance Criteria Addressed**: AC-5, AC-8
- **Test Requirements**:
  - `rule` TR-19.1: AdminLogin with correct creds + no 2FA enabled → redirect to /admin/2fa-setup → setup success → /admin/dashboard load OK with valid adminToken.
  - `rule` TR-19.2: AdminForgotPassword step 2 → new password set; login with new password succeeds.
  - `rubric` TR-19.3: Accessibility of AdminLogin + AdminForgot pages per axe + keyboard walkthrough. Scale 0-5 threshold >= 4.

## Task 20: App.jsx route wiring + AuthContext additions + api.js endpoints registered + Vite env example docs updates
- **Status**: `pending`
- **Priority**: high
- **Depends On**: T16, T17, T19 (pages exist before wiring)
- **Description**:
  - Edit `App.jsx`:
    - Import + lazyWithRetry for new pages: ForgotPassword, ResetPassword, GoogleCallback, MagicCallback, AdminForgotPassword, Admin2FASetup.
    - Add routes: `/forgot-password` (public), `/reset-password` (public), `/google-callback` (public), `/magic-callback` (public), `/admin/forgot-password`, `/admin/2fa-setup`.
  - Edit `AuthContext.jsx`:
    - Add action `magicLogin(email)` → POST `/api/auth/magic-link`.
    - Add `googleLogin({ idToken?, code? })` → calls backend google/callback or handles token; or simpler: keep Google flow via 302 redirect so no action needed — document behavior.
    - Add `loginStepContinue(data)` to handle 202 MFA or device challenge responses with current login state machines (T16).
  - Edit `services/api.js` `auth` exports block to add:
    - forgotPassword: d => auth.POST /forgot-password, verifyResetOtp, verifySecQuestionForReset, resetPassword: (resetJwt,d) => auth POST /reset-password Bearer resetJwt, magicLinkRequest, deviceChallengeVerify, adminForgotPassword, adminVerifyResetOtp, adminResetPassword, googleOAuthUrl: () => GET /auth/google/url.
- **Acceptance Criteria Addressed**: AC-1, AC-2, AC-5, AC-10
- **Test Requirements**:
  - `rule` TR-20.1: Running Frontend dev server + visiting /forgot-password, /reset-password, /google-callback, /magic-callback, /admin/forgot-password → each page renders (no React 404), loads correct components with correct palette tones.
  - `rule` TR-20.2: `npx vite build` after changes exits 0.
  - `rule` TR-20.3: api.js auth object contains all 12 new exported functions named in task description (forgotPassword, verifyResetOtp, ..., googleOAuthUrl).

## Task 21: Verification suite (node --check + vite build + curl smoke for each AC)
- **Status**: `pending`
- **Priority**: high
- **Depends On**: ALL tasks 1-20
- **Description**:
  - Run `node --check` on each changed backend file.
  - Run `npx vite build` for frontend with clean node_modules reinstall if needed.
  - Run `GetDiagnostics` lint check.
  - Write (but do NOT commit) a smoke-test script curl log with sequential hit for each AC-1 to AC-6 and AC-9 rule subcases. Record each as pass/fail for implementer self-verification.
  - Capture accessibility axe-core DevTools scan summary for 6 pages (Login, Register, Forgot, Reset, AdminLogin, AdminForgot).
  - Capture 11 email template preview screenshots or inline html snapshots to prove TR-10.1/10.2.
- **Acceptance Criteria Addressed**: All 10 ACs (final aggregated evidence)
- **Test Requirements**:
  - `rule` TR-21.1: Zero syntax errors across backend files. `node --check server.js models/userModel.js models/adminModel.js routes/authRoutes.js routes/userRoutes.js routes/adminUserRoutes.js middleware/*.js utils/*.js` → all exit 0.
  - `rule` TR-21.2: Frontend vite build → exit 0; gzipped bundle size ≤ baseline + 50KB (auth pages not to bloat > 50KB gz on top).
  - `rule` TR-21.3: IDE GetDiagnostics returns empty array.
  - `rubric` TR-21.4: Smoke pass rate — every rule AC-1 to AC-6 and AC-9 self-verified as pass; rubric AC-7/AC-8 scores reported with evidence + rationale; rubric AC-10 fidelity score reported from workflow review. Scale 0-5: anchors 1=<50% pass, 3=70-85%, 5=100% all AC self-verified passing; threshold >= 4.
