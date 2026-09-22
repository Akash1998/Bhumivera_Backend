const express = require('express');
const router = express.Router();
const { AddressModel } = require('../models/addressModel');
const { authenticateUser } = require('../middleware/authMiddleware');
const pool = require('../config/db');

router.get('/', authenticateUser, async (req, res) => {
  try {
    const addresses = await AddressModel.getAddressesByUser(req.user.id);
    res.json({ 
      success: true, 
      data: addresses,
      addresses: addresses 
    });
  } catch (error) {
    console.error("[Address API GET Error]:", error.message);
    res.status(500).json({ success: false, message: 'Failed to fetch addresses' });
  }
});

router.post('/', authenticateUser, async (req, res) => {
  try {
    const { full_name, phone, line1, pincode, city, state } = req.body;
    
    if (!full_name || !phone || !line1 || !pincode || !city || !state) {
      return res.status(400).json({ 
        success: false, 
        message: 'All required address fields must be filled.' 
      });
    }

    await AddressModel.createAddress(req.user.id, req.body);
    const updatedAddresses = await AddressModel.getAddressesByUser(req.user.id);
    
    res.status(201).json({ 
      success: true, 
      message: 'Address saved successfully', 
      data: updatedAddresses,
      addresses: updatedAddresses
    });
  } catch (error) {
    console.error("[Address API POST Error]:", error.message);
    res.status(500).json({ success: false, message: 'Failed to save address' });
  }
});

router.patch('/:id/default', authenticateUser, async (req, res) => {
  try {
    const addressId = req.params.id;
    const userId = req.user.id;

    const success = await AddressModel.setAsDefault(userId, addressId);

    if (!success) {
      return res.status(404).json({ success: false, message: 'Address not found' });
    }

    const updatedAddresses = await AddressModel.getAddressesByUser(userId);
    res.json({ success: true, message: 'Default address updated', data: updatedAddresses });
  } catch (error) {
    console.error("[Address API PATCH Error]:", error.message);
    res.status(500).json({ success: false, message: 'Failed to update default address' });
  }
});

router.put('/:id', authenticateUser, async (req, res) => {
  try {
    const addressId = req.params.id;
    const userId = req.user.id;
    const { full_name, phone, phone_number, line1, street_address, city, state, pincode, postal_code, country, is_default, label } = req.body;

    const existing = (await pool.query('SELECT id FROM addresses WHERE id = ? AND user_id = ?', [addressId, userId]))[0][0];
    if (!existing) return res.status(404).json({ success: false, message: 'Address not found' });

    if (is_default) {
      await pool.query('UPDATE addresses SET is_default = FALSE WHERE user_id = ?', [userId]);
    }

    await pool.query(
      `UPDATE addresses SET
        full_name = COALESCE(?, full_name),
        phone_number = COALESCE(?, phone_number),
        street_address = COALESCE(?, street_address),
        city = COALESCE(?, city),
        state = COALESCE(?, state),
        postal_code = COALESCE(?, postal_code),
        country = COALESCE(?, country),
        is_default = COALESCE(?, is_default),
        label = COALESCE(?, label)
       WHERE id = ? AND user_id = ?`,
      [
        full_name || null,
        phone_number || phone || null,
        street_address || line1 || null,
        city || null,
        state || null,
        postal_code || pincode || null,
        country || null,
        typeof is_default === 'boolean' ? (is_default ? 1 : 0) : null,
        label || null,
        addressId,
        userId
      ]
    );

    const updatedAddresses = await AddressModel.getAddressesByUser(userId);
    res.json({ success: true, message: 'Address updated', data: updatedAddresses, addresses: updatedAddresses });
  } catch (error) {
    console.error("[Address API PUT Error]:", error.message);
    res.status(500).json({ success: false, message: 'Failed to update address' });
  }
});

router.delete('/:id', authenticateUser, async (req, res) => {
  try {
    const success = await AddressModel.deleteAddress(req.user.id, req.params.id);

    if (!success) {
      return res.status(404).json({ success: false, message: 'Address not found' });
    }

    const updatedAddresses = await AddressModel.getAddressesByUser(req.user.id);
    res.json({ success: true, message: 'Address deleted', data: updatedAddresses });
  } catch (error) {
    console.error("[Address API DELETE Error]:", error.message);
    res.status(500).json({ success: false, message: 'Failed to delete address' });
  }
});

module.exports = router;
