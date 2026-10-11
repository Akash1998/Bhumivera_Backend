const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  buildOrderStatusTemplate,
  isWhatsAppOrderNotificationsConfigured,
  normalizeWhatsAppNumber,
  sendOrderStatusWhatsApp,
} = require('../services/whatsappOrderNotifications');

const validEnv = {
  WHATSAPP_ACCESS_TOKEN: 'test-token',
  WHATSAPP_PHONE_NUMBER_ID: '123456789',
  WHATSAPP_API_VERSION: 'v22.0',
  WHATSAPP_ORDER_STATUS_TEMPLATE: 'order_status_update',
};

const optedInOrder = {
  id: 12,
  user_name: 'Asha Customer',
  whatsapp_updates_opt_in: 1,
  address_snapshot: { phone_number: '9876543210', full_name: 'Asha Customer' },
};

describe('WhatsApp order notifications', () => {
  it('normalizes Indian mobile numbers and accepts valid international E.164 numbers', () => {
    assert.equal(normalizeWhatsAppNumber('+919876543210'), '919876543210');
    assert.equal(normalizeWhatsAppNumber('9876543210'), '919876543210');
    assert.equal(normalizeWhatsAppNumber('919876543210'), '919876543210');
    assert.throws(() => normalizeWhatsAppNumber('12345'), /valid WhatsApp number/);
  });

  it('builds status and tracking details from the stored order address', () => {
    assert.deepEqual(
      buildOrderStatusTemplate({
        order: { ...optedInOrder, status: 'shipped', tracking_number: 'TRK-123', courier: 'Courier Co.' },
        status: 'shipped',
      }),
      {
        to: '919876543210',
        name: 'Asha',
        orderId: '#0000000012',
        status: 'shipped',
        detail: 'Courier: Courier Co. · Tracking number: TRK-123',
        trackingUrl: 'https://www.bhumivera.com/order-tracking',
      }
    );
  });

  it('includes a cancellation reason without leaking control characters into the template', () => {
    const template = buildOrderStatusTemplate({
      order: optedInOrder,
      status: 'cancelled',
      cancelReason: 'Customer requested\ncancellation',
    });
    assert.equal(template.status, 'cancelled');
    assert.equal(template.detail, 'Reason: Customer requested cancellation');
  });

  it('does not contact WhatsApp for customers who did not opt in', async () => {
    let called = false;
    const result = await sendOrderStatusWhatsApp({
      order: { ...optedInOrder, whatsapp_updates_opt_in: 0 },
      status: 'confirmed',
      env: {},
      fetchImpl: async () => { called = true; },
    });
    assert.deepEqual(result, { sent: false, reason: 'customer_not_opted_in' });
    assert.equal(called, false);
  });

  it('reports availability without exposing Meta credentials', () => {
    assert.equal(isWhatsAppOrderNotificationsConfigured(validEnv), true);
    assert.equal(isWhatsAppOrderNotificationsConfigured({ ...validEnv, WHATSAPP_ACCESS_TOKEN: '' }), false);
  });

  it('sends the approved template with five body parameters', async () => {
    let request;
    const result = await sendOrderStatusWhatsApp({
      order: optedInOrder,
      status: 'confirmed',
      env: validEnv,
      fetchImpl: async (url, options) => {
        request = { url, options, body: JSON.parse(options.body) };
        return { ok: true, json: async () => ({ messages: [{ id: 'wamid.test' }] }) };
      },
    });

    assert.equal(result.sent, true);
    assert.equal(result.messageId, 'wamid.test');
    assert.equal(request.url, 'https://graph.facebook.com/v22.0/123456789/messages');
    assert.equal(request.options.headers.Authorization, 'Bearer test-token');
    assert.deepEqual(request.body.template.components[0].parameters.map(parameter => parameter.text), [
      'Asha',
      '#0000000012',
      'confirmed',
      'We will keep you updated.',
      'https://www.bhumivera.com/order-tracking',
    ]);
  });

  it('reports missing provider setup and rejected provider requests', async () => {
    await assert.rejects(
      sendOrderStatusWhatsApp({ order: optedInOrder, status: 'confirmed', env: {} }),
      /WHATSAPP_ACCESS_TOKEN is not configured/
    );
    await assert.rejects(
      sendOrderStatusWhatsApp({
        order: optedInOrder,
        status: 'confirmed',
        env: validEnv,
        fetchImpl: async () => ({ ok: false, status: 400 }),
      }),
      /HTTP 400/
    );
  });
});
