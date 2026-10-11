const { getOrderById } = require('../models/orderModel');
const { sendOrderStatusWhatsApp } = require('./whatsappOrderNotifications');

const notifyOrderWhatsApp = async (orderId, status, options = {}) => {
  try {
    const order = await getOrderById(orderId);
    if (!order) throw new Error('Updated order could not be loaded for WhatsApp notification.');
    const result = await sendOrderStatusWhatsApp({
      order,
      status,
      trackingNumber: options.trackingNumber,
      courier: options.courier,
      cancelReason: options.cancelReason,
    });
    if (result.sent) console.info('[WHATSAPP_ORDER_ALERT_SENT]', { orderId, status, messageId: result.messageId });
  } catch (error) {
    console.error('[WHATSAPP_ORDER_ALERT_FAILED]', { orderId, status, message: error.message });
  }
};

module.exports = { notifyOrderWhatsApp };
