const express = require('express');
const rateLimit = require('express-rate-limit');
const { authenticateAdmin, authenticateUser, optionalAuth } = require('../middleware/authMiddleware');
const welcomeGifts = require('../models/welcomeGiftModel');

const router = express.Router();

const claimLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many gift claim attempts. Please try again later.' },
});

const sendError = (res, error, fallback) => {
  if (error.status) {
    return res.status(error.status).json({ success: false, code: error.code, message: error.message });
  }
  console.error('[WELCOME_GIFT]', error);
  return res.status(500).json({ success: false, message: fallback });
};

router.get('/status/:code', optionalAuth, async (req, res) => {
  try {
    const status = await welcomeGifts.getCardStatus(req.params.code, req.user?.id || null);
    res.json({ success: true, ...status });
  } catch (error) {
    sendError(res, error, 'Could not check this welcome card right now.');
  }
});

router.post('/claim', claimLimiter, authenticateUser, async (req, res) => {
  try {
    const result = await welcomeGifts.claimCard(req.body?.code, req.user.id);
    res.status(result.alreadyClaimed ? 200 : 201).json({
      success: true,
      ...result,
      message: result.alreadyClaimed
        ? 'You have already claimed this gift. Use your coupon code at checkout.'
        : 'Gift claimed! Your coupon is ready to use at checkout.',
    });
  } catch (error) {
    sendError(res, error, 'Could not claim this welcome card right now.');
  }
});

router.get('/admin/campaigns', authenticateAdmin, async (req, res) => {
  try {
    res.json({ success: true, campaigns: await welcomeGifts.listCampaigns() });
  } catch (error) {
    sendError(res, error, 'Could not load welcome card campaigns.');
  }
});

router.post('/admin/campaigns', authenticateAdmin, async (req, res) => {
  try {
    const campaign = await welcomeGifts.createCampaign(req.body || {});
    res.status(201).json({ success: true, campaign });
  } catch (error) {
    sendError(res, error, 'Could not create welcome cards.');
  }
});

router.get('/admin/campaigns/:id', authenticateAdmin, async (req, res) => {
  try {
    const campaign = await welcomeGifts.getCampaign(req.params.id);
    if (!campaign) return res.status(404).json({ success: false, message: 'Campaign not found.' });
    res.json({ success: true, campaign });
  } catch (error) {
    sendError(res, error, 'Could not load this campaign.');
  }
});

router.patch('/admin/campaigns/:id', authenticateAdmin, async (req, res) => {
  try {
    const campaign = await welcomeGifts.updateCampaignTerms(req.params.id, req.body || {});
    res.json({ success: true, campaign });
  } catch (error) {
    sendError(res, error, 'Could not update this campaign.');
  }
});

router.post('/admin/cards/:id/void', authenticateAdmin, async (req, res) => {
  try {
    res.json({ success: true, card: await welcomeGifts.voidCard(req.params.id) });
  } catch (error) {
    sendError(res, error, 'Could not void this card.');
  }
});

module.exports = router;
