const axios = require('axios');
const crypto = require('crypto');
const {
  getCarrierAccount,
  saveCarrierAccount,
  listCarrierAccounts,
} = require('../models/shippingLabelModel');
const { decryptCredentials, encryptCredentials } = require('./carrierCredentials');
const { getOrderById } = require('../models/orderModel');
const { getReturnById } = require('../models/returnModel');

const PROVIDERS = Object.freeze(['shiprocket', 'delhivery', 'bluedart']);
const HTTP_TIMEOUT = 20000;
const shiprocketTokens = new Map();

const carrierError = (message, status = 502) => Object.assign(new Error(message), { status });
const safeRemoteMessage = error => {
  const data = error.response?.data;
  const message = data?.message || data?.error || data?.rmk || error.message;
  return String(message || 'Carrier request failed.').slice(0, 500);
};

const requiredString = (value, label, maxLength = 255) => {
  const result = String(value || '').trim();
  if (!result || result.length > maxLength) throw carrierError(`${label} is required (max ${maxLength} characters).`, 400);
  return result;
};

const validateCarrierCredentials = (provider, body = {}) => {
  const credentials = { ...body };
  const required = {
    shiprocket: ['email', 'password', 'pickup_location', 'pickup_address', 'pickup_city', 'pickup_state', 'pickup_pincode', 'pickup_phone'],
    delhivery: ['api_token', 'client_name', 'pickup_name', 'pickup_address', 'pickup_city', 'pickup_state', 'pickup_pincode', 'pickup_phone'],
    bluedart: ['client_id', 'client_secret', 'license_key', 'login_id', 'customer_code', 'customer_type', 'area_code', 'pickup_name', 'pickup_address', 'pickup_city', 'pickup_state', 'pickup_pincode', 'pickup_phone'],
  }[provider];
  if (!required) throw carrierError('Unsupported carrier provider.', 400);
  for (const field of required) credentials[field] = requiredString(body[field], field.replace(/_/g, ' '));
  if (!/^\d{6}$/.test(credentials.pickup_pincode)) throw carrierError('Pickup pincode must be 6 digits.', 400);
  if (!/^[6-9]\d{9}$/.test(credentials.pickup_phone.replace(/\D/g, '').slice(-10))) {
    throw carrierError('Pickup phone must be a valid Indian mobile number.', 400);
  }
  credentials.pickup_phone = credentials.pickup_phone.replace(/\D/g, '').slice(-10);
  if (provider === 'delhivery') {
    credentials.base_url = 'https://track.delhivery.com';
  } else if (provider === 'shiprocket') {
    credentials.base_url = 'https://apiv2.shiprocket.in/v1/external';
  } else {
    credentials.base_url = 'https://apigateway.bluedart.com';
  }
  if (typeof body.enabled !== 'boolean') throw carrierError('Choose whether this carrier account is enabled.', 400);
  credentials.enabled = body.enabled;
  return credentials;
};

const accountCredentials = async provider => {
  const account = await getCarrierAccount(provider);
  if (!account?.is_enabled) throw carrierError(`${provider} is not configured or enabled.`, 409);
  try {
    return decryptCredentials(account.credentials_ciphertext);
  } catch (error) {
    console.error('[CARRIER_CREDENTIAL_DECRYPTION]', { provider, message: error.message });
    throw carrierError('Carrier credentials could not be decrypted. Check CARRIER_CREDENTIALS_KEY.', 500);
  }
};

const getPublicCarrierStatus = async () => {
  const accounts = await listCarrierAccounts();
  const byProvider = new Map(accounts.map(account => [account.provider, account]));
  return PROVIDERS.map(provider => ({
    provider,
    enabled: Boolean(byProvider.get(provider)?.is_enabled),
    configured: Boolean(byProvider.has(provider)),
    updated_at: byProvider.get(provider)?.updated_at || null,
  }));
};

const getShiprocketToken = async credentials => {
  const tokenCacheKey = crypto.createHash('sha256')
    .update(`${credentials.email}\0${credentials.password}`)
    .digest('hex');
  const cached = shiprocketTokens.get(tokenCacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  try {
    const response = await axios.post(
      `${credentials.base_url}/auth/login`,
      { email: credentials.email, password: credentials.password },
      { timeout: HTTP_TIMEOUT }
    );
    const token = response.data?.token;
    if (!token) throw carrierError('Shiprocket authentication did not return an access token.');
    shiprocketTokens.set(tokenCacheKey, { token, expiresAt: Date.now() + 8 * 60 * 60 * 1000 });
    return token;
  } catch (error) {
    throw carrierError(`Shiprocket authentication failed: ${safeRemoteMessage(error)}`);
  }
};

const mapOrder = order => {
  const address = order.address_snapshot || {};
  const firstName = String(address.full_name || order.user_name || 'Customer').trim().split(/\s+/)[0];
  const lastName = String(address.full_name || order.user_name || '').trim().split(/\s+/).slice(1).join(' ');
  const items = (order.items || []).map(item => ({
    name: String(item.name).slice(0, 255),
    sku: String(item.sku || `BV-${item.product_id || item.id}`).slice(0, 100),
    units: Math.max(1, Number(item.quantity) || 1),
    selling_price: Number(item.price) || 0,
    discount: 0,
    tax: Number(item.gst_rate) || 0,
    hsn: item.gst_hsn_code || '',
  }));
  return {
    address,
    firstName,
    lastName,
    items,
  };
};

const shiprocketPayload = (order, credentials, packageDetails, externalOrderId, direction) => {
  const mapped = mapOrder(order);
  const address = mapped.address;
  const customerName = direction === 'return'
    ? String(credentials.pickup_name)
    : String(address.full_name || order.user_name || 'Customer');
  const customerAddress = direction === 'return'
    ? credentials.pickup_address
    : [address.street_address, address.line2].filter(Boolean).join(', ');
  const customerCity = direction === 'return' ? credentials.pickup_city : address.city;
  const customerState = direction === 'return' ? credentials.pickup_state : address.state;
  const customerPincode = direction === 'return' ? credentials.pickup_pincode : address.postal_code || address.pincode;
  const customerPhone = direction === 'return' ? credentials.pickup_phone : address.phone_number || address.phone;

  const sellerName = direction === 'return' ? String(address.full_name || order.user_name || 'Customer') : credentials.pickup_name || 'Bhumivera';
  const sellerAddress = direction === 'return'
    ? [address.street_address, address.line2].filter(Boolean).join(', ')
    : credentials.pickup_address;
  const sellerCity = direction === 'return' ? address.city : credentials.pickup_city;
  const sellerState = direction === 'return' ? address.state : credentials.pickup_state;
  const sellerPincode = direction === 'return' ? address.postal_code || address.pincode : credentials.pickup_pincode;
  const sellerPhone = direction === 'return' ? address.phone_number || address.phone : credentials.pickup_phone;

  return {
    order_id: externalOrderId,
    order_date: new Date(order.created_at).toISOString().slice(0, 10),
    pickup_location: credentials.pickup_location || credentials.client_name,
    channel_id: '',
    comment: direction === 'return' ? `Return pickup for order ${order.id}` : `Bhumivera order ${order.id}`,
    billing_customer_name: customerName.slice(0, 50),
    billing_last_name: direction === 'return' ? '' : mapped.lastName.slice(0, 50),
    billing_address: String(customerAddress || 'Address unavailable').slice(0, 190),
    billing_address_2: '',
    billing_city: String(customerCity || '').slice(0, 50),
    billing_pincode: String(customerPincode || ''),
    billing_state: String(customerState || '').slice(0, 50),
    billing_country: String(address.country || 'India'),
    billing_email: String(order.user_email || 'orders@bhumivera.com'),
    billing_phone: String(customerPhone || '').replace(/\D/g, '').slice(-10),
    shipping_is_billing: direction !== 'return',
    ...(direction === 'return' ? {
      shipping_customer_name: sellerName.slice(0, 50),
      shipping_last_name: '',
      shipping_address: String(sellerAddress || '').slice(0, 190),
      shipping_address_2: '',
      shipping_city: String(sellerCity || '').slice(0, 50),
      shipping_pincode: String(sellerPincode || ''),
      shipping_state: String(sellerState || '').slice(0, 50),
      shipping_country: String(address.country || 'India'),
      shipping_email: String(order.user_email || 'orders@bhumivera.com'),
      shipping_phone: String(sellerPhone || '').replace(/\D/g, '').slice(-10),
    } : {}),
    order_items: mapped.items,
    payment_method: ['COD'].includes(order.payment_mode) ? 'COD' : 'Prepaid',
    shipping_charges: Number(order.shipping_cost) || 0,
    giftwrap_charges: 0,
    transaction_charges: 0,
    total_discount: Number(order.discount) || 0,
    sub_total: mapped.items.reduce((sum, item) => sum + item.selling_price * item.units, 0),
    length: packageDetails.length,
    breadth: packageDetails.width,
    height: packageDetails.height,
    weight: packageDetails.weight,
  };
};

const createShiprocketLabel = async ({ order, credentials, packageDetails, labelId, direction, courierId }) => {
  const token = await getShiprocketToken(credentials);
  const headers = { Authorization: `Bearer ${token}` };
  const externalOrderId = `BV-${order.id}-${direction === 'return' ? 'R' : 'F'}-${labelId}`;
  try {
    const endpoint = direction === 'return' ? '/orders/create/return' : '/orders/create/adhoc';
    const response = await axios.post(
      `${credentials.base_url}${endpoint}`,
      shiprocketPayload(order, credentials, packageDetails, externalOrderId, direction),
      { headers, timeout: HTTP_TIMEOUT }
    );
    const shipmentId = response.data?.shipment_id;
    if (!shipmentId) throw carrierError('Shiprocket did not return a shipment ID.');
    const awbResponse = await axios.post(
      `${credentials.base_url}/courier/assign/awb`,
      { shipment_id: shipmentId, ...(courierId ? { courier_id: courierId } : {}) },
      { headers, timeout: HTTP_TIMEOUT }
    );
    const awb = awbResponse.data?.response?.data?.awb_code ||
      awbResponse.data?.awb_code || awbResponse.data?.response?.data?.shipment_id;
    const labelResponse = await axios.post(
      `${credentials.base_url}/courier/generate/label`,
      { shipment_id: [shipmentId] },
      { headers, timeout: HTTP_TIMEOUT }
    );
    const labelUrl = labelResponse.data?.label_url ||
      labelResponse.data?.response?.label_url ||
      labelResponse.data?.label_created;
    return {
      externalOrderId,
      externalShipmentId: String(shipmentId),
      trackingNumber: String(awb || ''),
      labelUrl: typeof labelUrl === 'string' && labelUrl.startsWith('https://') ? labelUrl : null,
      serviceName: awbResponse.data?.response?.data?.courier_name || null,
    };
  } catch (error) {
    throw carrierError(`Shiprocket label booking failed: ${safeRemoteMessage(error)}`);
  }
};

const delhiveryPayload = ({ order, credentials, packageDetails, externalOrderId, direction, waybill }) => {
  const mapped = mapOrder(order);
  const address = mapped.address;
  const recipientName = direction === 'return'
    ? credentials.pickup_name
    : String(address.full_name || order.user_name || 'Customer');
  const recipientAddress = direction === 'return'
    ? credentials.pickup_address
    : [address.street_address, address.line2].filter(Boolean).join(', ');
  const recipientCity = direction === 'return' ? credentials.pickup_city : address.city;
  const recipientState = direction === 'return' ? credentials.pickup_state : address.state;
  const recipientPin = direction === 'return' ? credentials.pickup_pincode : address.postal_code || address.pincode;
  const recipientPhone = direction === 'return' ? credentials.pickup_phone : address.phone_number || address.phone;
  const pickupAddress = direction === 'return' ? address : credentials;
  const pickupName = direction === 'return' ? String(address.full_name || order.user_name || 'Customer') : credentials.pickup_name;
  const pickupStreet = direction === 'return'
    ? [address.street_address, address.line2].filter(Boolean).join(', ')
    : credentials.pickup_address;
  const pickupCity = direction === 'return' ? address.city : credentials.pickup_city;
  const pickupState = direction === 'return' ? address.state : credentials.pickup_state;
  const pickupPin = direction === 'return' ? address.postal_code || address.pincode : credentials.pickup_pincode;
  const pickupPhone = direction === 'return' ? address.phone_number || address.phone : credentials.pickup_phone;
  const cod = order.payment_mode === 'COD';
  return {
    shipments: [{
      name: String(recipientName).slice(0, 100),
      add: String(recipientAddress || '').slice(0, 200),
      pin: String(recipientPin || ''),
      city: String(recipientCity || ''),
      state: String(recipientState || ''),
      country: 'India',
      phone: String(recipientPhone || '').replace(/\D/g, '').slice(-10),
      order: externalOrderId,
      payment_mode: cod && direction === 'forward' ? 'COD' : 'Pre-paid',
      cod_amount: cod && direction === 'forward' ? Number(order.total) || 0 : 0,
      products_desc: (order.items || []).map(item => item.name).join(', ').slice(0, 255),
      hsn_code: (order.items || []).map(item => item.gst_hsn_code).filter(Boolean).join(',').slice(0, 100),
      seller_name: String(pickupName || 'Bhumivera'),
      seller_add: String(pickupStreet || '').slice(0, 200),
      seller_city: String(pickupCity || ''),
      seller_state: String(pickupState || ''),
      seller_pin: String(pickupPin || ''),
      seller_phone: String(pickupPhone || '').replace(/\D/g, '').slice(-10),
      seller_inv: `BV-${order.id}`,
      quantity: (order.items || []).reduce((sum, item) => sum + Number(item.quantity || 0), 0),
      total_amount: Number(order.total) || 0,
      weight: Math.round(Number(packageDetails.weight) * 1000),
      shipment_width: packageDetails.width,
      shipment_height: packageDetails.height,
      shipment_length: packageDetails.length,
      waybill,
      ...(direction === 'return' ? { is_reverse: true, return_reason: 'Customer return request' } : {}),
    }],
    pickup_location: {
      name: String(pickupName || credentials.client_name),
      add: String(pickupStreet || ''),
      city: String(pickupCity || ''),
      pin: String(pickupPin || ''),
      country: 'India',
      phone: String(pickupPhone || '').replace(/\D/g, '').slice(-10),
    },
  };
};

const createDelhiveryLabel = async ({ order, credentials, packageDetails, labelId, direction }) => {
  const baseUrl = credentials.base_url || 'https://track.delhivery.com';
  const headers = { Authorization: `Token ${credentials.api_token}` };
  const externalOrderId = `BV-${order.id}-${direction === 'return' ? 'R' : 'F'}-${labelId}`;
  try {
    const waybillResponse = await axios.get(`${baseUrl}/waybill/api/bulk/json/`, {
      params: { cl: credentials.client_name, count: 1 },
      headers,
      timeout: HTTP_TIMEOUT,
    });
    const waybill = Array.isArray(waybillResponse.data)
      ? waybillResponse.data[0]
      : waybillResponse.data?.waybill;
    if (!waybill) throw carrierError('Delhivery did not return a waybill.');
    const data = delhiveryPayload({ order, credentials, packageDetails, externalOrderId, direction, waybill });
    const response = await axios.post(
      `${baseUrl}/api/cmu/create.json`,
      new URLSearchParams({ format: 'json', data: JSON.stringify(data) }).toString(),
      { headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: HTTP_TIMEOUT }
    );
    const result = response.data?.packages?.[0] || response.data?.upload_wbn ||
      response.data?.packages?.[0];
    if (response.data?.success === false || response.data?.packages?.[0]?.status === 'Fail') {
      throw carrierError(response.data?.packages?.[0]?.remarks?.join(', ') || 'Delhivery rejected the shipment.');
    }
    if (!result && !response.data?.upload_wbn) throw carrierError('Delhivery did not confirm the shipment booking.');
    return {
      externalOrderId,
      externalShipmentId: String(response.data?.upload_wbn || waybill),
      trackingNumber: String(waybill),
      labelUrl: null,
      serviceName: credentials.client_name,
    };
  } catch (error) {
    throw carrierError(`Delhivery label booking failed: ${safeRemoteMessage(error)}`);
  }
};

const createLabelWithProvider = async args => {
  const credentials = await accountCredentials(args.provider);
  if (args.provider === 'shiprocket') return createShiprocketLabel({ ...args, credentials });
  if (args.provider === 'delhivery') return createDelhiveryLabel({ ...args, credentials });
  throw carrierError(
    'Blue Dart direct booking requires the API product and request schema enabled for this account. Configure Shiprocket or Delhivery now, or provide Blue Dart’s account-specific API specification before enabling booking.',
    501
  );
};

const testCarrierCredentials = async (provider, body) => {
  const credentials = validateCarrierCredentials(provider, { ...body, enabled: false });
  if (provider === 'shiprocket') {
    await getShiprocketToken(credentials);
    return { message: 'Shiprocket credentials authenticated successfully.' };
  }
  if (provider === 'delhivery') {
    try {
      await axios.get(`${credentials.base_url}/api/v1/packages/json/`, {
        params: { waybill: 'BV-CONNECTION-TEST' },
        headers: { Authorization: `Token ${credentials.api_token}` },
        timeout: HTTP_TIMEOUT,
      });
      return { message: 'Delhivery token authenticated successfully.' };
    } catch (error) {
      if ([401, 403].includes(error.response?.status)) {
        throw carrierError('Delhivery rejected the API token. Check that it is valid and has shipping permissions.', 401);
      }
      if (error.response?.status && error.response.status < 500) {
        return { message: 'Delhivery endpoint responded; confirm this token has shipment-creation permissions.' };
      }
      throw carrierError(`Delhivery connection test failed: ${safeRemoteMessage(error)}`);
    }
  }
  throw carrierError('Blue Dart direct credential testing requires the API auth method assigned to your account.', 501);
};

const prepareLabelOrder = async ({ orderId, returnId, direction }) => {
  const order = await getOrderById(orderId);
  if (!order) throw carrierError('Order not found.', 404);
  if (direction === 'forward' && !['confirmed', 'packed'].includes(order.status)) {
    throw carrierError('A forward shipping label can only be booked for a confirmed or packed order.', 409);
  }
  let returnRequest = null;
  if (direction === 'return') {
    returnRequest = await getReturnById(returnId);
    if (!returnRequest || Number(returnRequest.order_id) !== Number(orderId)) {
      throw carrierError('Return request not found for this order.', 404);
    }
    if (!['return_in_progress'].includes(returnRequest.status)) {
      throw carrierError('Accept the return request before booking a return pickup label.', 409);
    }
  }
  if (!order.address_snapshot?.state || !order.address_snapshot?.city ||
      !(order.address_snapshot?.postal_code || order.address_snapshot?.pincode)) {
    throw carrierError('The order address needs city, state, and a 6-digit postal code before booking.', 409);
  }
  const pincode = String(order.address_snapshot.postal_code || order.address_snapshot.pincode);
  if (!/^\d{6}$/.test(pincode)) throw carrierError('The customer address pincode must be 6 digits.', 409);
  return { order, returnRequest };
};

const saveAndTestCarrierConfiguration = async (provider, body, adminId) => {
  const credentials = validateCarrierCredentials(provider, body);
  const result = await testCarrierCredentials(provider, body);
  await saveCarrierAccount({
    provider,
    credentialsCiphertext: encryptCredentials(credentials),
    enabled: credentials.enabled,
    adminId,
  });
  return result;
};

module.exports = {
  PROVIDERS,
  validateCarrierCredentials,
  saveAndTestCarrierConfiguration,
  getPublicCarrierStatus,
  testCarrierCredentials,
  createLabelWithProvider,
  prepareLabelOrder,
};
