const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET_KEY || process.env.CLOUDFLARE_TURNSTILE_SECRET_KEY;

async function verifyTurnstileToken(token) {
  if (!TURNSTILE_SECRET || !token) {
    return { success: true, skipped: true };
  }

  const params = new URLSearchParams({
    secret: TURNSTILE_SECRET,
    response: token,
  });

  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!response.ok) {
    throw new Error(`Turnstile verification failed with status ${response.status}`);
  }

  const result = await response.json();
  return { success: Boolean(result?.success), skipped: false, result };
}

const turnstileMiddleware = async (req, res, next) => {
  const token = req.body?.cfTurnstileResponse || req.body?.turnstileToken || req.headers['x-turnstile-token'];

  if (!TURNSTILE_SECRET) {
    return next();
  }

  if (!token) {
    return res.status(400).json({ message: 'Security verification is required. Please complete the challenge and try again.' });
  }

  try {
    const verification = await verifyTurnstileToken(token);
    if (!verification.success) {
      return res.status(403).json({ message: 'Security verification failed. Please refresh and try again.' });
    }
    return next();
  } catch (error) {
    console.error('[TURNSTILE_MIDDLEWARE_ERROR]', error.message);
    return res.status(500).json({ message: 'Security verification could not be completed. Please try again.' });
  }
};

module.exports = { turnstileMiddleware, verifyTurnstileToken };
