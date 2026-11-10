// backend/routes/subcategoryRoutes.js
// Subcategories: public listing + admin full control
const express = require('express');
const router = express.Router();
const {
  getAllSubcategories,
  getSubcategoryById,
  getSubcategoriesByCategory,
  createSubcategory,
  updateSubcategory,
  deleteSubcategory,
} = require('../models/subcategoryModel');
const { authenticateAdmin } = require('../middleware/authMiddleware');

// GET /api/subcategories  (public - all)
router.get('/', async (req, res) => {
  try {
    const subs = await getAllSubcategories();
    return res.json(subs);
  } catch (err) {
    console.error('Error fetching subcategories:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/subcategories/by-category/:categoryId  (public - filter by category)
router.get('/by-category/:categoryId', async (req, res) => {
  try {
    const subs = await getSubcategoriesByCategory(req.params.categoryId);
    return res.json(subs);
  } catch (err) {
    console.error('Error fetching subcategories by category:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/subcategories/:id  (public)
router.get('/:id', async (req, res) => {
  try {
    const sub = await getSubcategoryById(req.params.id);
    if (!sub) return res.status(404).json({ message: 'Not found' });
    return res.json(sub);
  } catch (err) {
    console.error('Error fetching subcategory:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/subcategories  (admin)
router.post('/', authenticateAdmin, async (req, res) => {
  try {
    const { name, category_id, description } = req.body;
    if (!name || !category_id) {
      return res.status(400).json({ message: 'Name and category_id are required' });
    }
    const newSub = await createSubcategory({ name, category_id, description });
    return res.status(201).json(newSub);
  } catch (err) {
    console.error('Error creating subcategory:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// PUT /api/subcategories/:id  (admin)
router.put('/:id', authenticateAdmin, async (req, res) => {
  try {
    const { name, category_id, description } = req.body;
    if (!name || !category_id) {
      return res.status(400).json({ message: 'Name and category_id are required' });
    }
    const updated = await updateSubcategory(req.params.id, { name, category_id, description });
    return res.json(updated);
  } catch (err) {
    console.error('Error updating subcategory:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// DELETE /api/subcategories/:id  (admin)
router.delete('/:id', authenticateAdmin, async (req, res) => {
  try {
    await deleteSubcategory(req.params.id);
    return res.json({ message: 'Subcategory deleted' });
  } catch (err) {
    console.error('Error deleting subcategory:', err);
    const status = err.status || 500;
    return res.status(status).json({ message: err.message || 'Server error' });
  }
});

module.exports = router;
