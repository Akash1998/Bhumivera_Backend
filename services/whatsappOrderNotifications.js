const STATUS_LABELS = Object.freeze({
  pending: 'received',
  confirmed: 'confirmed',
  packed: 'packed',
  shipped: 'shipped',
  delivered: 'delivered',
  cancelled: 'cancelled',
  returned: 'returned',
  archived: 'archived',
});

const normalizeWhatsAppNumber = value => {
  const phone = String(value || '').trim();
  const digits = phone.replace(/\D/g, '');
  if (phone.startsWith('+') && /^[1-9]\d{7,14}$/.test(digits)) return digits;
  if (/^[6-9]\d{9}$/.test(digits)) return `91${digits}`;
  if (/^91[6-9]\d{9}$/.test(digits)) return digits;
  throw new Error('The delivery phone number is not a valid WhatsApp number.');
};

const requiredConfig = (env, key) => {
  const value = String(env[key] || '').trim();
  if (!value) throw new Error(`${key} is not configured.`);
  return value;
};

const isWhatsAppOrderNotificationsConfigured = (env = process.env) => {
  const apiVersion = String(env.WHATSAPP_API_VERSION || '').trim();
  const phoneNumberId = String(env.WHATSAPP_PHONE_NUMBER_ID || '').trim();
  const templateName = String(env.WHATSAPP_ORDER_STATUS_TEMPLATE || '').trim();
  return Boolean(
    String(env.WHATSAPP_ACCESS_TOKEN || '').trim() &&
    /^\d+$/.test(phoneNumberId) &&
    /^v\d+\.\d+$/.test(apiVersion) &&
    /^[a-z0-9_]+$/.test(templateName)
  );
};

const sanitizeParameter = (value, maxLength = 500) =>
  String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxLength) || '-';

const buildOrderStatusTemplate = ({ order, status, trackingNumber, courier, cancelReason }) => {
  const address = typeof order.address_snapshot === 'string'
    ? JSON.parse(order.address_snapshot)
    : order.address_snapshot || {};
  const customerName = String(order.user_name || address.full_name || 'Customer').trim().split(/\s+/)[0];
  const orderId = String(order.id);
  let detail = 'We will keep you updated.';

  if (status === 'cancelled') {
    detail = cancelReason || order.cancel_reason
      ? `Reason: ${sanitizeParameter(cancelReason || order.cancel_reason, 250)}`
      : 'Your order has been cancelled.';
  } else if (status === 'shipped' && (trackingNumber || order.tracking_number)) {
    detail = [
      courier || order.courier ? `Courier: ${sanitizeParameter(courier || order.courier, 100)}` : '',
      `Tracking number: ${sanitizeParameter(trackingNumber || order.tracking_number, 100)}`,
    ].filter(Boolean).join(' · ');
  } else if (status === 'delivered') {
    detail = 'Your package has been marked as delivered.';
  }

  return {
    to: normalizeWhatsAppNumber(address.phone_number || address.phone),
    name: sanitizeParameter(customerName, 100),
    orderId: sanitizeParameter(`#${orderId.padStart(10, '0')}`, 40),
    status: STATUS_LABELS[status] || sanitizeParameter(status, 50),
    detail,
    trackingUrl: 'https://www.bhumivera.com/order-tracking',
  };
};

const sendOrderStatusWhatsApp = async ({
  order,
  status,
  trackingNumber,
  courier,
  cancelReason,
  env = process.env,
  fetchImpl = globalThis.fetch,
}) => {
  if (
    !order ||
    Number(order.whatsapp_updates_opt_in) !== 1 ||
    Number(order.user_whatsapp_order_updates_opt_in) !== 1
  ) {
    return { sent: false, reason: 'customer_not_opted_in' };
  }
  const accessToken = requiredConfig(env, 'WHATSAPP_ACCESS_TOKEN');
  const phoneNumberId = requiredConfig(env, 'WHATSAPP_PHONE_NUMBER_ID');
  const apiVersion = requiredConfig(env, 'WHATSAPP_API_VERSION');
  const templateName = requiredConfig(env, 'WHATSAPP_ORDER_STATUS_TEMPLATE');
  if (!/^v\d+\.\d+$/.test(apiVersion)) throw new Error('WHATSAPP_API_VERSION must use the Meta Graph API version format (for example, v22.0).');
  if (!/^\d+$/.test(phoneNumberId)) throw new Error('WHATSAPP_PHONE_NUMBER_ID must contain digits only.');
  if (!/^[a-z0-9_]+$/.test(templateName)) throw new Error('WHATSAPP_ORDER_STATUS_TEMPLATE must be a valid WhatsApp template name.');
  if (typeof fetchImpl !== 'function') throw new Error('This Node.js runtime does not provide fetch for WhatsApp delivery.');

  const parameters = buildOrderStatusTemplate({ order, status, trackingNumber, courier, cancelReason });
  const response = await fetchImpl(
    `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(10000),
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: parameters.to,
        type: 'template',
        template: {
          name: templateName,
          language: { code: env.WHATSAPP_TEMPLATE_LANGUAGE || 'en' },
          components: [{
            type: 'body',
            parameters: [
              parameters.name,
              parameters.orderId,
              parameters.status,
              parameters.detail,
              parameters.trackingUrl,
            ].map(text => ({ type: 'text', text })),
          }],
        },
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`WhatsApp Cloud API rejected the order alert (HTTP ${response.status}).`);
  }
  const result = await response.json();
  const messageId = result?.messages?.[0]?.id;
  if (!messageId) throw new Error('WhatsApp Cloud API did not confirm the order alert.');
  return { sent: true, messageId };
};

module.exports = {
  buildOrderStatusTemplate,
  isWhatsAppOrderNotificationsConfigured,
  normalizeWhatsAppNumber,
  sendOrderStatusWhatsApp,
};
