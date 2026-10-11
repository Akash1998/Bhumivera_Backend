const express = require('express');
const { authenticateAdmin } = require('../middleware/authMiddleware');

const router = express.Router();
router.use(authenticateAdmin);

const unavailable = (_req, res) => res.status(501).json({
  code: 'AFFILIATE_WORKFLOW_UNAVAILABLE',
  message: 'Affiliate management is unavailable until partner, commission, and payout workflows are persisted and audited.',
});

router.get('/partners', unavailable);
router.get('/withdrawals', unavailable);
router.get('/config', unavailable);
router.put('/config', unavailable);
router.route('/partners/:id/status').put(unavailable).patch(unavailable);
router.route('/withdrawals/:id/approve').post(unavailable).patch(unavailable);

module.exports = router;
