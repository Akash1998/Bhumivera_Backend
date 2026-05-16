const express = require('express');
const router = express.Router();
const { authenticateUser, authenticateAdmin } = require('../middleware/authMiddleware');
const { createNotification, logSystemEvent, getNotificationsForUser, markAsRead, countUnread, getAllNotifications, deleteNotification } = require('../models/notificationModel');

// POST /api/notifications/system-log - System ingestion endpoint for F12 crashes and SQL errors
router.post('/system-log', async (req, res) => {
  try {
    const { title, message, type } = req.body;
    await logSystemEvent(title || 'System Alert', message || 'Unknown error occurred', type || 'error');
    res.status(201).json({ message: 'Telemetry log recorded' });
  } catch (err) {
    console.error('Failed to write telemetry log', err);
    res.status(500).json({ message: 'Log failed' });
  }
});

// GET /api/notifications - user: get own + global notifications
router.get('/', authenticateUser, async (req, res) => {
  try {
    const notifications = await getNotificationsForUser(req.user.id);
    // Normalize field: map is_read -> read for frontend compatibility
    const normalized = notifications.map(n => ({ ...n, read: !!n.is_read, _id: String(n.id) }));
    res.json(normalized);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to get notifications' });
  }
});

// GET /api/notifications/unread-count - user: unread count
router.get('/unread-count', authenticateUser, async (req, res) => {
  try {
    const count = await countUnread(req.user.id);
    res.json({ count });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to get unread count' });
  }
});

// PUT /api/notifications/read-all - mark all as read (frontend alias)
router.put('/read-all', authenticateUser, async (req, res) => {
  try {
    await markAsRead(req.user.id);
    res.json({ message: 'All notifications marked as read' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to mark as read' });
  }
});

// PUT /api/notifications/mark-read - legacy alias
router.put('/mark-read', authenticateUser, async (req, res) => {
  try {
    await markAsRead(req.user.id);
    res.json({ message: 'All notifications marked as read' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to mark as read' });
  }
});

// PUT /api/notifications/:id/read - mark one as read (frontend alias)
router.put('/:id/read', authenticateUser, async (req, res) => {
  try {
    await markAsRead(req.user.id, req.params.id);
    res.json({ message: 'Notification marked as read' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to mark as read' });
  }
});

// PUT /api/notifications/:id/mark-read - legacy alias
router.put('/:id/mark-read', authenticateUser, async (req, res) => {
  try {
    await markAsRead(req.user.id, req.params.id);
    res.json({ message: 'Notification marked as read' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to mark as read' });
  }
});

// GET /api/notifications/admin/all - admin: all notifications (The Heart)
router.get('/admin/all', authenticateAdmin, async (req, res) => {
  try {
    const notifications = await getAllNotifications();
    res.json(notifications);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to get notifications' });
  }
});

// POST /api/notifications/admin/create - admin: create notification
router.post('/admin/create', authenticateAdmin, async (req, res) => {
  try {
    const id = await createNotification(req.body);
    res.status(201).json({ message: 'Notification created', id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to create notification' });
  }
});

// DELETE /api/notifications/:id - delete a notification
router.delete('/:id', authenticateUser, async (req, res) => {
  try {
    await deleteNotification(req.params.id, req.user.id);
    res.json({ message: 'Notification deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to delete notification' });
  }
});

module.exports = router;
