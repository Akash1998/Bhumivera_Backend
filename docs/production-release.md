# Production release checks

## Backend environment

Set `NODE_ENV=production` and provide:

- `JWT_SECRET`: a random value with at least 32 characters. `OTP_SECRET` is recommended as a separate random value with at least 32 characters; if omitted, OTP HMAC uses a stable HKDF-derived key from `JWT_SECRET`.
- `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, and `DB_PORT`.
- `DB_SSL=true`; provide `DB_SSL_CA` only when the database provider uses a private CA.
- `FRONTEND_ORIGINS`: recommended comma-separated exact HTTPS origins for the deployed frontend (no paths, wildcards, or preview domains). If omitted, the API allows only `https://www.bhumivera.com` and `https://bhumivera.com`.

If the corresponding feature is enabled, configure both Razorpay API credentials. To receive Razorpay events, configure `RAZORPAY_WEBHOOK_SECRET` and point the provider to `POST /api/webhooks/razorpay`, subscribing at least to `payment.captured` and `payment.failed`. Use the webhook secret from the provider dashboard, which is separate from the API key secret.

For more than one backend instance, set the same `RATE_LIMIT_REDIS_URL` on every instance. A single instance can use the built-in in-memory rate-limit store.

The backend runs schema migrations before declaring readiness. Migration 33 adds the nullable customer association to warranty registrations; warranty ownership is saved in the registration transaction, and serial rows are locked to prevent duplicate registrations. Configure the deployment platform to use `/health/live` for liveness and `/health/ready` for readiness. A migration failure leaves the service unready and is retried; inspect the server logs for the failing migration before changing production data.

Customer cancellation is limited to pending or confirmed orders and rechecks that state while holding the order row lock, so a concurrent fulfillment update cannot be overwritten by a stale cancellation request. An already-paid online order returns `409 REFUND_REQUIRED`; the application does not issue provider refunds, so process the refund through the payment provider and customer-support workflow rather than marking the order cancelled first.

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
