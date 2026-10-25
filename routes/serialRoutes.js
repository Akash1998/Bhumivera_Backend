const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const { authenticateAdmin } = require("../middleware/authMiddleware");
const {
  getAllSerials,
  addProductSerials,
  getProductSerials,
  getProductSerialStats,
  updateProductSerial,
  deleteProductSerial,
} = require("../models/serialModel");
const {
  createProductBatch,
  getProductBatch,
  getPublicProductVerification,
  listProductBatches,
  updateProductBatchDetails,
} = require("../models/productBatchModel");

// GET /api/serials/verify/:serial - public lookup backed only by issued batch records
router.get("/verify/:serial", async (req, res) => {
  try {
    const verification = await getPublicProductVerification(req.params.serial);
    if (!verification) {
      return res.status(404).json({
        success: true,
        verified: false,
        message: "This code is not in the Bhumivera batch registry. Check the code or contact customer care.",
      });
    }
    res.json({ success: true, ...verification });
  } catch (err) {
    console.error("[SERIAL_VERIFY_ERROR]:", err);
    res.status(err.status || 500).json({ success: false, verified: false, message: err.message });
  }
});

// POST /api/serials/validate - Public validation of serial authenticity
router.post("/validate", async (req, res) => {
  try {
    const { serial } = req.body;
    if (!serial || typeof serial !== 'string' || !serial.trim()) {
      return res.status(400).json({ success: false, valid: false, message: "Serial number is required." });
    }
    const verification = await getPublicProductVerification(serial);
    res.json({
      success: true,
      valid: Boolean(verification),
      ...(verification || { message: "This code is not in the Bhumivera batch registry." }),
    });
  } catch (err) {
    console.error("[SERIAL_VALIDATE_ERROR]:", err);
    res.status(err.status || 500).json({ success: false, valid: false, message: err.message });
  }
});

router.get("/admin/batches", authenticateAdmin, async (_req, res) => {
  try {
    res.json({ success: true, batches: await listProductBatches() });
  } catch (err) {
    console.error("[PRODUCT_BATCH_LIST_ERROR]:", err);
    res.status(500).json({ success: false, message: "Could not load product batches." });
  }
});

router.get("/admin/batches/:batchId", authenticateAdmin, async (req, res) => {
  try {
    const batch = await getProductBatch(req.params.batchId);
    if (!batch) return res.status(404).json({ success: false, message: "Batch not found." });
    res.json({ success: true, batch });
  } catch (err) {
    console.error("[PRODUCT_BATCH_DETAIL_ERROR]:", err);
    res.status(500).json({ success: false, message: "Could not load this product batch." });
  }
});

router.post("/admin/batches", authenticateAdmin, async (req, res) => {
  try {
    const batch = await createProductBatch(req.body || {});
    res.status(201).json({ success: true, batch });
  } catch (err) {
    console.error("[PRODUCT_BATCH_CREATE_ERROR]:", err);
    res.status(err.status || 500).json({ success: false, message: err.message || "Could not generate this product batch." });
  }
});

router.patch("/admin/batches/:batchId/details", authenticateAdmin, async (req, res) => {
  try {
    const details = await updateProductBatchDetails(req.params.batchId, req.body?.details);
    res.json({ success: true, details });
  } catch (err) {
    console.error("[PRODUCT_BATCH_DETAILS_UPDATE_ERROR]:", err);
    res.status(err.status || 500).json({ success: false, message: err.message || "Could not update batch details." });
  }
});

// GET /api/serials/admin/all - View all serial numbers across all products
router.get("/admin/all", authenticateAdmin, async (req, res) => {
  try {
    const serials = await getAllSerials();
    res.json({ success: true, serials });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/serials/admin/:serialId - admin purge by serial PK id (registered BEFORE /:productId/:serialId to prevent route shadowing)
router.delete("/admin/:serialId", authenticateAdmin, async (req, res) => {
  try {
    const serialId = req.params.serialId;
    const [existing] = await pool.query(
      `SELECT ps.id, ps.product_id, ps.serial_number, ps.status, wr.id AS warranty_id
       FROM product_serials ps
       LEFT JOIN warranty_registrations wr ON ps.serial_number = wr.registered_serial
       WHERE ps.id = ?`,
      [serialId]
    );
    if (!existing || existing.length === 0) {
      return res.status(404).json({ success: false, message: "Serial not found" });
    }
    const row = existing[0];
    if (row.warranty_id || (row.status && row.status.toLowerCase() === 'registered')) {
      return res.status(400).json({
        success: false,
        message: "Serial is already registered under warranty. Cancel warranty registration first."
      });
    }
    const [del] = await pool.query(`DELETE FROM product_serials WHERE id = ?`, [serialId]);
    if (del.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Serial not found" });
    }
    res.json({ success: true, deleted: serialId });
  } catch (err) {
    console.error('[SERIAL ADMIN DELETE ERROR]:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/serials/:productId - list all serials for a product
router.get("/:productId", async (req, res) => {
  try {
    const serials = await getProductSerials(req.params.productId);
    res.json({ success: true, serials });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

// GET /api/serials/:productId/stats - get summary stats
router.get("/:productId/stats", async (req, res) => {
  try {
    const stats = await getProductSerialStats(req.params.productId);
    res.json({ success: true, stats });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

// POST /api/serials/generate - Advanced Pro Generator
router.post("/generate", authenticateAdmin, async (req, res) => {
  res.status(410).json({
    success: false,
    message: "Use the Authenticity & Batch Registry to generate batch-linked product codes and printable QR labels.",
  });
});

// POST /api/serials/:productId/add - manually add serials
router.post("/:productId/add", authenticateAdmin, async (req, res) => {
  try {
    const { serials, base_warranty_months } = req.body;
    const warrantyMonths = base_warranty_months ? parseInt(base_warranty_months, 10) : null;
    const result = await addProductSerials(req.params.productId, serials, warrantyMonths);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/serials/:productId/:serialId - update single serial
router.patch("/:productId/:serialId", authenticateAdmin, async (req, res) => {
  try {
    const { serial_number } = req.body;
    const result = await updateProductSerial(req.params.productId, req.params.serialId, serial_number);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/serials/:productId/:serialId - remove single serial
router.delete("/:productId/:serialId", authenticateAdmin, async (req, res) => {
  try {
    const result = await deleteProductSerial(req.params.productId, req.params.serialId);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
