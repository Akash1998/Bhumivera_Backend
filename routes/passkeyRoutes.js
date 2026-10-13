const express = require('express');
const router = express.Router();

router.post('/register-challenge', (req, res) => {
  res.status(503).json({
    message: 'Passkey registration is not configured on this backend yet.',
    supported: false,
  });
});

router.post('/register-verify', (req, res) => {
  res.status(503).json({
    message: 'Passkey registration is not configured on this backend yet.',
    supported: false,
  });
});

router.post('/login-challenge', (req, res) => {
  res.status(503).json({
    message: 'Passkey login is not configured on this backend yet.',
    supported: false,
  });
});

router.post('/login-verify', (req, res) => {
  res.status(503).json({
    message: 'Passkey login is not configured on this backend yet.',
    supported: false,
  });
});

router.get('/list', (req, res) => {
  res.json({ passkeys: [] });
});

router.delete('/:id', (req, res) => {
  res.json({ message: 'Passkey removal is not configured on this backend yet.' });
});

module.exports = router;
