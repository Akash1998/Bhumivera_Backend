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
    const id = await createCategory(req.body);
    res.status(201).json({ id, message: 'Category created' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.put('/:id', authenticateAdmin, async (req, res) => {
  try {
    await updateCategory(req.params.id, req.body);
    res.json({ message: 'Category updated' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.delete('/:id', authenticateAdmin, async (req, res) => {
  try {
    await deleteCategory(req.params.id);
    res.json({ message: 'Category deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
