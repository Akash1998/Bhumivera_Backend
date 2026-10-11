const express = require('express');

const createHealthRouter = getReadiness => {
  const router = express.Router();
  router.get('/live', (req, res) => {
    res.status(200).json({ status: 'live' });
  });

  const sendReadiness = (req, res) => {
    const readiness = getReadiness();
    res.status(readiness.databaseReady ? 200 : 503).json({
      status: readiness.databaseReady ? 'ready' : 'starting',
      databaseReady: readiness.databaseReady,
      ...(readiness.failure ? { failure: readiness.failure } : {}),
    });
  };
  router.get('/ready', sendReadiness);
  router.get('/', sendReadiness);
  return router;
};

module.exports = { createHealthRouter };
