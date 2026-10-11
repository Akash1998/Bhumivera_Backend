# Production release checks

## Backend environment

Set `NODE_ENV=production` and provide:

- `JWT_SECRET` and `OTP_SECRET`: separate, random values with at least 32 characters.
- `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, and `DB_PORT`.
- `DB_SSL=true`; provide `DB_SSL_CA` only when the database provider uses a private CA.
- `FRONTEND_ORIGINS`: comma-separated exact HTTPS origins for the deployed frontend (no paths, wildcards, or preview domains).

If the corresponding feature is enabled, configure both Razorpay API credentials. To receive Razorpay events, configure `RAZORPAY_WEBHOOK_SECRET` and point the provider to `POST /api/webhooks/razorpay`, subscribing at least to `payment.captured` and `payment.failed`. Use the webhook secret from the provider dashboard, which is separate from the API key secret.

For more than one backend instance, set the same `RATE_LIMIT_REDIS_URL` on every instance. A single instance can use the built-in in-memory rate-limit store.

The backend runs schema migrations before declaring readiness. Configure the deployment platform to use `/health/live` for liveness and `/health/ready` for readiness. A migration failure leaves the service unready and is retried; inspect the server logs for the failing migration before changing production data.

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
