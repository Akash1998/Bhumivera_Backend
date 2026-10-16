# Production release checks

## Backend environment

Set `NODE_ENV=production` and provide:

- `JWT_SECRET`: a random value with at least 32 characters. `OTP_SECRET` is recommended as a separate random value with at least 32 characters; if omitted, OTP HMAC uses a stable HKDF-derived key from `JWT_SECRET`.
- `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, and `DB_PORT`.
- `DB_SSL=true`; provide `DB_SSL_CA` only when the database provider uses a private CA.
- `FRONTEND_ORIGINS`: recommended comma-separated exact HTTPS origins for the deployed frontend (no paths, wildcards, or preview domains). If omitted, the API allows only `https://www.bhumivera.com` and `https://bhumivera.com`.

If the corresponding feature is enabled, configure both Razorpay API credentials. To receive Razorpay events, configure `RAZORPAY_WEBHOOK_SECRET` and point the provider to `POST /api/webhooks/razorpay`, subscribing to `payment.captured`, `payment.failed`, `refund.created`, `refund.processed`, and `refund.failed`. Use the webhook secret from the provider dashboard, which is separate from the API key secret.

Telegram customer support registers its incoming webhook automatically at startup. Set `API_BASE_URL` to the same public HTTPS backend origin used by the frontend (or set `SUPPORT_TELEGRAM_INCOMING_WEBHOOK_URL` to the full webhook URL); this avoids routing Telegram updates to a different deployment or database. Telegram webhook requests are authenticated using `SUPPORT_TELEGRAM_WEBHOOK_SECRET` or a key derived from the bot token. `SUPPORT_TELEGRAM_WEBHOOK_URL` remains the separate outgoing escalation notification URL.

For more than one backend instance, set the same `REDIS_URL` or `RATE_LIMIT_REDIS_URL` on every instance to share rate-limit counters. A single instance can use the built-in in-memory rate-limit store.

Set `REDIS_URL` or `CACHE_REDIS_URL` on each backend instance to enable Redis response caching. The cache is restricted to public product, category, subcategory and active flash-sale GET endpoints; authenticated/cookie requests, explicitly private or no-store responses, and search/referral-preview endpoints are not cached. Entries expire after 60 seconds, and responses larger than 128 KiB are skipped. Redis cache connection or request failures do not prevent API requests from continuing. The cache reduces repeated eligible MySQL reads but does not replace persistent MySQL data or configure Railway's MySQL RAM limit.

The MySQL client pool defaults to at most 3 connections, 1 idle connection and 100 queued operations (`DB_POOL_SIZE` can override the connection cap). This limits per-connection server overhead while bounding application-side queue growth. Check the Railway MySQL service Metrics tab for actual database RAM; the admin health page reports application pool limits, not Railway's server memory allocation.

### Production system logs

The admin System Logs page stores backend HTTP 5xx and database failures in MySQL for 30 days, and fetches Railway and Vercel records while the provider view is open. To enable Railway HTTP request logs, configure `RAILWAY_PROJECT_ACCESS_TOKEN` (or `RAILWAY_API_TOKEN` / `RAILWAY_TOKEN`) and `RAILWAY_DEPLOYMENT_ID` on the backend service. To enable Vercel runtime and deployment/build logs, configure `VERCEL_TOKEN` (or `VERCEL_API_TOKEN`) and `VERCEL_PROJECT_ID`; `VERCEL_DEPLOYMENT_ID` is optional and selects a specific deployment instead of the latest production deployment. Set `VERCEL_TEAM_ID` for team-scoped projects. These tokens must be available to the backend service (setting a variable only in Vercel does not make it available to Railway). Provider credentials are never returned by the admin API. Railway HTTP access logs do not necessarily include application stack traces. Vercel runtime logs are scoped to one deployment and capped at 200 records returned by the provider; configure a provider log drain for comprehensive historical/continuous retention.

### Promotional email campaigns

Administrators can send an offer or coupon announcement from Admin > Customers > Email opted-in customers. The audience is limited to active customer accounts with `marketing_email_opt_in = 1`; recipients are counted before composing and consent is checked again when the message is sent. The existing Mailrelay integration (`MAILRELAY_API_KEY`, `MAILRELAY_DOMAIN`, and `EMAIL_FROM`) delivers the campaign. Do not send promotional email to customers who have not opted in or have opted out.

The backend runs schema migrations before declaring readiness. Migration 33 adds the nullable customer association to warranty registrations; warranty ownership is saved in the registration transaction, and serial rows are locked to prevent duplicate registrations. Configure the deployment platform to use `/health/live` for liveness and `/health/ready` for readiness. A migration failure leaves the service unready and is retried; inspect the server logs for the failing migration before changing production data.

Checkout shows Razorpay first, Wallet second, and COD third. COD remains visible with an explanation, but is selectable only after two of the customer's orders have been recorded as delivered (`delivered_at` set); the order transaction rechecks this rule on the server. Wallet checkout debits the wallet and records its ledger transaction atomically with order creation. Razorpay remains the recommended payment option.

The Orders admin page can compare up to 25 online payments on the visible page with Razorpay. This is a read-only diagnostic: discrepancies and provider lookup failures are reported but never auto-corrected. Normal online checkout captures the payment before creating the order; pending orders also include legitimate COD orders, so do not automatically expire pending orders or release their stock without an approved fulfillment policy.

Customer cancellation is limited to pending or confirmed orders and rechecks that state while holding the order row lock, so a concurrent fulfillment update cannot be overwritten by a stale cancellation request. An already-paid online order returns `409 REFUND_REQUIRED`; process refunds through the return workflow instead of marking a paid order cancelled first.

Refund requests are available only for a received return tied to a captured online Razorpay payment. Migration 35 creates the provider-refund request ledger. An administrator must explicitly enter the amount; the backend validates that payment details match the order, checks Razorpay refund history, reserves the amount transactionally against other refunds, and submits a normal-speed provider refund with a unique internal receipt. Refund requests in progress block repeat attempts. The return is not marked refunded until the signed `refund.processed` webhook arrives. Configure all three refund webhook events above. If a provider request times out or returns an ambiguous conflict, use the admin "Refresh refund status" action (which checks Razorpay history by exact receipt) before any retry; never resubmit an unknown result blindly. Use Razorpay test credentials and test payments before enabling production refunds.

Affiliate administration currently returns `501 AFFILIATE_WORKFLOW_UNAVAILABLE`; partner, commission, and payout actions are not persisted and must not be treated as successful. Dashboard order-value metrics sum stored totals for orders not marked cancelled; they are not reconciled net sales, settled cash, tax collected, or profit.

The A/B Experiment page is informationally disabled: the settings registry stores labels only and does not assign customer variants or record impressions, conversions, or statistical results. Do not use it to make product or marketing decisions.

Category create, update, and delete operations are recorded in `category_audit_log` in the same database transaction as the taxonomy change. The log stores the acting administrator, action, category ID, and before/after category snapshots. Migration 34 creates the table. The admin panel loads the latest 30 records; the endpoint allows limits from 1 to 100. The audit table currently has no retention or export workflow, so define those policies before the log grows substantially.

The admin Support inbox brings persisted contact tickets and return requests into one searchable queue. Replies and customer conversations use the support-ticket workflow; return approvals, replacements, and provider refunds remain in the dedicated Returns workspace so those actions keep their specific authorization and payment safeguards.

For better key-compromise isolation, generate an independent `OTP_SECRET` locally with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` and save it directly as a Railway service variable. Never commit or send the generated value in chat. The service remains operational without it by deriving a stable, OTP-specific key from the required strong `JWT_SECRET`.

## Frontend environment

Set `VITE_BASE_URL` to the backend origin, without the `/api` suffix. If the frontend uses a separately configured Razorpay checkout key, make sure it matches the backend key ID.

## Release smoke test

After deploying both applications, run this from the backend repository:

```powershell
$env:API_BASE_URL = "https://your-backend.example"
$env:FRONTEND_URL = "https://your-store.example"
npm.cmd run smoke
```

The smoke test checks backend liveness, readiness, the root API route, and (when configured) frontend delivery. It does not place orders or make provider charges. Run payment, fulfillment, and refund tests using provider test mode and dedicated test records before enabling live transactions.
