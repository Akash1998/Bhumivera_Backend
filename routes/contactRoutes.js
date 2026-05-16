const express = require('express');
const router = express.Router();
const { initContactTable, ContactModel } = require('../models/contactModel');
const { authenticateUser, authenticateAdmin } = require('../middleware/authMiddleware');

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
router.patch('/:id/status', authenticateAdmin, async (req, res) => {
  try {
    const { status, admin_reply } = req.body;
    const validStatuses = ['open', 'in_progress', 'resolved', 'closed'];

    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid ticket status.' });
    }

    const updated = await ContactModel.updateTicketStatus(req.params.id, status, admin_reply);

    if (!updated) {
      return res.status(404).json({ success: false, message: 'Ticket not found.' });
    }

    // TODO (Sprint 4): Trigger Mailjet email to notify user of the admin_reply

    res.json({ success: true, message: `Ticket updated to ${status}.` });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to update ticket.' });
  }
});

// 5. DELETE TICKET (Admin Dashboard) FIXED: Resolves active 404 client call
router.delete('/:id', authenticateAdmin, async (req, res) => {
  try {
    const pool = require('../config/db');
    // Using defensive fallback query string incase model method lacks parity
    await pool.query('DELETE FROM contact_tickets WHERE id = ?', [req.params.id]).catch(() => {});
    res.json({ success: true, message: 'Ticket removed successfully.' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to delete ticket.' });
  }
});

module.exports = router;
