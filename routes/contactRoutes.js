const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { initContactTable, ContactModel } = require('../models/contactModel');
const { authenticateUser, authenticateAdmin } = require('../middleware/authMiddleware');
const { sendMail } = require('../utils/mail');

const MAX_MESSAGE_LENGTH = 10000;
const validId = value => /^\d+$/.test(String(value)) && Number(value) > 0;
const validEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[character]);

const attachMessages = async tickets => {
  if (!tickets.length) return tickets;
  const messages = await ContactModel.getMessagesByTicketIds(tickets.map(ticket => ticket.id));
  const messagesByTicket = new Map();
  for (const message of messages) {
    if (!messagesByTicket.has(message.ticket_id)) messagesByTicket.set(message.ticket_id, []);
    messagesByTicket.get(message.ticket_id).push(message);
  }
  return tickets.map(ticket => ({
    ...ticket,
    messages: [
      {
        id: `ticket-${ticket.id}`,
        ticket_id: ticket.id,
        sender_type: 'customer',
        message: ticket.message,
        created_at: ticket.created_at
      },
      ...(messagesByTicket.get(ticket.id) || [])
    ]
  }));
};

const validateMessage = value =>
  typeof value === 'string' && value.trim().length > 0 && value.trim().length <= MAX_MESSAGE_LENGTH;

router.post('/', authenticateUser, async (req, res) => {
  try {
    const { name, email, subject, message, order_id, product_id } = req.body;
    const ticketName = typeof name === 'string' && name.trim()
      ? name.trim()
      : (req.user.name || req.user.email?.split('@')[0] || '').trim();
    const ticketEmail = req.user.email || email;
    if (
      !ticketName || ticketName.length > 100 ||
      typeof ticketEmail !== 'string' || !validEmail(ticketEmail.trim()) || ticketEmail.trim().length > 150 ||
      typeof subject !== 'string' || !subject.trim() || subject.trim().length > 200 ||
      !validateMessage(message) ||
      (order_id !== undefined && order_id !== null && order_id !== '' && !validId(order_id)) ||
      (product_id !== undefined && product_id !== null && product_id !== '' && !validId(product_id)) ||
      (product_id && !order_id)
    ) {
      return res.status(400).json({ success: false, message: 'Enter a valid name, email, subject, and message.' });
    }
    if (order_id) {
      const params = [order_id, req.user.id];
      const productClause = product_id ? 'AND oi.product_id = ?' : '';
      if (product_id) params.push(product_id);
      const [[purchase]] = await pool.query(
        `SELECT o.id FROM orders o
         ${product_id ? 'JOIN order_items oi ON oi.order_id = o.id' : ''}
         WHERE o.id = ? AND o.user_id = ? ${productClause}
         LIMIT 1`,
        params
      );
      if (!purchase) {
        return res.status(403).json({ success: false, message: 'The selected order or product does not belong to your account.' });
      }
    }

    const ticketId = await ContactModel.createTicket({
      user_id: req.user ? req.user.id : null,
      order_id: order_id || null,
      product_id: product_id || null,
      name: ticketName,
      email: ticketEmail.trim(),
      subject: subject.trim(),
      message: message.trim()
    });

    return res.status(201).json({
      success: true,
      message: 'Support ticket submitted successfully.',
      ticket_id: ticketId
    });
  } catch (error) {
    console.error('[CONTACT_CREATE]', error);
    return res.status(500).json({ success: false, message: 'Failed to submit ticket.' });
  }
});

router.get('/my', authenticateUser, async (req, res) => {
  try {
    const tickets = await ContactModel.getTicketsByUser(req.user.id);
    return res.json({ success: true, data: await attachMessages(tickets) });
  } catch (error) {
    console.error('[CONTACT_MY_TICKETS]', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch tickets.' });
  }
});

router.get('/', authenticateAdmin, async (req, res) => {
  try {
    const tickets = await ContactModel.getAllTickets();
    return res.json({ success: true, data: await attachMessages(tickets) });
  } catch (error) {
    console.error('[CONTACT_ADMIN_TICKETS]', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch all tickets.' });
  }
});

router.post('/:id/replies', authenticateUser, async (req, res) => {
  const { id } = req.params;
  const message = req.body?.message;
  if (!validId(id)) {
    return res.status(400).json({ success: false, message: 'Invalid ticket ID.' });
  }
  if (!validateMessage(message)) {
    return res.status(400).json({ success: false, message: 'Reply must contain 1–10000 characters.' });
  }
  try {
    const created = await ContactModel.createCustomerReply(Number(id), req.user.id, message.trim());
    if (!created) return res.status(404).json({ success: false, message: 'Support ticket not found.' });
    return res.status(201).json({ success: true, message: 'Reply sent.' });
  } catch (error) {
    console.error('[CONTACT_CUSTOMER_REPLY]', error);
    return res.status(500).json({ success: false, message: 'Failed to send reply.' });
  }
});

const updateTicketStatus = async (req, res) => {
  const { id } = req.params;
  const statusAliases = { pending: 'open', 'in-progress': 'in_progress' };
  const status = statusAliases[req.body?.status] || req.body?.status;
  const validStatuses = ['open', 'in_progress', 'resolved', 'closed'];
  const hasReply = Object.prototype.hasOwnProperty.call(req.body || {}, 'admin_reply');
  const reply = hasReply && typeof req.body.admin_reply === 'string' ? req.body.admin_reply.trim() : null;

  if (!validId(id)) return res.status(400).json({ success: false, message: 'Invalid ticket ID.' });
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ success: false, message: 'Invalid ticket status.' });
  }
  if (hasReply && typeof req.body.admin_reply !== 'string') {
    return res.status(400).json({ success: false, message: 'Reply must be text.' });
  }
  if (reply && reply.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({ success: false, message: 'Reply cannot exceed 10000 characters.' });
  }

  try {
    const [[ticket]] = reply
      ? await pool.query('SELECT id, name, email, subject FROM support_tickets WHERE id = ?', [id])
      : [[null]];
    if (reply && !ticket) return res.status(404).json({ success: false, message: 'Ticket not found.' });

    const updated = await ContactModel.updateTicketStatus(Number(id), status, reply || null);
    if (!updated) return res.status(404).json({ success: false, message: 'Ticket not found.' });

    let emailSent;
    let emailError;
    if (reply) {
      const supportUrl = 'https://www.bhumivera.com/profile?tab=support';
      const safeReply = escapeHtml(reply).replace(/\n/g, '<br>');
      const text = `Hello ${ticket.name},\n\nOur support team replied to "${ticket.subject}". Sign in to view the full conversation and reply: ${supportUrl}\n\n${reply}\n\nNeed help? WhatsApp: https://wa.me/917430985647 | Email: support@bhumivera.com\nBhumivera Concierge`;
      const html = `<!doctype html><html lang="en"><body style="margin:0;padding:32px 16px;background:#faf8f5;font-family:Arial,Helvetica,sans-serif;color:#1f2937"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;margin:0 auto;background:#fff;border:1px solid #e7e5e4;border-radius:12px;overflow:hidden"><tr><td style="padding:24px;text-align:center;border-bottom:3px solid #d4af37"><a href="https://www.bhumivera.com" style="text-decoration:none"><img src="https://www.bhumivera.com/logo.webp" width="56" height="56" alt="Bhumivera" style="display:block;margin:0 auto 8px;border:0"><span style="font-family:Georgia,serif;font-size:22px;font-weight:bold;letter-spacing:3px;color:#0b2419">BHUMIVERA</span></a><div style="margin-top:6px;font-size:11px;letter-spacing:1px;color:#8b5a2b">CUSTOMER CONCIERGE</div></td></tr><tr><td style="padding:32px"><h1 style="margin:0 0 18px;font-size:22px;color:#0b2419">Our team has replied</h1><p style="font-size:15px;line-height:1.7">Hello ${escapeHtml(ticket.name)}, we replied to your support request <strong>${escapeHtml(ticket.subject)}</strong>.</p><div style="margin:24px 0;padding:18px;border-left:4px solid #d4af37;background:#faf8f5;font-size:15px;line-height:1.7">${safeReply}</div><p style="font-size:14px;line-height:1.7">Sign in to view the full conversation and send a reply:</p><p style="text-align:center;margin:28px 0"><a href="${supportUrl}" style="display:inline-block;padding:14px 24px;border-radius:6px;background:#0b2419;color:#fff;text-decoration:none;font-weight:bold">Open support conversation</a></p></td></tr><tr><td style="padding:22px;background:#faf8f5;border-top:1px solid #e7e5e4;text-align:center;font-size:13px;line-height:1.8;color:#64748b">Need more help? <a href="https://wa.me/917430985647" style="color:#8b5a2b">Chat on WhatsApp</a> · <a href="mailto:support@bhumivera.com" style="color:#8b5a2b">Email support</a><br>© 2026 Bhumivera</td></tr></table></body></html>`;
      try {
        await sendMail({
          to: ticket.email,
          subject: `Bhumivera Support replied: ${ticket.subject.replace(/[\r\n]+/g, ' ')}`,
          text,
          html
        });
        emailSent = true;
      } catch (mailErrorDetail) {
        console.error('[CONTACT_REPLY_EMAIL]', mailErrorDetail.message);
        emailSent = false;
        emailError = 'Reply saved, but the customer email notification could not be sent. Please notify the customer manually.';
      }
    }

    return res.json({
      success: true,
      emailSent,
      emailError,
      message: reply ? 'Reply saved.' : `Ticket updated to ${status}.`
    });
  } catch (error) {
    console.error('[CONTACT_STATUS_UPDATE]', error);
    return res.status(500).json({ success: false, message: 'Failed to update ticket.' });
  }
};

router.patch('/:id/status', authenticateAdmin, updateTicketStatus);
router.put('/:id/status', authenticateAdmin, updateTicketStatus);

router.delete('/:id', authenticateAdmin, async (req, res) => {
  if (!validId(req.params.id)) {
    return res.status(400).json({ success: false, message: 'Invalid ticket ID.' });
  }
  try {
    const [result] = await pool.query('DELETE FROM support_tickets WHERE id = ?', [req.params.id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Ticket not found.' });
    }
    return res.json({ success: true, message: 'Ticket removed successfully.' });
  } catch (error) {
    console.error('[CONTACT_DELETE]', error);
    return res.status(500).json({ success: false, message: 'Failed to delete ticket.' });
  }
});

module.exports = router;
