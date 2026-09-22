const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const excel = require("exceljs");
const pool = require("../config/db");
const { authenticateAdmin } = require("../middleware/authMiddleware");
const {
  getAllSerials,
  addProductSerials,
  getProductSerials,
  getProductSerialStats,
  updateProductSerial,
  deleteProductSerial,
  checkSerialAvailability,
} = require("../models/serialModel");

const generateChecksum = (baseString) => {
  let sum = 0;
  for (let i = 0; i < baseString.length; i++) sum += baseString.charCodeAt(i);
  return sum.toString(36).toUpperCase().slice(-1);
};

// GET /api/serials/admin/all - View all serial numbers across all products
router.get("/admin/all", authenticateAdmin, async (req, res) => {
  try {
    const serials = await getAllSerials();
    res.json({ success: true, serials });
  } catch (err) {
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
  try {
    const { productId, count, prefix, format = "advanced", base_warranty_months } = req.body;
    
    if (!productId || !count) {
      return res.status(400).json({ success: false, message: "Product ID and count required" });
    }

    const warrantyMonths = base_warranty_months ? parseInt(base_warranty_months, 10) : null;
    const generatedSerials = new Set();
    
    while (generatedSerials.size < count) {
      let newSerial = "";
      if (format === "legacy") {
        const pfx = prefix ? prefix.toUpperCase().slice(0, 3) : "ANR";
        newSerial = `${pfx}${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
      } else {
        const pfx = prefix ? prefix.toUpperCase().slice(0, 4).padEnd(4, 'X') : "ANRI";
        const date = new Date();
        const yy = String(date.getFullYear()).slice(-2);
        const mm = String(date.getMonth() + 1).padStart(2, '0');
        const randomPart = crypto.randomBytes(4).toString("hex").toUpperCase().slice(0, 6);
        const baseSerial = `${pfx}-${yy}${mm}-${randomPart}`;
        const checksum = generateChecksum(baseSerial);
        newSerial = `${baseSerial}-${checksum}`;
      }
      generatedSerials.add(newSerial);
    }

    const result = await addProductSerials(productId, Array.from(generatedSerials), warrantyMonths);
    res.json({ success: true, count: generatedSerials.size, result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
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
