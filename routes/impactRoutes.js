const express = require('express');
const pool = require('../config/db');
const { authenticateAdmin } = require('../middleware/authMiddleware');
const { initImpactTables, getPublicImpact, getAllContributions, getAllImpactUpdates } = require('../models/impactModel');

const router = express.Router();
const PROJECTS = new Set(['native-trees', 'river-care', 'community-care']);
const safeMediaUrl = value => {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
};

router.get('/public', async (req, res) => {
  try {
    await initImpactTables();
    res.json(await getPublicImpact());
  } catch (error) {
    console.error('[IMPACT_PUBLIC]', error);
    res.status(500).json({ message: 'Unable to load the verified impact ledger.' });
  }
});

router.get('/admin/contributions', authenticateAdmin, async (req, res) => {
  try {
    await initImpactTables();
    res.json({ contributions: await getAllContributions() });
  } catch (error) {
    console.error('[IMPACT_CONTRIBUTIONS]', error);
    res.status(500).json({ message: 'Unable to load contributions.' });
  }
});

router.patch('/admin/contributions/:id/collected', authenticateAdmin, async (req, res) => {
  const reference = typeof req.body?.collectionReference === 'string' ? req.body.collectionReference.trim().slice(0, 255) : '';
  if (reference.length < 2) return res.status(400).json({ message: 'A collection receipt or reconciliation reference is required.' });

  let connection;
  try {
    await initImpactTables();
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [rows] = await connection.query(
      `SELECT ic.status, o.status AS order_status, o.payment_mode
       FROM impact_contributions ic JOIN orders o ON o.id = ic.order_id
       WHERE ic.id = ? FOR UPDATE`,
      [req.params.id]
    );
    const contribution = rows[0];
    if (!contribution) {
      await connection.rollback();
      return res.status(404).json({ message: 'Contribution not found.' });
    }
    if (contribution.status !== 'pledged' || contribution.order_status !== 'delivered' || contribution.payment_mode !== 'COD') {
      await connection.rollback();
      return res.status(409).json({ message: 'Only an uncollected contribution on a delivered COD order can be reconciled.' });
    }
    await connection.query(
      `UPDATE impact_contributions SET status = 'collected', collection_reference = ?, collected_at = NOW()
       WHERE id = ? AND status = 'pledged'`,
      [reference, req.params.id]
    );
    await connection.commit();
    res.json({ success: true, message: 'Contribution collection recorded.' });
  } catch (error) {
    if (connection) await connection.rollback().catch(() => {});
    console.error('[IMPACT_COLLECTION]', error);
    res.status(500).json({ message: 'Unable to reconcile the contribution.' });
  } finally {
    connection?.release();
  }
});

router.get('/admin/updates', authenticateAdmin, async (req, res) => {
  try {
    await initImpactTables();
    res.json({ updates: await getAllImpactUpdates() });
  } catch (error) {
    console.error('[IMPACT_UPDATES_ADMIN]', error);
    res.status(500).json({ message: 'Unable to load field updates.' });
  }
});

router.post('/admin/updates', authenticateAdmin, async (req, res) => {
  const { projectKey, title, summary, fieldDate } = req.body || {};
  const photoUrl = safeMediaUrl(req.body?.photoUrl);
  const videoUrl = safeMediaUrl(req.body?.videoUrl);
  if (!PROJECTS.has(projectKey) || typeof title !== 'string' || !title.trim() || typeof summary !== 'string' || !summary.trim()) {
    return res.status(400).json({ message: 'Choose a project and provide a report title and field summary.' });
  }
  if (!photoUrl && !videoUrl) return res.status(400).json({ message: 'Add at least one secure photo or video link as evidence.' });
  if (req.body?.verified !== true) return res.status(400).json({ message: 'Confirm that this report documents completed, on-ground work.' });

  try {
    await initImpactTables();
    const [result] = await pool.query(
      `INSERT INTO impact_updates (project_key, title, summary, field_date, photo_url, video_url, verified_by, verified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
      [projectKey, title.trim().slice(0, 180), summary.trim(), fieldDate || null, photoUrl, videoUrl, req.admin.id]
    );
    res.status(201).json({ success: true, id: result.insertId });
  } catch (error) {
    console.error('[IMPACT_UPDATE_CREATE]', error);
    res.status(500).json({ message: 'Unable to publish the field report.' });
  }
});

module.exports = router;