const express = require('express');

const createHealthRouter = (getReadiness, ensureReady = null) => {
  const router = express.Router();
  router.get('/live', (req, res) => {
    res.status(200).json({ status: 'live' });
  });

  const sendReadiness = async (req, res, next) => {
    try {
      if (ensureReady) await ensureReady();
    } catch (error) {
      return next(error);
    }
    const readiness = getReadiness();
    return res.status(readiness.databaseReady ? 200 : 503).json({
      status: readiness.databaseReady ? 'ready' : 'starting',
      databaseReady: readiness.databaseReady,
      ...(readiness.phase ? { phase: readiness.phase } : {}),
      ...(readiness.failure ? { failure: readiness.failure } : {}),
    });
  };
  router.get('/ready', sendReadiness);
  router.get('/', sendReadiness);
  return router;
};

module.exports = { createHealthRouter };
