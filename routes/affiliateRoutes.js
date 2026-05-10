// backend-Bhumivera/routes/affiliateRoutes.js
const express = require('express');
const router = express.Router();

// Mock endpoints to satisfy the frontend's API calls and stop the 404s
router.get('/partners', (req, res) => {
    res.json({ partners: [] });
});

router.get('/withdrawals', (req, res) => {
    res.json({ withdrawals: [] });
});

router.get('/config', (req, res) => {
    res.json({ config: { commission_percent: 10, min_payout: 500 } });
});

router.put('/config', (req, res) => {
    res.json({ success: true, message: "Config updated" });
});

router.put('/partners/:id/status', (req, res) => {
    res.json({ success: true, message: "Status updated" });
});

router.post('/withdrawals/:id/approve', (req, res) => {
    res.json({ success: true, message: "Withdrawal approved" });
});

module.exports = router;
