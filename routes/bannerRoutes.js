// backend/routes/bannerRoutes.js
const express = require('express');
const router = express.Router();
const { authenticateAdmin } = require('../middleware/authMiddleware');
const { createBanner, getActiveBanners, getAllBanners, updateBanner, deleteBanner } = require('../models/bannerModel');

// GET /api/banners - public: get active banners (optional ?position=hero)
router.get('/', async (req, res) => {
  try {
    const banners = await getActiveBanners(req.query.position || null);
    res.json(banners);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to get banners' });
  }
});

// GET /api/banners/admin/all - admin: all banners
router.get('/admin/all', authenticateAdmin, async (req, res) => {
  try {
    const banners = await getAllBanners();
    res.json(banners);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to get banners' });
  }
});

// POST /api/banners - admin: create banner
router.post('/', authenticateAdmin, async (req, res) => {
  try {
    const { image_url } = req.body;
    if (!image_url) return res.status(400).json({ message: 'image_url is required' });
    const id = await createBanner(req.body);
    res.status(201).json({ message: 'Banner created', id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to create banner' });
  }
});

// PUT /api/banners/:id - admin: update banner
router.put('/:id', authenticateAdmin, async (req, res) => {
  try {
    await updateBanner(req.params.id, req.body);
    res.json({ message: 'Banner updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to update banner' });
  }
});

// DELETE /api/banners/:id - admin: delete banner
router.delete('/:id', authenticateAdmin, async (req, res) => {
  try {
    await deleteBanner(req.params.id);
    res.json({ message: 'Banner deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to delete banner' });
  }
});

module.exports = router;
