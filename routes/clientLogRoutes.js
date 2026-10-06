const express = require('express');
const router = express.Router();
const { clientErrorLimiter } = require('../middleware/rateLimiter');
const { createClientError } = require('../models/clientErrorModel');
const { createError, sendError } = require('../utils/errorReporting');

const text = (value, maxLength) => typeof value === 'string' ? value.trim().slice(0, maxLength) || null : null;
const numberOrNull = value => value === null || value === undefined || value === ''
  ? null
  : Number.isInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;

router.post('/', clientErrorLimiter, async (req, res) => {
  const message = text(req.body?.message, 2000);
  if (!message) return sendError(res, createError(400, 'CLIENT_LOG_MESSAGE_REQUIRED', 'An error message is required.'));

  try {
    const id = await createClientError({
      message,
      source: text(req.body?.source, 500),
      lineNumber: numberOrNull(req.body?.lineNumber),
      columnNumber: numberOrNull(req.body?.columnNumber),
      pageUrl: text(req.body?.pageUrl, 1000),
      stack: text(req.body?.stack, 8000),
      userAgent: text(req.get('user-agent'), 500),
    });
    res.status(202).json({ accepted: true, id });
  } catch (error) {
    console.error('[CLIENT_LOG_WRITE]', error);
    sendError(res, createError(503, 'CLIENT_LOG_UNAVAILABLE', 'Client error reporting is temporarily unavailable.', 'Try again later.'));
  }
});

module.exports = router;