const express = require('express');
const path = require('path');
const router = express.Router();

// Serve warehouse app at /warehouse
router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/warehouse.html'));
});

module.exports = router;
