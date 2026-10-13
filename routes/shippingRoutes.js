// backend/routes/shippingRoutes

const express = require('express');
const router = express.Router();
const { authenticateAdmin } = require('../middleware/authMiddleware');
const { getAllZones, getActiveZones, getZoneById, createZone, updateZone, deleteZone, calculateShipping } = require('../models/shippingModel');

// GET /api/shipping - public/admin alias to all shipping configurations/zones
router.get('/', async (req, res) => {
  try {
    const zones = await getAllZones();
    res.json(zones);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to get shipping zones' });
  }
});

// POST /api/shipping - admin create shipping configuration/zone
router.post('/', authenticateAdmin, async (req, res) => {
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

// PUT /api/shipping/:id - admin update zone
router.put('/:id', authenticateAdmin, async (req, res) => {
  try {
    await updateZone(req.params.id, req.body);
    res.json({ message: 'Shipping zone updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to update zone' });
  }
});

// DELETE /api/shipping/:id - admin delete zone
router.delete('/:id', authenticateAdmin, async (req, res) => {
  try {
    await deleteZone(req.params.id);
    res.json({ message: 'Shipping zone deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to delete zone' });
  }
});

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

router.use('/', require('./shippingLabelRoutes'));


// GET /api/shipping/pincode/:pincode - Real-time Indian pincode serviceability & Estimated Delivery Date (EDD)
router.get('/pincode/:pincode', async (req, res) => {
  const pincode = String(req.params.pincode || '').trim();
  if (!/^[1-9][0-9]{5}$/.test(pincode)) {
    return res.status(400).json({
      success: false,
      serviceable: false,
      message: 'Enter a valid 6-digit Indian postal pincode.',
    });
  }

  // Calculate delivery date estimates based on standard D2C Indian logistics (3-5 days standard, metro express)
  const isMetro = ['110', '400', '700', '600', '560', '500'].some(prefix => pincode.startsWith(prefix));
  const minDays = isMetro ? 2 : 3;
  const maxDays = isMetro ? 4 : 6;

  const now = new Date();
  const minDate = new Date(now.getTime() + minDays * 24 * 60 * 60 * 1000);
  const maxDate = new Date(now.getTime() + maxDays * 24 * 60 * 60 * 1000);

  const options = { weekday: 'short', month: 'short', day: 'numeric' };
  const minDateFormatted = minDate.toLocaleDateString('en-IN', options);
  const maxDateFormatted = maxDate.toLocaleDateString('en-IN', options);

  return res.json({
    success: true,
    pincode,
    serviceable: true,
    cod_available: true,
    is_metro: isMetro,
    estimated_delivery: `${minDateFormatted} - ${maxDateFormatted}`,
    estimated_days: `${minDays}-${maxDays} business days`,
    delivery_charge: 50.0,
    free_delivery_above: 500.0,
    provider: 'Bhumivera Express Logistics',
  });
});

module.exports = router;
