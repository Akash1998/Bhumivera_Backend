# Deep Scan Pending Upgrades — Implementation Tasks

Working directories:
- Backend: `c:\Users\akash\OneDrive\Documents\GitHub\Bhumivera_Backend`
- Frontend: `c:\Users\akash\OneDrive\Documents\GitHub\Bhumivera_Frontend`

Dependency order: **Group A tasks first (headers + dead code + dep removal) → Group B tasks next (auth wiring → rate limiters → forgot 3-step)**

---

## Task 1: Permissions-Policy Deprecated Directives Removal + CSP Alignment in server.js

**Maps to AC-A1, AC-A2, AC-U1**
**Priority: high**
**Status: pending**
**Depends On: —**

### Description
Edit [server.js](file:///C:/Users/akash/OneDrive/Documents/GitHub/Bhumivera_Backend/server.js):

**(a) Permissions-Policy (L101-L104 current):**
- Remove `join-ad-interest-group=()` and `run-ad-auction=()`.
- Keep `camera=(), microphone=(), geolocation=(), browsing-topics=()` in any order.

**(b) Content-Security-Policy (L89-L98 current):**
Unify with vercel.json's directive set. Append exactly these missing origins/values to the matching directive:
1. `script-src`: add `https://www.google-analytics.com https://ssl.google-analytics.com https://www.googletagmanager.com`
2. `frame-src`: add `https://*.google.com`
3. `connect-src`: add `https://bhumiverabackend-production.up.railway.app https://analytics.google.com https://*.google-analytics.com https://*.analytics.google.com`
4. `img-src`: add `https://*.google-analytics.com https://*.analytics.google.com`
5. `style-src`: add explicit `style-src 'self' 'unsafe-inline';` after `img-src` (currently missing; fall back to default-src without this may break inline Tailwind style tags or `<style>` blocks in future).

Keep all existing origins in each directive. Merge only, never subtract.

### Test Requirements (TRs)

- **TR-A1.1 (rule AC-A1)**: `node --check server.js` → exit 0.
- **TR-A1.2 (rule AC-A1)**: grep `join-ad-interest-group\|run-ad-auction` server.js → 0 matches.
- **TR-A1.3 (rule AC-A2)**: grep each missing origin in server.js CSP string → each of the 5 bullet items above found as substring.
- **rubric TR-A1.4 (AC-U1)**: Pass threshold ≥ 1. Annotate evidence with manual DevTools observation note if run in browser environment.

### Completion Evidence
_(Filled during Implement.)_

---

## Task 2: Delete Dead Stub Modules bannerRoutes / bannerModel / fitmentRoutes + server.js require cleanup

**Maps to AC-A3**
**Priority: high**
**Status: pending**
**Depends On: Task 1 (parallel-safe — no file overlap)**

### Description
Delete files (if they exist on disk — verified present via deep scan):
1. `routes/bannerRoutes.js`
2. `models/bannerModel.js`
3. `routes/fitmentRoutes.js`

Then in [server.js](file:///C:/Users/akash/OneDrive/Documents/GitHub/Bhumivera_Backend/server.js):
- Search for `bannerRoutes` / `bannerModel` / `fitmentRoutes` / `banner` require / `app.use` lines. (Deep scan found 0 require/mount lines; if any were added since, delete them.)
- Search for `createBannerTable` / `initBanner` call in the initModels block at server.js top-level (currently not present; if present, remove).

Safety: do NOT delete `exceljs` from package.json (used by serialRoutes.js); do NOT delete `pinecone` (used by vectorService).

### Test Requirements

- **TR-A2.1 (rule AC-A3)**: `dir .\routes\bannerRoutes.js` → "File not found"; same for `.\models\bannerModel.js` and `.\routes\fitmentRoutes.js`.
- **TR-A2.2 (rule AC-A3)**: `grep -c bannerRoutes server.js` → 0; same for `fitmentRoutes` / `createBannerTable`.
- **TR-A2.3 (rule NFR-1)**: `node --check server.js` → exit 0 after deletion pass.

### Completion Evidence
_(Filled during Implement.)_

---

## Task 3: Remove Unused Native bcrypt Dependency from package.json

**Maps to AC-A4, NFR-5**
**Priority: medium**
**Status: pending**
**Depends On: Task 2 (parallel-safe)**

### Description
Edit Backend `package.json` line 32 (dependencies object): delete the key/value pair `"bcrypt": "^5.1.1",`. Keep `"bcryptjs": "^3.0.3"` exactly intact.

Then:
1. Verify no source file references `require("bcrypt")` (all 6 callsites already use `bcryptjs` per deep scan).
2. Document a manual post-merge shell command for the user to run in a real terminal that has npm: `cd Bhumivera_Backend && npm uninstall bcrypt` (or `npm.cmd uninstall bcrypt` on Windows PowerShell). This step cleans package-lock.json + node_modules after the package.json edit.

### Test Requirements

- **TR-A3.1 (rule AC-A4)**: `Get-Content package.json | Select-String '"bcrypt"'` → 1 match (bcrypt**js** only; the plain `bcrypt` key with no `-js` suffix is 0 matches).
- **TR-A3.2 (rule AC-A4, NFR-5)**: `grep -r "require(['\"]bcrypt['\"])" .\ --include="*.js" --exclude-dir=node_modules` → every match contains `bcryptjs` substring; 0 matches contain just `"bcrypt"` or `'bcrypt'` alone.
- **TR-A3.3 (rule NFR-1)**: `node --check server.js models/userModel.js models/adminModel.js routes/authRoutes.js routes/userRoutes.js routes/adminUserRoutes.js` → all 6 exit 0.

### Completion Evidence
_(Filled during Implement.)_

---

## Task 4: Wire Password Policy + Password History into userRoutes.change-password

**Maps to AC-B1, NFR-3, NFR-4**
**Priority: high**
**Status: pending**
**Depends On: Tasks 1-3 (parallel-safe; no file overlap)**

### Description
In [userRoutes.js](file:///C:/Users/akash/OneDrive/Documents/GitHub/Bhumivera_Backend/routes/userRoutes.js) — locate `POST /change-password` handler.

Replace the existing minimum-length check with the following ordered policy pipeline:

1. **Read the actual exported names** of `utils/passwordPolicy.js` (`validatePassword`), `utils/hibp.js` (`isPwned`), `models/userModel.js` (last-5 password-history fetch + insert helpers). Use `Object.keys(require(..))` inspection to get exact names; use the real signatures.
2. Pipeline steps:
   - If `!currentPassword || !newPassword` → 400 with `{ code: 'MISSING_FIELDS' }`.
   - Compare `bcrypt.compare(currentPassword, user.password_hash)` from DB → wrong current → 401.
   - Call `passwordPolicy.validatePassword(newPassword)` → if `valid === false` → 400 with first `{ code, message }` of `errors[]` array.
   - Call `await hibp.isPwned(newPassword)` → if `pwned === true && skipped === false` → 400 code=`PWNED_PASSWORD`.
   - Get last-5 hashes via userModel password-history helper for `(userId, role='customer')`; run `bcrypt.compare(newPassword, eachHash)` in loop → any true → 400 code=`PASSWORD_REUSED` message=`Cannot reuse any of your last 5 passwords.`.
3. On success:
   - Hash new password with bcryptjs cost ≥ 12 (use existing salt round constant from file; if already 12, keep).
   - `UPDATE users SET password_hash=?, last_password_change=NOW() WHERE id=?`.
   - `INSERT` new hash into password_history via the helper (user_id, role=customer).
4. Keep existing payload keys exactly: `{currentPassword, newPassword}` (NFR-3 backward compat).
5. Wrap HIBP in try/catch: `isPwned` rejects → log.warn, SKIP (per NFR-4 resilience). Never let a HIBP network error block password set.

### Test Requirements

- **TR-B1.1 (rule AC-B1 subcase a)**: `newPassword='a'` → 400 body.code equals MIN_LENGTH (or equivalent first-error code from passwordPolicy output).
- **TR-B1.2 (rule AC-B1 subcase b)**: `newPassword='Password123!'` → 400 COMMON_PASSWORD or PWNED code (whichever fires first).
- **TR-B1.3 (rule AC-B1 subcase c)**: Same new password as any of last 5 → 400 PASSWORD_REUSED.
- **TR-B1.4 (rule AC-B1 subcase d)**: Strong 16-char new password → 200 AND `SELECT COUNT(*) FROM password_history WHERE user_id=X AND role='customer'` increments by +1.
- **TR-B1.5 (rule NFR-1)**: `node --check routes/userRoutes.js utils/passwordPolicy.js utils/hibp.js models/userModel.js` → exit 0.
- **rubric TR-B1.6 (NFR-4 resilience 0-2)**: Pass threshold ≥ 2. 0/2 = HIBP throws → route returns 500; 1/2 = caught but blocks; 2/2 = caught, logs warn, continues to next check.

### Completion Evidence
_(Filled during Implement.)_

---

## Task 5: Same Password Policy + History Pipeline in authRoutes.reset-password + Accept Bearer resetJwt (backward compat)

**Maps to AC-B2, NFR-3, NFR-4**
**Priority: high**
**Status: pending**
**Depends On: Task 4 (shares passwordPolicy/hibp signatures)**

### Description
In [authRoutes.js](file:///C:/Users/akash/OneDrive/Documents/GitHub/Bhumivera_Backend/routes/authRoutes.js) `POST /reset-password`:

1. **Determine user identity via EITHER path:**
   - **Preferred path (new)**: `Authorization: Bearer <resetJwt>` → `jwt.verify` → check `aud === 'reset' && scope === 'reset-password' && exp not passed` → get `email` from payload.
   - **Backward-compat path (unchanged)**: body `{email, otp, newPassword}` → compare `reset_otp` and `reset_otp_expires` against DB like today.
2. Once user row identified for EITHER path → run the EXACT same 4-step pipeline as Task 4 (policy validate → hibp → last-5 history reject → success insert history hash + update users.password_hash + set last_password_change + clear reset_otp).
3. On success of EITHER path: dispatch a password-changed confirmation notification. Use existing `utils/mail.js` send helper if a `password_changed_confirmation` template ID is registered; otherwise `console.log('[MAIL TEMPLATE: password_changed_confirmation] to:', email)` as dev-mode fallback.
4. Keep old body shape fully working (NFR-3) — do NOT require resetJwt.

### Test Requirements

- **TR-B2.1 (rule AC-B2 subcases a,b,c,d)**: Same 4 subcases as TR-B1.1..TR-B1.4, all exercised via the legacy body path first.
- **TR-B2.2 (rule AC-B5 resetJwt flow)**: Obtain a valid `resetJwt` (from Task 7) → call reset-password with ONLY Bearer token (no email/otp in body) + newPassword → 200 AND password updated AND history row inserted.
- **TR-B2.3 (rule NFR-3 Backward compat)**: Old exact shape `{ email:'x@y', otp:'correct', newPassword:'strong!' }` → 200 identical to pre-upgrade.
- **TR-B2.4 (rule NFR-1)**: `node --check routes/authRoutes.js utils/mail.js models/userModel.js` → exit 0.
- **rubric TR-B2.5 (AC-U2 backward compat 0-2)**: Pass threshold ≥ 2. 2/2 = no pre-existing keyset differences.

### Completion Evidence
_(Filled during Implement.)_

---

## Task 6: Account Lockout + Failed Attempts in POST /auth/login (customer + admin)

**Maps to AC-B3, NFR-4**
**Priority: high**
**Status: pending**
**Depends On: Tasks 4, 5 (parallel-safe; no overlap)**

### Description
In [authRoutes.js](file:///C:/Users/akash/OneDrive/Documents/GitHub/Bhumivera_Backend/routes/authRoutes.js):

For both the customer `/login` branch and the admin `/admin/login` branch:

1. **Pre-compare guard**: look up the user row by email first. If row exists:
   - Call `checkLockout(row.id)` (actual helper name from userModel / adminModel — adapt to exported name). Returns `{locked:bool, lockedUntil:Date|null, secondsRemaining:number}`.
   - If `locked === true` → return `423 { code:'ACCOUNT_LOCKED', message:'Account temporarily locked due to multiple failed attempts. Try again in N minutes or reset your password.', secondsRemaining: res.secondsRemaining }`.
2. **Wrong password**: `recordFailedLogin(row.id)` → updates `failed_attempts` + at threshold sets `locked_until`. If just-transitioned to locked (post-increment failed_attempts === 6): dispatch ACCOUNT_LOCKED alert mail via existing `utils/mail.js` wrapper; fallback dev console log if template not registered.
3. **Correct password**: `resetFailedAttempts(row.id)` → `failed_attempts=0`, `locked_until=NULL`, then issue JWT as today.

Admin branch uses `admin_users` table columns `failed_attempts` / `locked_until` (added per production-stability-hardening Task 1 already in adminModel syncColumns — confirmed at spec time; verify once by inspecting adminModel syncColumns block).

### Test Requirements

- **TR-B3.1 (rule AC-B3)**: Simulate 6 consecutive wrong passwords in `/auth/login`; 7th submission → HTTP 423, body contains `code === 'ACCOUNT_LOCKED'` and `secondsRemaining > 0`.
- **TR-B3.2 (rule AC-B3)**: `SELECT locked_until FROM users WHERE email=?` → non-null datetime value.
- **TR-B3.3 (rule AC-B3)**: Simulate unlock (either wait simulated by DB UPDATE to clear) → correct password → HTTP 200 + token issued.
- **TR-B3.4 (rule AC-B3 admin mirror)**: Admin `/auth/admin/login` same 3 sub-observations above for an admin test user.
- **TR-B3.5 (rule NFR-1)**: `node --check routes/authRoutes.js models/userModel.js models/adminModel.js` → exit 0.

### Completion Evidence
_(Filled during Implement.)_

---

## Task 7: 5 New Rate Limiters + Apply to authRoutes Endpoints

**Maps to AC-B4**
**Priority: high**
**Status: pending**
**Depends On: Task 1 (parallel-safe; no file overlap)**

### Description
In [rateLimiter.js](file:///C:/Users/akash/OneDrive/Documents/GitHub/Bhumivera_Backend/middleware/rateLimiter.js):

Keep existing `registerLimiter / loginLimiter / otpLimiter`. Add 5 new `rateLimit` instances using `express-rate-limit` (already a dep):

1. **forgotLimiter**: `windowMs = 10 * 60 * 1000` (10 min), `max = 10` per IP. Key generator: `(req) => req.body?.email || req.ip`. Standard headers `standardHeaders:true`, `legacyHeaders:false`. Response body `429 { code:'TOO_MANY_RESET_REQUESTS', message:'Too many reset requests. Try again later.' }`.
2. **magicLinkLimiter**: `windowMs = 10*60*1000`, `max=5` per email (keygen = body.email || req.ip). Response code `'TOO_MANY_MAGIC_LINKS'`.
3. **googleCallbackLimiter**: `windowMs = 60*1000`, `max=20` per IP. Code `'GOOGLE_CALLBACK_RATE'`.
4. **adminStrictLimiter**: `windowMs = 60*60*1000` (1h), `max=10` per IP. Code `'ADMIN_AUTH_RATE'`.
5. **challengeLimiter**: `windowMs = 10*60*1000`, `max=10` per user (jti or req.user fallback to ip). Code `'CHALLENGE_RATE'`.

Re-export all 5 alongside the existing 3 in the `module.exports` block.

Then in [authRoutes.js](file:///C:/Users/akash/OneDrive/Documents/GitHub/Bhumivera_Backend/routes/authRoutes.js):
- Apply `forgotLimiter` to `POST /forgot-password` (currently uses `otpLimiter` — swap it).
- Apply `adminStrictLimiter` to ALL `/auth/admin/*` mounted routes (`router.use('/admin', adminStrictLimiter)` router-level).
- Apply `magicLinkLimiter`, `googleCallbackLimiter`, `challengeLimiter` as `router.use('/magic-link', magicLinkLimiter)` etc. — these are safe no-ops in this phase because the handlers don't exist yet; they just prepare mount-points for Phase 2 wiring.

### Test Requirements

- **TR-B4.1 (rule AC-B4)**: `node --check middleware/rateLimiter.js` → exit 0.
- **TR-B4.2 (rule AC-B4)**: `Object.keys(require('./middleware/rateLimiter')).length === 8` (3 old + 5 new).
- **TR-B4.3 (rule AC-B4)**: grep `POST.*forgot-password` authRoutes.js → handler line uses `forgotLimiter` not `otpLimiter`.
- **TR-B4.4 (rule AC-B4)**: grep `router.use.*admin` → line includes `adminStrictLimiter`.
- **rubric TR-B4.5 (Scalability 0-2)**: Pass threshold ≥ 1. 2/2 = all 5 limiters exported + correctly mounted at router-level where appropriate.

### Completion Evidence
_(Filled during Implement.)_

---

## Task 8: Forgot 3-Step Endpoints (verify-reset-otp + security-question alt + admin mirror trio)

**Maps to AC-B5, AC-B2, NFR-3**
**Priority: high**
**Status: pending**
**Depends On: Tasks 5, 7 (depends on reset-password logic refactor from T5)**

### Description
In [authRoutes.js](file:///C:/Users/akash/OneDrive/Documents/GitHub/Bhumivera_Backend/routes/authRoutes.js):

Add 5 new routes:

**Customer side (2 new verify + 1 already exist /forgot and /reset already modified in T5):**
1. **`POST /auth/verify-reset-otp`** body `{email, otp}` → look up user by email → compare otp vs `reset_otp` AND `reset_otp_expires > NOW()` → valid: sign resetJwt `{ sub: userId, email, aud:'reset', scope:'reset-password' }` expiresIn `'5m'` → return `{ resetJwt }`. Invalid: generic 400 (no email-enum leak — same message whether wrong OTP or unknown email).
2. **`POST /auth/security-question/verify-for-reset`** body `{email, answer}` → look up user → `bcrypt.compare(answer, user.security_answer_hash)` → if match → issue same resetJwt as (1).

**Admin side (3 new routes, all use `adminStrictLimiter` from Task 7):**
3. **`POST /auth/admin/forgot-password`** body `{email}` → look up in `admin_users` → set `reset_otp + reset_otp_expires=10min` → dispatch admin_forgot_otp mail (dev fallback log if no template) → always return generic 200.
4. **`POST /auth/admin/verify-reset-otp`** body `{email, otp}` → compare in admin_users → issue admin resetJwt (role='admin' in payload).
5. **`POST /auth/admin/reset-password`** Bearer admin resetJwt → same policy+history pipeline as Task 5 but against `admin_users` table and `password_history` role=`'admin'`.

Note: Admin users `reset_otp`/`reset_otp_expires` columns are expected to exist per production-stability-hardening Task 1 (adminModel.js syncColumns). If missing during code inspection, add an addCol guard to adminModel.js per existing idempotent pattern.

### Test Requirements

- **TR-B5.1 (rule AC-B5)**: grep `router.post` in authRoutes.js → all 5 route strings present in output: verify-reset-otp, security-question/verify-for-reset, admin/forgot-password, admin/verify-reset-otp, admin/reset-password.
- **TR-B5.2 (rule AC-B5 resetJwt aud)**: `jwt.decode(resetJwt).aud === 'reset'` for a successfully-issued customer resetJwt.
- **TR-B5.3 (rule NFR-3 Backward compat)**: Pre-existing `POST /forgot-password` with same old body → 200 identical to pre-upgrade; no new required fields.
- **TR-B5.4 (rule AC-B2 Bearer path now fully working end-to-end)**: Flow: admin forgot → OTP via console log → verify-reset-otp → resetJwt → admin reset-password Bearer → 200 + password_history role=admin row inserted.
- **TR-B5.5 (rule NFR-1)**: `node --check routes/authRoutes.js middleware/rateLimiter.js models/adminModel.js` → exit 0.
- **rubric TR-B5.6 (AC-U2 backward compat 0-2)**: Pass threshold ≥ 2.

### Completion Evidence
_(Filled during Implement.)_

---

## Task 9: Final Verification — Syntax, Curl Smoke, Grep Evidence

**Priority: high**
**Status: pending**
**Depends On: Tasks 1-8 ALL completed**

### Description
Consolidate evidence for every rule + rubric AC. Run every `rule` TR curl/grep/verify step above and capture pass/fail + snippet/exit code. Run `GetDiagnostics` (already 0 pre-upgrade; confirm post-upgrade).

### Test Requirements

- **TR-V9.1 (rule NFR-1 aggregate)**: `node --check server.js routes/*Route*.js models/*Model*.js middleware/*.js utils/*.js` → exit 0.
- **TR-V9.2 (rule A1-A4 + B1-B5 aggregate)**: Every `rule` TR in Tasks 1-8 executed and recorded in this task's completion section with pass status.
- **TR-V9.3 (rule lint)**: IDE `GetDiagnostics` → returns empty array (0 diagnostics).
- **rubric TR-V9.4 (Coverage 0-2)**: Pass threshold ≥ 2. 2/2 = every rule AC in spec has a matching TR executed and recorded with evidence.
- **rubric TR-V9.5 (AC-U2 backward compat fidelity 0-2)**: Pass threshold ≥ 2. Compare pre-upgrade vs post-upgrade keysets for 5 touched routes (change-password, reset-password, login, forgot-password, admin/login).

### Completion Evidence
_(Filled during Implement: every rule TR pass/fail, every rubric score + rationale.)_
