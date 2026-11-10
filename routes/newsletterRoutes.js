const express = require('express');
const router = express.Router();
const { newsletterLimiter } = require('../middleware/rateLimiter');
const { subscribeNewsletter } = require('../models/newsletterModel');

router.post('/subscribe', newsletterLimiter, async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ code: 'INVALID_EMAIL', message: 'Enter a valid email address.', userAction: 'Check the email and try again.' });
  }
  try {
    await subscribeNewsletter(email, String(req.body?.source || 'site').slice(0, 80));
    res.status(202).json({ accepted: true, message: 'You are subscribed.' });
  } catch (error) {
    console.error('[NEWSLETTER_SUBSCRIBE]', error);
    res.status(503).json({ code: 'NEWSLETTER_UNAVAILABLE', message: 'Subscription is temporarily unavailable.', userAction: 'Try again later.' });
  }
});

module.exports = router;
