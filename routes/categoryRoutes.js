// backend/routes/categoryRoutes.js
// Categories: public listing + admin full control
const express = require('express');
const router = express.Router();
const {
  getAllCategories,
  getCategoryById,
  createCategory,
  updateCategory,
  deleteCategory,
  getCategoryAuditHistory,
} = require('../models/categoryModel');
const { authenticateAdmin } = require('../middleware/authMiddleware');

// GET /api/categories (public)
router.get('/', async (req, res) => {
  try {
    const categories = await getAllCategories();
    return res.json({ success: true, data: categories });
  } catch (err) {
    console.error('Error fetching categories:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

router.get('/admin/audit', authenticateAdmin, async (req, res) => {
  const requestedLimit = req.query.limit === undefined ? 30 : Number(req.query.limit);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) {
    return res.status(400).json({ code: 'INVALID_AUDIT_LIMIT', message: 'Audit limit must be between 1 and 100.' });
  }
  try {
    const events = await getCategoryAuditHistory(requestedLimit);
    return res.json({ success: true, data: events });
  } catch (err) {
    console.error('Error fetching category audit history:', err);
    return res.status(500).json({ message: 'Could not load category audit history.' });
  }
});

// GET /api/categories/:id (public)
router.get('/:id', async (req, res) => {
  try {
    const category = await getCategoryById(req.params.id);
    if (!category) return res.status(404).json({ message: 'Not found' });
    return res.json({ success: true, data: category });
  } catch (err) {
    console.error('Error fetching category:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// ADMIN ROUTES
router.post('/', authenticateAdmin, async (req, res) => {
  try {
    const id = await createCategory(req.body, req.admin);
    res.status(201).json({ id, message: 'Category created' });
  } catch (err) {
    if (err.code === 'INVALID_CATEGORY') {
      return res.status(400).json({ code: err.code, message: err.message });
    }
    console.error('Error creating category:', err);
    res.status(500).json({ message: 'Could not create category.' });
  }
});

router.put('/:id', authenticateAdmin, async (req, res) => {
  try {
    await updateCategory(req.params.id, req.body, req.admin);
    res.json({ message: 'Category updated' });
  } catch (err) {
    if (err.code === 'INVALID_CATEGORY') {
      return res.status(400).json({ code: err.code, message: err.message });
    }
    if (err.code === 'CATEGORY_NOT_FOUND') {
      return res.status(404).json({ code: err.code, message: err.message });
    }
    console.error('Error updating category:', err);
    res.status(500).json({ message: 'Could not update category.' });
  }
});

router.delete('/:id', authenticateAdmin, async (req, res) => {
  try {
    await deleteCategory(req.params.id, req.admin);
    res.json({ message: 'Category deleted' });
  } catch (err) {
    if (err.code === 'CATEGORY_NOT_FOUND') {
      return res.status(404).json({ code: err.code, message: err.message });
    }
    console.error('Error deleting category:', err);
    res.status(500).json({ message: 'Could not delete category.' });
  }
});

module.exports = router;
