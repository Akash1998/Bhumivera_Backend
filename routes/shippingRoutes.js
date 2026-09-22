// backend/routes/shippingRoutes

const express = require('express');
const router = express.Router();
const { authenticateAdmin } = require('../middleware/authMiddleware');
const { getAllZones, getActiveZones, getZoneById, createZone, updateZone, deleteZone, calculateShipping } = require('../models/shippingModel');

// GET /api/shipping/zones/active - public: get active shipping zones
router.get('/zones/active', async (req, res) => {
  try {
    const zones = await getActiveZones();
    res.json(zones);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to get shipping zones' });
  }
});

// POST /api/shipping/calculate - public: calculate shipping for order
router.post('/calculate', async (req, res) => {
  try {
    const { orderTotal, zoneId } = req.body;
    const result = await calculateShipping(parseFloat(orderTotal) || 0, zoneId || 1);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to calculate shipping' });
  }
});

// GET /api/shipping/zones - admin: all zones
router.get('/zones', authenticateAdmin, async (req, res) => {
  try {
    const zones = await getAllZones();
    res.json(zones);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to get zones' });
  }
});

// POST /api/shipping/zones - admin: create zone
router.post('/zones', authenticateAdmin, async (req, res) => {
  try {
    const { name, regions, base_charge } = req.body;
    if (!name || !regions || base_charge === undefined) return res.status(400).json({ message: 'name, regions, base_charge required' });
    const id = await createZone(req.body);
    res.status(201).json({ message: 'Shipping zone created', id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to create zone' });
  }
});

// PUT /api/shipping/zones/:id - admin: update zone
router.put('/zones/:id', authenticateAdmin, async (req, res) => {
  try {
    await updateZone(req.params.id, req.body);
    res.json({ message: 'Shipping zone updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to update zone' });
  }
});

// DELETE /api/shipping/zones/:id - admin: delete zone
router.delete('/zones/:id', authenticateAdmin, async (req, res) => {
  try {
    await deleteZone(req.params.id);
    res.json({ message: 'Shipping zone deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to delete zone' });
  }
});

module.exports = router;
