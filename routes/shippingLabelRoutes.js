const express = require('express');
const { authenticateAdmin } = require('../middleware/authMiddleware');
const {
  beginShippingLabel,
  updateLabelRecord,
  getShippingLabel,
  getShippingLabels,
  logShippingLabelEvent,
} = require('../models/shippingLabelModel');
const {
  PROVIDERS,
  saveAndTestCarrierConfiguration,
  testCarrierCredentials,
  getPublicCarrierStatus,
  createLabelWithProvider,
  prepareLabelOrder,
} = require('../services/carrierLabelService');
const pool = require('../config/db');
const { decryptCredentials } = require('../services/carrierCredentials');
const { getCarrierAccount } = require('../models/shippingLabelModel');
const axios = require('axios');

const router = express.Router();
const asyncRoute = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
router.use(authenticateAdmin);

const parsePositive = (value, label, maximum) => {
  const result = Number(value);
  if (!Number.isFinite(result) || result <= 0 || result > maximum) {
    throw Object.assign(new Error(`${label} must be greater than 0 and at most ${maximum}.`), { status: 400 });
  }
  return result;
};

const packageDetails = body => ({
  weight: parsePositive(body.weight, 'Weight (kg)', 500),
  length: parsePositive(body.length, 'Length (cm)', 500),
  width: parsePositive(body.width, 'Width (cm)', 500),
  height: parsePositive(body.height, 'Height (cm)', 500),
});

router.get('/carriers', asyncRoute(async (req, res) => {
  res.json(await getPublicCarrierStatus());
}));

router.put('/carriers/:provider', asyncRoute(async (req, res) => {
  const { provider } = req.params;
  if (!PROVIDERS.includes(provider)) return res.status(404).json({ message: 'Unsupported carrier.' });
  if (provider === 'bluedart') {
    return res.status(501).json({
      message: 'Blue Dart credentials must not be saved until the API auth and shipment schemas provided to this account are confirmed. Use the manual AWB workflow meanwhile.',
      code: 'BLUEDART_API_SPEC_REQUIRED',
    });
  }
  const result = await saveAndTestCarrierConfiguration(provider, req.body || {}, req.admin.id);
  res.json(result);
}));

router.post('/carriers/:provider/test', asyncRoute(async (req, res) => {
  const { provider } = req.params;
  if (!PROVIDERS.includes(provider)) return res.status(404).json({ message: 'Unsupported carrier.' });
  res.json(await testCarrierCredentials(provider, req.body || {}));
}));

router.get('/labels', asyncRoute(async (req, res) => {
  const orderId = req.query.order_id ? Number(req.query.order_id) : null;
  const returnId = req.query.return_id ? Number(req.query.return_id) : null;
  if ((orderId !== null && (!Number.isSafeInteger(orderId) || orderId < 1)) ||
      (returnId !== null && (!Number.isSafeInteger(returnId) || returnId < 1)) ||
      (orderId !== null && returnId !== null)) {
    return res.status(400).json({ message: 'Provide one valid order_id or return_id filter.' });
  }
  res.json(await getShippingLabels({ orderId, returnId }));
}));

router.post('/labels', asyncRoute(async (req, res) => {
  const provider = String(req.body.provider || '').toLowerCase();
  const direction = req.body.direction === 'return' ? 'return' : 'forward';
  if (!PROVIDERS.includes(provider)) return res.status(400).json({ message: 'Select Shiprocket, Delhivery, or Blue Dart.' });
  if (provider === 'bluedart') {
    return res.status(501).json({
      message: 'Blue Dart direct label booking is not enabled because the account-specific API product/schema has not been verified.',
      code: 'BLUEDART_API_SPEC_REQUIRED',
    });
  }
  const orderId = Number(req.body.order_id);
  const returnId = direction === 'return' ? Number(req.body.return_id) : null;
  if (!Number.isSafeInteger(orderId) || orderId < 1 ||
      (direction === 'return' && (!Number.isSafeInteger(returnId) || returnId < 1))) {
    return res.status(400).json({ message: 'A valid order ID and, for reverse pickup, return request ID are required.' });
  }
  const dimensions = packageDetails(req.body);
  const { order, returnRequest } = await prepareLabelOrder({ orderId, returnId, direction });
  if (direction === 'return') {
    let returnItems;
    try {
      returnItems = typeof returnRequest.items === 'string' ? JSON.parse(returnRequest.items) : returnRequest.items;
    } catch {
      throw Object.assign(new Error('Return item data is invalid; cannot book pickup.'), { status: 409 });
    }
    const itemQuantities = new Map((Array.isArray(returnItems) ? returnItems : []).map(item => [
      Number(item.order_item_id),
      Number(item.quantity),
    ]));
    order.items = order.items.filter(item => itemQuantities.has(Number(item.id))).map(item => ({
      ...item,
      quantity: itemQuantities.get(Number(item.id)),
    }));
    if (!order.items.length) {
      throw Object.assign(new Error('No valid return items were found for the pickup.'), { status: 409 });
    }
  }

  let labelId;
  try {
    labelId = await beginShippingLabel({
      orderId,
      returnId,
      direction,
      provider,
      packageDetails: dimensions,
      adminId: req.admin.id,
    });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'Another carrier booking was started for this order/return. Refresh labels before retrying.' });
    throw error;
  }
  await logShippingLabelEvent(labelId, 'booking_started', { provider, direction }, req.admin.id);
  try {
    const result = await createLabelWithProvider({
      order,
      provider,
      packageDetails: dimensions,
      labelId,
      direction,
      courierId: req.body.courier_id ? String(req.body.courier_id) : null,
    });
    await updateLabelRecord(labelId, {
      status: 'booked',
      externalOrderId: result.externalOrderId,
      externalShipmentId: result.externalShipmentId,
      trackingNumber: result.trackingNumber,
      labelUrl: result.labelUrl,
      serviceName: result.serviceName,
      errorMessage: null,
    });
    if (direction === 'forward' && result.trackingNumber) {
      await pool.query(
        'UPDATE orders SET tracking_number = ?, courier = ? WHERE id = ?',
        [result.trackingNumber, result.serviceName || provider, orderId]
      );
    }
    await logShippingLabelEvent(labelId, 'booked', {
      provider,
      direction,
      tracking_number: result.trackingNumber,
    }, req.admin.id);
    res.status(201).json(await getShippingLabel(labelId));
  } catch (error) {
    await updateLabelRecord(labelId, {
      status: 'failed',
      errorMessage: error.message || 'Carrier booking failed.',
    });
    await logShippingLabelEvent(labelId, 'booking_failed', {
      message: String(error.message || 'Carrier booking failed.').slice(0, 500),
    }, req.admin.id);
    throw error;
  }
}));

router.get('/labels/:id/file', asyncRoute(async (req, res) => {
  const label = await getShippingLabel(req.params.id);
  if (!label || label.status !== 'booked') return res.status(404).json({ message: 'Booked shipping label not found.' });
  let response;
  if (label.provider === 'shiprocket') {
    if (!label.label_url) return res.status(404).json({ message: 'The carrier has not generated a printable label yet.' });
    let labelUrl;
    try {
      labelUrl = new URL(label.label_url);
    } catch {
      return res.status(502).json({ message: 'Carrier returned an invalid label address.' });
    }
    if (labelUrl.protocol !== 'https:' ||
      !/(^|\.)shiprocket\.in$|(^|\.)shiprocket\.co$|(^|\.)amazonaws\.com$/i.test(labelUrl.hostname)) {
      return res.status(502).json({ message: 'Carrier returned an unsupported label address.' });
    }
    response = await axios.get(labelUrl.href, {
      responseType: 'arraybuffer',
      timeout: 30000,
      maxRedirects: 0,
    });
  } else if (label.provider === 'delhivery') {
    const account = await getCarrierAccount('delhivery');
    if (!account?.is_enabled) return res.status(409).json({ message: 'Delhivery carrier account is disabled.' });
    const credentials = decryptCredentials(account.credentials_ciphertext);
    response = await axios.get(`${credentials.base_url}/api/p/packing_slip`, {
      params: { wbns: label.tracking_number, pdf: true },
      headers: { Authorization: `Token ${credentials.api_token}` },
      responseType: 'arraybuffer',
      timeout: 30000,
      maxRedirects: 0,
    });
  } else {
    return res.status(501).json({ message: 'Blue Dart label downloads need the account-specific API schema.' });
  }
  const contentType = String(response.headers['content-type'] || '');
  if (!contentType.toLowerCase().includes('pdf')) {
    return res.status(502).json({ message: 'The carrier did not return a PDF label.' });
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="Bhumivera_${label.direction}_label_${label.id}.pdf"`);
  res.send(Buffer.from(response.data));
}));

router.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = Number(error.status) || 500;
  if (status >= 500) console.error('[SHIPPING_LABEL]', { message: error.message, provider: req.body?.provider });
  res.status(status).json({ message: status >= 500 ? error.message || 'Shipping operation failed.' : error.message });
});

module.exports = router;
