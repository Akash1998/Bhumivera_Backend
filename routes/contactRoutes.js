const express = require('express');
const router = express.Router();
const { initContactTable, ContactModel } = require('../models/contactModel');
const { authenticateUser, authenticateAdmin } = require('../middleware/authMiddleware');
const { sendMail } = require('../utils/mail');

// Optional middleware to get user if they are logged in, but allow guests
const optionalAuth = (req, res, next) => {
  authenticateUser(req, res, (err) => {
    // We ignore the error here because guests are allowed to submit tickets
    next(); 
  });
};

// 1. SUBMIT A TICKET (Public / Authenticated Users)
router.post('/', optionalAuth, async (req, res) => {
  try {
    const { name, email, subject, message, order_id } = req.body;
    
    if (!name || !email || !subject || !message) {
      return res.status(400).json({ success: false, message: 'All fields are required.' });
    }

    const userId = req.user ? req.user.id : null;

    const ticketId = await ContactModel.createTicket({
      user_id: userId,
      order_id,
      name,
      email,
      subject,
      message
    });

    res.status(201).json({ 
      success: true, 
      message: 'Support ticket submitted successfully.', 
      ticket_id: ticketId 
    });
  } catch (error) {
    console.error("[Contact Error]:", error);
    res.status(500).json({ success: false, message: 'Failed to submit ticket.' });
  }
});

// 2. GET MY TICKETS (User Dashboard)
router.get('/my', authenticateUser, async (req, res) => {
  try {
    const tickets = await ContactModel.getTicketsByUser(req.user.id);
    res.json({ success: true, data: tickets });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch tickets.' });
  }
});

// 3. GET ALL TICKETS (Admin Dashboard)
router.get('/', authenticateAdmin, async (req, res) => {
  try {
    const tickets = await ContactModel.getAllTickets();
    res.json({ success: true, data: tickets });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch all tickets.' });
  }
});

// 4. REPLY & UPDATE TICKET STATUS (Admin Dashboard)
const updateTicketStatus = async (req, res) => {
  try {
    const statusAliases = { pending: 'open', 'in-progress': 'in_progress' };
    const status = statusAliases[req.body.status] || req.body.status;
    const { admin_reply } = req.body;
    const validStatuses = ['open', 'in_progress', 'resolved', 'closed'];
    const reply = typeof admin_reply === 'string' ? admin_reply.trim().slice(0, 10000) : null;

    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid ticket status.' });
    }

    const [[ticket]] = reply
      ? await require('../config/db').query('SELECT id, name, email, subject FROM support_tickets WHERE id = ?', [req.params.id])
      : [[null]];
    if (reply && !ticket) return res.status(404).json({ success: false, message: 'Ticket not found.' });

    const updated = await ContactModel.updateTicketStatus(req.params.id, status, reply);

    if (!updated) {
      return res.status(404).json({ success: false, message: 'Ticket not found.' });
    }

    let emailSent;
    if (reply) {
      const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
      try {
        await sendMail({
          to: ticket.email,
          subject: `Update to your Bhumivera support request: ${ticket.subject}`,
          text: `Hello ${ticket.name},\n\n${reply}\n\nBhumivera Support`,
          html: `<p>Hello ${escapeHtml(ticket.name)},</p><p>${escapeHtml(reply).replace(/\n/g, '<br>')}</p><p>Bhumivera Support</p>`
        });
        emailSent = true;
      } catch (mailError) {
        console.error('[CONTACT_REPLY_EMAIL]', mailError.message);
        emailSent = false;
      }
    }

    res.json({ success: true, emailSent, message: `Ticket updated to ${status}.` });
  } catch (error) {
    console.error('[CONTACT_STATUS_UPDATE]', error);
    res.status(500).json({ success: false, message: 'Failed to update ticket.' });
  }
};

router.patch('/:id/status', authenticateAdmin, updateTicketStatus);
router.put('/:id/status', authenticateAdmin, updateTicketStatus);

// 5. DELETE TICKET (Admin Dashboard)
router.delete('/:id', authenticateAdmin, async (req, res) => {
  try {
    const pool = require('../config/db');
    const [result] = await pool.query('DELETE FROM support_tickets WHERE id = ?', [req.params.id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Ticket not found.' });
    }

    res.json({ success: true, message: 'Ticket removed successfully.' });
  } catch (error) {
    console.error('[CONTACT_DELETE]', error);
    res.status(500).json({ success: false, message: 'Failed to delete ticket.' });
  }
});

module.exports = router;
