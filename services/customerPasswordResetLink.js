const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { sendMail } = require('../utils/mail');

const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[character]);

const sendCustomerPasswordResetLink = async customer => {
  if (!customer || customer.role !== 'customer' || !customer.id || !customer.email) {
    throw new Error('A valid customer account is required to send a password reset link.');
  }
  const token = jwt.sign(
    { sub: String(customer.id), email: customer.email, role: 'customer', aud: 'reset', scope: 'reset-password' },
    process.env.JWT_SECRET || 'fallback_secret',
    { expiresIn: '30m', jwtid: crypto.randomUUID() }
  );
  const frontendUrl = (process.env.FRONTEND_URL || process.env.CLIENT_URL || 'https://www.bhumivera.com').replace(/\/+$/, '');
  const resetUrl = `${frontendUrl}/reset-password?mode=support&token=${encodeURIComponent(token)}`;
  await sendMail({
    to: customer.email,
    subject: 'Secure link to update your Bhumivera password',
    text: `A Bhumivera support team member initiated a secure password update. Open this one-time link within 30 minutes: ${resetUrl}\nIf you did not request help, ignore this email.`,
    html: `<p>A Bhumivera support team member initiated a secure password update for your account.</p><p><a href="${escapeHtml(resetUrl)}">Update your password</a></p><p>This one-time link expires in 30 minutes. If you did not request help, ignore this email.</p>`,
  });
  return `Secure reset link sent to ${customer.email}. It expires in 30 minutes.`;
};

module.exports = { sendCustomerPasswordResetLink };
