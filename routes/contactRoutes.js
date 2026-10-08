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

const optionalAuth = (req, res, next) => {
  if (!req.headers.authorization) return next();
  return authenticateUser(req, res, next);
};

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

router.post('/', optionalAuth, async (req, res) => {
  try {
    const { name, email, subject, message, order_id } = req.body;
    const ticketEmail = req.user?.email || email;
    if (
      typeof name !== 'string' || !name.trim() || name.trim().length > 100 ||
      typeof ticketEmail !== 'string' || !validEmail(ticketEmail.trim()) || ticketEmail.trim().length > 150 ||
      typeof subject !== 'string' || !subject.trim() || subject.trim().length > 200 ||
      !validateMessage(message) ||
      (order_id !== undefined && order_id !== null && order_id !== '' && !validId(order_id))
    ) {
      return res.status(400).json({ success: false, message: 'Enter a valid name, email, subject, and message.' });
    }

    const ticketId = await ContactModel.createTicket({
      user_id: req.user ? req.user.id : null,
      order_id: order_id || null,
      name: name.trim(),
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
      const text = `Hello ${ticket.name},\n\nOur support team has replied to your request "${ticket.subject}". Sign in to the Bhumivera app and open Profile > Support to read the reply and continue the conversation.\n\n${reply}\n\nBhumivera Support\nsupport@bhumivera.com`;
      const html = `<p>Hello ${escapeHtml(ticket.name)},</p><p>Our support team has replied to your request <strong>${escapeHtml(ticket.subject)}</strong>. Sign in to the Bhumivera app and open <strong>Profile &gt; Support</strong> to read the reply and continue the conversation.</p><blockquote>${escapeHtml(reply).replace(/\n/g, '<br>')}</blockquote><p>Bhumivera Support<br><a href="mailto:support@bhumivera.com">support@bhumivera.com</a></p>`;
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
