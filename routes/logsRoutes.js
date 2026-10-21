const express = require('express');
const router = express.Router();
const { authenticateAdmin } = require('../middleware/authMiddleware');
const { getClientErrors } = require('../models/clientErrorModel');
const { createError, sendError } = require('../utils/errorReporting');

router.get('/client', authenticateAdmin, async (req, res) => {
  try {
    const errors = await getClientErrors(req.query.limit);
    res.json({ data: errors });
  } catch (error) {
    console.error('[CLIENT_LOG_READ]', error);
    sendError(res, createError(500, 'CLIENT_LOG_READ_FAILED', 'Failed to load client error reports.'));
  }
});

module.exports = router;