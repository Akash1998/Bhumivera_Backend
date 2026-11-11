const crypto = require('crypto');
const pool = require('../config/db');

const MAX_BATCH_SIZE = 1000;
const MAX_BATCH_DETAILS = 40;
const MAX_DETAIL_VALUE_LENGTH = 2000;

const isIsoDate = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

const normalizeDetails = details => {
  if (!Array.isArray(details) || details.length > MAX_BATCH_DETAILS) {
    throw Object.assign(new Error(`Batch details must contain at most ${MAX_BATCH_DETAILS} entries.`), { status: 400 });
  }

  const labels = new Set();
  return details.reduce((normalized, item) => {
    if (!item || typeof item.label !== 'string' || typeof item.value !== 'string') {
      throw Object.assign(new Error('Each batch detail requires a text label and value.'), { status: 400 });
    }
    const label = item.label.trim();
    const value = item.value.trim();
    if (!label || label.length > 100 || value.length > MAX_DETAIL_VALUE_LENGTH) {
      throw Object.assign(new Error('Batch detail labels must be 1–100 characters and values at most 2000 characters.'), { status: 400 });
    }
    if (!value) return normalized;

    const normalizedLabel = label.toLowerCase();
    if (labels.has(normalizedLabel)) {
      throw Object.assign(new Error(`Duplicate batch detail label: ${label}.`), { status: 400 });
    }
    labels.add(normalizedLabel);
    normalized.push({ label, value, visible: item.visible !== false });
    return normalized;
  }, []);
};

const createProductBatch = async ({ productId, count, prefix = 'BHMV', manufactureDate, expiryDate, details = [] }) => {
  const normalizedProductId = Number(productId);
  const normalizedCount = Number(count);
  const normalizedPrefix = String(prefix).trim().toUpperCase();

  if (!Number.isSafeInteger(normalizedProductId) || normalizedProductId < 1) {
    throw Object.assign(new Error('Choose a valid product.'), { status: 400 });
  }
  if (!Number.isSafeInteger(normalizedCount) || normalizedCount < 1 || normalizedCount > MAX_BATCH_SIZE) {
    throw Object.assign(new Error(`Batch quantity must be between 1 and ${MAX_BATCH_SIZE}.`), { status: 400 });
  }
  if (!/^[A-Z0-9]{2,8}$/.test(normalizedPrefix)) {
    throw Object.assign(new Error('Batch prefix must be 2–8 letters or numbers.'), { status: 400 });
  }
  if (!isIsoDate(manufactureDate) || !isIsoDate(expiryDate) || expiryDate <= manufactureDate) {
    throw Object.assign(new Error('Enter valid manufacture and expiry dates; expiry must be after manufacture.'), { status: 400 });
  }

  const normalizedDetails = normalizeDetails(details);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [products] = await connection.query(
      'SELECT id, name, sku FROM products WHERE id = ? FOR UPDATE',
      [normalizedProductId]
    );
    if (!products.length) {
      throw Object.assign(new Error('Product not found.'), { status: 404 });
    }

    const dateStamp = manufactureDate.slice(2, 4) + manufactureDate.slice(5, 7);
    let batchNumber;
    let batchResult;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      batchNumber = `${normalizedPrefix}-${dateStamp}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
      try {
        [batchResult] = await connection.query(
          `INSERT INTO product_batches
            (product_id, batch_number, manufacture_date, expiry_date, unit_count, details)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            normalizedProductId,
            batchNumber,
            manufactureDate,
            expiryDate,
            normalizedCount,
            JSON.stringify(normalizedDetails),
          ]
        );
        break;
      } catch (error) {
        if (error.code !== 'ER_DUP_ENTRY' || attempt === 4) throw error;
      }
    }

    const serials = new Set();
    while (serials.size < normalizedCount) {
      serials.add(`${normalizedPrefix}-${dateStamp}-${crypto.randomBytes(12).toString('hex').toUpperCase()}`);
    }

    const rows = [...serials].map(serial => [normalizedProductId, batchResult.insertId, serial, 0]);
    for (let offset = 0; offset < rows.length; offset += 500) {
      await connection.query(
        'INSERT INTO product_serials (product_id, batch_id, serial_number, is_legacy) VALUES ?',
        [rows.slice(offset, offset + 500)]
      );
    }

    await connection.commit();
    return {
      id: batchResult.insertId,
      productId: normalizedProductId,
      productName: products[0].name,
      sku: products[0].sku,
      batchNumber,
      manufactureDate,
      expiryDate,
      unitCount: normalizedCount,
      details: normalizedDetails,
      serials: [...serials],
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
};

const parseDetails = value => {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const details = JSON.parse(value);
    return Array.isArray(details) ? details : [];
  } catch {
    return [];
  }
};

const listProductBatches = async () => {
  const [rows] = await pool.query(`
    SELECT b.id, b.product_id, b.batch_number, b.manufacture_date, b.expiry_date,
           b.unit_count, b.details, b.created_at, p.name AS product_name, p.sku,
           (SELECT COUNT(*) FROM product_serials ps WHERE ps.batch_id = b.id) AS generated_count
    FROM product_batches b
    JOIN products p ON p.id = b.product_id
    ORDER BY b.created_at DESC, b.id DESC
  `);
  return rows.map(row => ({
    ...row,
    details: parseDetails(row.details),
    unit_count: Number(row.unit_count),
    generated_count: Number(row.generated_count),
  }));
};

const getProductBatch = async batchId => {
  const [batches] = await pool.query(
    `SELECT b.id, b.product_id, b.batch_number, b.manufacture_date, b.expiry_date,
            b.unit_count, b.details, b.created_at, p.name AS product_name, p.sku
     FROM product_batches b
     JOIN products p ON p.id = b.product_id
     WHERE b.id = ?`,
    [batchId]
  );
  if (!batches.length) return null;

  const [serialRows] = await pool.query(
    'SELECT serial_number, status FROM product_serials WHERE batch_id = ? ORDER BY id',
    [batchId]
  );
  return {
    ...batches[0],
    details: parseDetails(batches[0].details),
    serials: serialRows,
  };
};

const updateProductBatchDetails = async (batchId, details) => {
  const normalizedDetails = normalizeDetails(details);
  const [result] = await pool.query(
    'UPDATE product_batches SET details = ? WHERE id = ?',
    [JSON.stringify(normalizedDetails), batchId]
  );
  if (!result.affectedRows) {
    throw Object.assign(new Error('Batch not found.'), { status: 404 });
  }
  return normalizedDetails;
};

const generateSerialSequence = (seed, totalCount, prefixFallback) => {
  const serials = [];
  const cleanSeed = String(seed || '').trim().toUpperCase();

  if (!cleanSeed) {
    const dateStamp = new Date().toISOString().slice(2, 7).replace('-', '');
    while (serials.length < totalCount) {
      const rand = crypto.randomBytes(12).toString('hex').toUpperCase();
      serials.push(`${prefixFallback || 'BHMV'}-${dateStamp}-${rand}`);
    }
    return serials;
  }

  if (totalCount <= 1) {
    return [cleanSeed];
  }

  // Pure numeric seed: e.g. "123456"
  if (/^\d+$/.test(cleanSeed)) {
    const startNum = BigInt(cleanSeed);
    const padLen = cleanSeed.length;
    for (let i = 0; i < totalCount; i++) {
      const nextNum = (startNum + BigInt(i)).toString().padStart(padLen, '0');
      serials.push(nextNum);
    }
    return serials;
  }

  // Alphanumeric with trailing digits: e.g. "BV-SB001" or "BATCH1-01"
  const trailingDigitsMatch = cleanSeed.match(/^(.*?)(\d+)$/);
  if (trailingDigitsMatch) {
    const prefix = trailingDigitsMatch[1];
    const numPart = trailingDigitsMatch[2];
    const startNum = BigInt(numPart);
    const padLen = numPart.length;
    for (let i = 0; i < totalCount; i++) {
      const nextNum = (startNum + BigInt(i)).toString().padStart(padLen, '0');
      serials.push(`${prefix}${nextNum}`);
    }
    return serials;
  }

  // Prefix without trailing digits or empty: e.g. "BV-SBFW" or ""
  const pfx = cleanSeed || prefixFallback || 'BHMV';
  const padLen = Math.max(3, String(totalCount).length);
  for (let i = 1; i <= totalCount; i++) {
    serials.push(`${pfx}-${String(i).padStart(padLen, '0')}`);
  }
  return serials;
};

const createGenuinitySerialQR = async ({
  productId,
  count = 1,
  serialNumber,
  batchNumber,
  bottleSequence,
  manufactureDate,
  expiryDate,
  calibratedPh,
  extractionTemp,
  microbiologicalAssay,
  heavyMetals,
  disclosedActives,
  tamperCustody,
  originLot,
  details = []
}) => {
  const normalizedProductId = Number(productId);
  if (!Number.isSafeInteger(normalizedProductId) || normalizedProductId < 1) {
    throw Object.assign(new Error('Choose a valid product.'), { status: 400 });
  }

  const normalizedCount = Number(count);
  if (!Number.isSafeInteger(normalizedCount) || normalizedCount < 1 || normalizedCount > MAX_BATCH_SIZE) {
    throw Object.assign(new Error(`QR quantity must be between 1 and ${MAX_BATCH_SIZE}.`), { status: 400 });
  }

  // Manufacture and expiry dates
  const todayIso = new Date().toISOString().slice(0, 10);
  const mfg = (manufactureDate && isIsoDate(manufactureDate)) ? manufactureDate : todayIso;
  let exp = (expiryDate && isIsoDate(expiryDate)) ? expiryDate : null;
  if (!exp || exp <= mfg) {
    const d = new Date(mfg);
    d.setFullYear(d.getFullYear() + 2);
    exp = d.toISOString().slice(0, 10);
  }

  // Assemble full details list
  const structuredDetails = Array.isArray(details) ? [...details] : [];
  const addIfPresent = (lbl, val) => {
    if (val && typeof val === 'string' && val.trim()) {
      const idx = structuredDetails.findIndex(d => (d.label || '').toLowerCase() === lbl.toLowerCase());
      if (idx >= 0) {
        structuredDetails[idx].value = val.trim();
        structuredDetails[idx].visible = true;
      } else {
        structuredDetails.push({ label: lbl, value: val.trim(), visible: true });
      }
    }
  };

  addIfPresent('Bottle Sequence', bottleSequence);
  addIfPresent('Calibrated pH Assay', calibratedPh);
  addIfPresent('Cold-Press Extraction Temp', extractionTemp);
  addIfPresent('Microbiological Assay', microbiologicalAssay);
  addIfPresent('Heavy Metal Screen (ICP-MS)', heavyMetals);
  addIfPresent('100% Disclosed Active Profile', disclosedActives);
  addIfPresent('Artisanal Tamper Custody', tamperCustody);
  addIfPresent('Botanical Origin & Lot', originLot);

  const normalizedDetails = normalizeDetails(structuredDetails);

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [products] = await connection.query(
      'SELECT id, name, sku FROM products WHERE id = ? FOR UPDATE',
      [normalizedProductId]
    );
    if (!products.length) {
      throw Object.assign(new Error('Product not found.'), { status: 404 });
    }

    const defaultPrefix = String(products[0].sku || products[0].name || 'BHMV').replace(/[^a-zA-Z0-9]/g, '').slice(0, 4).toUpperCase();
    const generatedSerials = generateSerialSequence(serialNumber, normalizedCount, defaultPrefix);
    if (
      generatedSerials.length !== normalizedCount ||
      new Set(generatedSerials).size !== normalizedCount ||
      generatedSerials.some(serial => !/^[A-Z0-9-]{1,100}$/.test(serial))
    ) {
      throw Object.assign(new Error('Generated item codes must be unique and contain only letters, numbers, and hyphens.'), { status: 400 });
    }

    // Batch Number
    let cleanBatch = String(batchNumber || '').trim().toUpperCase();
    if (!cleanBatch) {
      const dateStamp = mfg.slice(2, 4) + '/' + mfg.slice(5, 7);
      cleanBatch = `BATCH-${dateStamp}-${generatedSerials[0].slice(-4)}`;
    }

    // Check if batch exists or insert new batch
    let batchId;
    const [existingBatches] = await connection.query(
      'SELECT id, product_id, unit_count FROM product_batches WHERE batch_number = ? FOR UPDATE',
      [cleanBatch]
    );

    if (existingBatches.length > 0) {
      if (Number(existingBatches[0].product_id) !== normalizedProductId) {
        throw Object.assign(new Error('This batch number is already assigned to another product.'), { status: 409 });
      }
      batchId = existingBatches[0].id;
      await connection.query(
        'UPDATE product_batches SET details = ?, manufacture_date = ?, expiry_date = ?, unit_count = unit_count + ? WHERE id = ?',
        [JSON.stringify(normalizedDetails), mfg, exp, normalizedCount, batchId]
      );
    } else {
      const [batchResult] = await connection.query(
        `INSERT INTO product_batches
          (product_id, batch_number, manufacture_date, expiry_date, unit_count, details)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [normalizedProductId, cleanBatch, mfg, exp, normalizedCount, JSON.stringify(normalizedDetails)]
      );
      batchId = batchResult.insertId;
    }

    // Never reassign or reactivate a previously issued item code.
    const insertValues = generatedSerials.map(sn => [normalizedProductId, batchId, sn, 'available', 0]);
    for (let i = 0; i < insertValues.length; i += 500) {
      const chunk = insertValues.slice(i, i + 500);
      try {
        await connection.query(
          'INSERT INTO product_serials (product_id, batch_id, serial_number, status, is_legacy) VALUES ?',
          [chunk]
        );
      } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
          throw Object.assign(new Error('One or more generated item codes already exist. Generate a new code range and try again.'), { status: 409 });
        }
        throw error;
      }
    }

    // Fetch primary serial ID
    const [firstSerialRow] = await connection.query(
      'SELECT id FROM product_serials WHERE serial_number = ? LIMIT 1',
      [generatedSerials[0]]
    );
    const primarySerialId = firstSerialRow[0]?.id || null;

    await connection.commit();

    return {
      id: primarySerialId,
      count: normalizedCount,
      serialNumber: generatedSerials[0],
      serials: generatedSerials,
      productId: normalizedProductId,
      productName: products[0].name,
      sku: products[0].sku,
      batchId,
      batchNumber: cleanBatch,
      manufactureDate: mfg,
      expiryDate: exp,
      bottleSequence: bottleSequence || (normalizedCount > 1 ? `Batch of ${normalizedCount} units` : `Bottle #${generatedSerials[0]}`),
      calibratedPh: calibratedPh || '',
      extractionTemp: extractionTemp || '',
      microbiologicalAssay: microbiologicalAssay || '',
      heavyMetals: heavyMetals || '',
      disclosedActives: disclosedActives || '',
      tamperCustody: tamperCustody || '',
      originLot: originLot || '',
      details: normalizedDetails,
      verificationUrl: `https://bhumivera.com/verify?code=${encodeURIComponent(generatedSerials[0])}`,
    };
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
};

const listGenuinitySerials = async () => {
  const [rows] = await pool.query(`
    SELECT ps.id AS serial_id, ps.serial_number, ps.status, ps.created_at,
           b.id AS batch_id, b.batch_number, b.manufacture_date, b.expiry_date, b.unit_count, b.details,
           p.id AS product_id, p.name AS product_name, p.sku,
           (SELECT pi.file_path FROM product_images pi WHERE pi.product_id = p.id ORDER BY pi.sort_order, pi.id LIMIT 1) AS image
    FROM product_serials ps
    LEFT JOIN product_batches b ON b.id = ps.batch_id
    LEFT JOIN products p ON p.id = ps.product_id
    ORDER BY ps.created_at DESC, ps.id DESC
    LIMIT 1000
  `);

  return rows.map(row => {
    const rawDetails = parseDetails(row.details);
    const findVal = (keywords) => {
      const found = rawDetails.find(d => keywords.some(k => (d.label || '').toLowerCase().includes(k.toLowerCase())));
      return found ? found.value : null;
    };

    return {
      id: row.serial_id,
      serialNumber: row.serial_number,
      status: row.status,
      createdAt: row.created_at,
      productId: row.product_id,
      productName: row.product_name,
      sku: row.sku,
      image: row.image,
      batchId: row.batch_id,
      batchNumber: row.batch_number || 'N/A',
      manufactureDate: row.manufacture_date ? String(row.manufacture_date).slice(0, 10) : '—',
      expiryDate: row.expiry_date ? String(row.expiry_date).slice(0, 10) : '—',
      calibratedPh: findVal(['calibrated ph', 'ph']),
      extractionTemp: findVal(['extraction temp', 'extraction']),
      microbiologicalAssay: findVal(['microbiological', 'microbial']),
      heavyMetals: findVal(['heavy metal', 'metals']),
      disclosedActives: findVal(['active', 'actives', 'disclosed']),
      bottleSequence: findVal(['bottle sequence', 'bottle #', 'sequence']) || `Bottle #${row.serial_id}`,
      details: rawDetails,
      verificationUrl: `https://bhumivera.com/verify?code=${encodeURIComponent(row.serial_number)}`,
    };
  });
};

const deleteGenuinitySerial = async (serialId) => {
  const [rows] = await pool.query('SELECT id, status FROM product_serials WHERE id = ?', [serialId]);
  if (!rows.length) throw Object.assign(new Error('Serial not found.'), { status: 404 });
  if (rows[0].status !== 'available') {
    throw Object.assign(new Error('Sold, registered, or already voided item codes cannot be removed.'), { status: 409 });
  }
  const [result] = await pool.query(
    "UPDATE product_serials SET status = 'voided' WHERE id = ? AND status = 'available'",
    [serialId]
  );
  if (!result.affectedRows) {
    throw Object.assign(new Error('Item code changed during removal. Refresh and try again.'), { status: 409 });
  }
  return { success: true, voided: true };
};

const bulkDeleteGenuinitySerials = async ({ serialIds, deleteAll }) => {
  if (!deleteAll && (!Array.isArray(serialIds) || serialIds.length === 0)) {
    throw Object.assign(new Error('Select at least one serial to delete.'), { status: 400 });
  }
  const cleanIds = deleteAll ? [] : serialIds.map(Number);
  if (!deleteAll && (!cleanIds.length || cleanIds.some(id => !Number.isSafeInteger(id) || id < 1) || new Set(cleanIds).size !== cleanIds.length)) {
    throw Object.assign(new Error('Invalid serial IDs provided.'), { status: 400 });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    if (deleteAll) {
      const [result] = await connection.query(
        "UPDATE product_serials SET status = 'voided' WHERE status = 'available'"
      );
      await connection.commit();
      return { success: true, count: result.affectedRows, voided: true };
    }

    const [rows] = await connection.query(
      `SELECT id, status FROM product_serials WHERE id IN (${cleanIds.map(() => '?').join(',')}) FOR UPDATE`,
      cleanIds
    );
    if (rows.length !== cleanIds.length) {
      throw Object.assign(new Error('One or more selected item codes no longer exist.'), { status: 404 });
    }
    if (rows.some(row => row.status !== 'available')) {
      throw Object.assign(new Error('Sold, registered, or already voided item codes cannot be removed.'), { status: 409 });
    }
    const [result] = await connection.query(
      `UPDATE product_serials SET status = 'voided'
       WHERE status = 'available' AND id IN (${cleanIds.map(() => '?').join(',')})`,
      cleanIds
    );
    if (Number(result.affectedRows) !== cleanIds.length) {
      throw Object.assign(new Error('One or more item codes changed during removal. Refresh and try again.'), { status: 409 });
    }
    await connection.commit();
    return { success: true, count: result.affectedRows, voided: true };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
};

const getPublicProductVerification = async serial => {
  const cleanSerial = String(serial || '').trim().toUpperCase();
  if (!cleanSerial || cleanSerial.length > 255) {
    throw Object.assign(new Error('Enter a valid product code.'), { status: 400 });
  }

  const [rows] = await pool.query(
    `SELECT ps.id AS serial_id, ps.serial_number, ps.status, b.id AS batch_id, b.batch_number,
            b.manufacture_date, b.expiry_date, b.unit_count, b.details,
            p.name AS product_name, p.sku,
            (SELECT pi.file_path FROM product_images pi
             WHERE pi.product_id = p.id ORDER BY pi.sort_order, pi.id LIMIT 1) AS image
     FROM product_serials ps
     LEFT JOIN product_batches b ON b.id = ps.batch_id
     LEFT JOIN products p ON p.id = ps.product_id
     WHERE ps.serial_number = ?
     LIMIT 1`,
    [cleanSerial]
  );

  if (!rows.length) {
    // Check fallback BATCH_COA_REGISTRY
    let catalogRegistry = null;
    try {
      const { BATCH_COA_REGISTRY } = require('../data/luxuryCatalog');
      catalogRegistry = BATCH_COA_REGISTRY;
    } catch {
      catalogRegistry = null;
    }

    if (catalogRegistry && catalogRegistry[cleanSerial]) {
      const coa = catalogRegistry[cleanSerial];
      return {
        verified: true,
        serialNumber: coa.serial,
        productName: coa.productName,
        sku: coa.sku || 'BHMV-MICRO-BATCH',
        image: null,
        batchNumber: coa.batchCode,
        manufactureDate: coa.pressedDate,
        expiryDate: coa.expiryDate || '2028-10-18',
        expired: false,
        batchQuantity: coa.remainingInBatch || 250,
        itemStatus: 'available',
        bottleSequence: coa.bottleSequence,
        calibratedPh: coa.calibratedPh,
        extractionTemp: coa.extractionTemp,
        microbiologicalAssay: coa.microbiologicalAssay,
        heavyMetals: coa.heavyMetals,
        disclosedActives: coa.disclosedActives,
        tamperCustody: coa.tamperCustody,
        originLot: coa.originLot,
        details: [
          { label: 'Bottle Sequence', value: coa.bottleSequence, visible: true },
          { label: 'Calibrated pH Assay', value: coa.calibratedPh, visible: true },
          { label: 'Extraction Temp', value: coa.extractionTemp, visible: true },
          { label: 'Microbiological Assay', value: coa.microbiologicalAssay, visible: true },
          { label: 'Heavy Metal Screen', value: coa.heavyMetals, visible: true },
          { label: 'Disclosed Actives', value: coa.disclosedActives, visible: true },
          { label: 'Tamper Custody', value: coa.tamperCustody, visible: true },
          { label: 'Origin Lot', value: coa.originLot, visible: true },
        ],
        verificationUrl: `https://bhumivera.com/verify?code=${encodeURIComponent(coa.serial)}`
      };
    }
    return null;
  }

  const row = rows[0];
  const today = new Date().toISOString().slice(0, 10);
  const expiryDate = typeof row.expiry_date === 'string'
    ? row.expiry_date.slice(0, 10)
    : row.expiry_date ? new Date(row.expiry_date).toISOString().slice(0, 10) : '';
  const cloudfrontBase = process.env.CLOUDFRONT_BASE_URL || '';
  const image = row.image
    ? (/^https?:\/\//i.test(row.image) || !cloudfrontBase
      ? row.image
      : `${cloudfrontBase.replace(/\/+$/, '')}/${row.image.replace(/^\/+/, '')}`)
    : null;

  const rawDetails = parseDetails(row.details);
  const findVal = (keywords) => {
    const found = rawDetails.find(d => keywords.some(k => (d.label || '').toLowerCase().includes(k.toLowerCase())));
    return found ? found.value : null;
  };

  const bottleSequence = findVal(['bottle sequence', 'bottle #', 'sequence']) || `Bottle #${row.serial_id || 1}`;
  const calibratedPh = findVal(['calibrated ph', 'ph assay', 'ph']);
  const extractionTemp = findVal(['extraction temp', 'extraction', 'temperature']);
  const microbiologicalAssay = findVal(['microbiological', 'microbial', 'aerobic']);
  const heavyMetals = findVal(['heavy metal', 'icp-ms', 'lead', 'arsenic']);
  const disclosedActives = findVal(['disclosed active', 'actives', 'active ingredients', 'composition']);
  const tamperCustody = findVal(['tamper custody', 'custody', 'tamper', 'wax']);
  const originLot = findVal(['origin', 'lot', 'harvest', 'sourcing']);

  return {
    verified: true,
    serialNumber: row.serial_number,
    productName: row.product_name || 'Bhumivera Authentic Product',
    sku: row.sku || '',
    image,
    batchNumber: row.batch_number || 'AUTHENTIC-BATCH',
    manufactureDate: typeof row.manufacture_date === 'string'
      ? row.manufacture_date.slice(0, 10)
      : row.manufacture_date ? new Date(row.manufacture_date).toISOString().slice(0, 10) : today,
    expiryDate,
    expired: expiryDate ? expiryDate < today : false,
    batchQuantity: Number(row.unit_count || 1),
    itemStatus: row.status,
    bottleSequence,
    calibratedPh,
    extractionTemp,
    microbiologicalAssay,
    heavyMetals,
    disclosedActives,
    tamperCustody,
    originLot,
    details: rawDetails.filter(detail => detail.visible !== false),
    verificationUrl: `https://bhumivera.com/verify?code=${encodeURIComponent(row.serial_number)}`,
  };
};

module.exports = {
  MAX_BATCH_SIZE,
  createProductBatch,
  createGenuinitySerialQR,
  listGenuinitySerials,
  deleteGenuinitySerial,
  bulkDeleteGenuinitySerials,
  getProductBatch,
  getPublicProductVerification,
  listProductBatches,
  updateProductBatchDetails,
};
