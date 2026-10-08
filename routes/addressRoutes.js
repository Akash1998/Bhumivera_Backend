const express = require('express');
const router = express.Router();
const { AddressModel } = require('../models/addressModel');
const { authenticateUser } = require('../middleware/authMiddleware');
const pool = require('../config/db');
const { normalizeAddressKeys } = require('../utils/fieldNormalizer');

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
    const body = normalizeAddressKeys(req.body);
    const { full_name, phone, phone_number, line1, street_address, pincode, postal_code, city, state } = body;
    const required_name = full_name;
    const required_phone = phone || phone_number;
    const required_line1 = line1 || street_address;
    const required_pincode = pincode || postal_code;

    if (!required_name || !required_phone || !required_line1 || !required_pincode || !city || !state) {
      return res.status(400).json({
        success: false,
        code: 'MISSING_ADDRESS_FIELDS',
        message: 'All required address fields must be filled (name, phone, line1, pincode, city, state).'
      });
    }

    await AddressModel.createAddress(req.user.id, body);
    const updatedAddresses = await AddressModel.getAddressesByUser(req.user.id);

    res.status(201).json({
      success: true,
      message: 'Address saved successfully',
      data: updatedAddresses,
      addresses: updatedAddresses
    });
  } catch (error) {
    console.error("[Address API POST Error]:", error.message);
    res.status(500).json({ success: false, message: 'Failed to save address', code: 'ADDRESS_SAVE_ERROR', error: error.message });
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
    const body = normalizeAddressKeys(req.body);
    const {
      full_name, phone, phone_number, line1, street_address,
      line2, city, state, pincode, postal_code, country,
      is_default, label
    } = body;
    const line2Provided = Object.prototype.hasOwnProperty.call(body, 'line2');

    const existing = (await pool.query('SELECT id FROM addresses WHERE id = ? AND user_id = ?', [addressId, userId]))[0][0];
    if (!existing) return res.status(404).json({ success: false, message: 'Address not found', code: 'ADDRESS_NOT_FOUND' });

    const final_full_name = full_name || null;
    const final_phone = phone_number || phone || null;
    const final_street_address = street_address || line1 || null;
    const final_line2 = line2Provided ? line2 : null;
    const final_postal_code = postal_code || pincode || null;
    const final_city = city || null;
    const final_state = state || null;
    const final_country = country || null;
    let final_is_default = null;
    if (typeof is_default === 'boolean') {
      final_is_default = is_default ? 1 : 0;
    } else if (typeof is_default === 'number') {
      final_is_default = is_default ? 1 : 0;
    }
    const final_label = label || null;

    if (final_is_default === 1) {
      await pool.query('UPDATE addresses SET is_default = FALSE WHERE user_id = ?', [userId]);
    }

    await pool.query(
      `UPDATE addresses SET
        full_name = COALESCE(?, full_name),
        phone_number = COALESCE(?, phone_number),
        street_address = COALESCE(?, street_address),
        line2 = IF(?, ?, line2),
        city = COALESCE(?, city),
        state = COALESCE(?, state),
        postal_code = COALESCE(?, postal_code),
        country = COALESCE(?, country),
        is_default = COALESCE(?, is_default),
        label = COALESCE(?, label)
       WHERE id = ? AND user_id = ?`,
      [
        final_full_name,
        final_phone,
        final_street_address,
        line2Provided ? 1 : 0,
        final_line2,
        final_city,
        final_state,
        final_postal_code,
        final_country,
        final_is_default,
        final_label,
        addressId,
        userId
      ]
    );

    const updatedAddresses = await AddressModel.getAddressesByUser(userId);
    res.json({ success: true, message: 'Address updated', data: updatedAddresses, addresses: updatedAddresses });
  } catch (error) {
    console.error("[Address API PUT Error]:", error.message);
    res.status(500).json({ success: false, message: 'Failed to update address', code: 'ADDRESS_UPDATE_ERROR', error: error.message });
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
