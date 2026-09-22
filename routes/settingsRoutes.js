// backend/routes/settingsRoutes
const express = require('express');
const router = express.Router();
const { authenticateAdmin } = require('../middleware/authMiddleware');
const { getAllSettings, getSettingsByGroup, getSetting, updateSetting, bulkUpdateSettings } = require('../models/settingsModel');

// GET /api/settings/public - public: get non-sensitive settings (store info, SEO, social)
router.get('/public', async (req, res) => {
  try {
    const groups = ['general', 'seo', 'social', 'policy'];
    const result = {};
    for (const g of groups) {
      const data = await getSettingsByGroup(g);
      // Remove sensitive keys
      delete data.smtp_pass;
      Object.assign(result, data);
    }
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to get settings' });
  }
});

// GET /api/settings - admin: get all settings grouped
router.get('/', authenticateAdmin, async (req, res) => {
  try {
    const { rows } = await getAllSettings();
    // Group by group_name
    const grouped = {};
    rows.forEach(r => {
      if (!grouped[r.group_name]) grouped[r.group_name] = {};
      grouped[r.group_name][r.key_name] = r.value;
    });
    res.json(grouped);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to get settings' });
  }
});

// GET /api/settings/:group - admin: get settings by group
router.get('/:group', authenticateAdmin, async (req, res) => {
  try {
    const data = await getSettingsByGroup(req.params.group);
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to get settings' });
  }
});

// PUT /api/settings - admin: bulk update settings
router.put('/', authenticateAdmin, async (req, res) => {
  try {
    const data = req.body;
    if (!data || typeof data !== 'object') return res.status(400).json({ message: 'Body must be key-value object' });
    await bulkUpdateSettings(data);
    res.json({ message: 'Settings updated successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to update settings' });
  }
});

// PUT /api/settings/:key - admin: update single setting
router.put('/:key', authenticateAdmin, async (req, res) => {
  try {
    const { value } = req.body;
    await updateSetting(req.params.key, value);
    res.json({ message: 'Setting updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to update setting' });
  }
});

module.exports = router;
