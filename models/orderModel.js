const pool = require('../config/db');

const createOrdersTables = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        address_snapshot JSON NOT NULL,
        delivery_type ENUM('standard','express') DEFAULT 'standard',
        payment_mode ENUM('COD','online','WALLET') DEFAULT 'COD',
        status ENUM('pending','confirmed','packed','shipped','delivered','cancelled','returned','archived') DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS order_items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        order_id INT NOT NULL,
        product_id INT,
        name VARCHAR(255) NOT NULL,
        price DECIMAL(10,2) NOT NULL,
        quantity INT NOT NULL,
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
      )
    `);

    try {
      await pool.query("ALTER TABLE orders MODIFY COLUMN payment_mode ENUM('COD','online','WALLET') DEFAULT 'COD'");
    } catch (enumErr) {
      console.warn("Notice: ENUM payment_mode modifier skipped or already applied.", enumErr.message);
    }
    try {
      await pool.query("ALTER TABLE orders MODIFY COLUMN status ENUM('pending','confirmed','packed','shipped','delivered','cancelled','returned','archived') DEFAULT 'pending'");
    } catch (enumErr) {
      console.warn("Notice: ENUM status modifier skipped or already applied.", enumErr.message);
    }

    const addCol = async (table, column, definition) => {
      try {
        const [cols] = await pool.query(`SHOW COLUMNS FROM \`${table}\` LIKE '${column}'`);
        if (cols.length === 0) {
          await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
          console.log(`Added ${column} to ${table}`);
        }
      } catch (err) {
        console.error(`Error adding ${column} to ${table}:`, err.message);
      }
    };

    const addIndex = async (table, indexName, columns) => {
      try {
        const [idx] = await pool.query(`SHOW INDEX FROM \`${table}\` WHERE Key_name = ?`, [indexName]);
        if (idx.length === 0) {
          await pool.query(`CREATE INDEX \`${indexName}\` ON \`${table}\` (${columns})`);
          console.log(`Added index ${indexName} on ${table}`);
        }
      } catch (err) {
        console.warn(`Index ${indexName} on ${table} warning:`, err.message);
      }
    };

    await addCol('orders', 'subtotal', 'DECIMAL(10,2) DEFAULT 0');
    await addCol('orders', 'discount', 'DECIMAL(10,2) DEFAULT 0');
    await addCol('orders', 'shipping_cost', 'DECIMAL(10,2) NOT NULL DEFAULT 0');
    await addCol('orders', 'impact_amount', 'DECIMAL(10,2) NOT NULL DEFAULT 0');
    await addCol('orders', 'impact_project', 'VARCHAR(50) DEFAULT NULL');
    await addCol('orders', 'loyalty_points_awarded', 'INT NOT NULL DEFAULT 0');
    await addCol('orders', 'loyalty_points_redeemed', 'INT NOT NULL DEFAULT 0');
    await addCol('orders', 'total', 'DECIMAL(10,2) DEFAULT 0');
    await addCol('orders', 'coupon_code', 'VARCHAR(100)');
    await addCol('orders', 'payment_status', "ENUM('pending', 'paid', 'failed') DEFAULT 'pending'");
    await addCol('orders', 'payment_id', 'VARCHAR(255)');
    await addCol('orders', 'cancel_reason', 'TEXT');
    await addCol('orders', 'notes', 'TEXT');
    await addCol('orders', 'tracking_number', 'VARCHAR(255)');
    await addCol('orders', 'courier', 'VARCHAR(255)');

    await addCol('order_items', 'sku', 'VARCHAR(255)');
    await addCol('order_items', 'image', 'TEXT');
    await addCol('order_items', 'is_gift', 'TINYINT(1) NOT NULL DEFAULT 0');

    await addIndex('orders', 'idx_orders_created_at', 'created_at DESC');
    await addIndex('orders', 'idx_orders_status', 'status');
    await addIndex('orders', 'idx_orders_user_created', 'user_id, created_at DESC');
    await addIndex('order_items', 'idx_order_items_order_id', 'order_id');
    await addIndex('order_items', 'idx_order_items_product_id', 'product_id');

  } catch (err) {
    console.error("Order Table Creation Error:", err);
  }
};

const createOrder = async ({
  userId,
  items,
  subtotal,
  discount,
  total,
  couponCode,
  addressSnapshot,
  deliveryType,
  paymentMode,
  notes,
  shippingCost = 0,
  impactAmount = 0,
  impactProject = null,
  couponId = null,
  loyaltyPointsAwarded = 0,
  lifecycleGiftProductId = null,
  loyaltyPointsToRedeem = 0,
  loyaltyPointsPerRupee = 10
}) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    if (couponId) {
      const [usage] = await conn.query(
        `UPDATE coupons SET used_count = used_count + 1
         WHERE id = ? AND is_active = 1
           AND (valid_from IS NULL OR valid_from <= NOW())
           AND (expires_at IS NULL OR expires_at >= NOW())
           AND (usage_limit IS NULL OR used_count < usage_limit)`,
        [couponId]
      );
      if (usage.affectedRows !== 1) {
        throw Object.assign(new Error('This coupon has already been used or has expired.'), { status: 409 });
      }
    }

    let backendSubtotal = 0;
    const processedItems = [];
    const orderItems = Array.isArray(items) ? items.slice() : [];

    const [userRows] = await conn.query('SELECT pending_lifecycle_gift_product_id, loyalty_points FROM users WHERE id = ? FOR UPDATE', [userId]);
    const pendingGiftProductId = userRows?.[0]?.pending_lifecycle_gift_product_id;
    if (pendingGiftProductId) {
      orderItems.push({ product_id: pendingGiftProductId, quantity: 1, is_gift: true, lifecycle_gift: true });
      await conn.query('UPDATE users SET pending_lifecycle_gift_product_id = NULL WHERE id = ?', [userId]);
    }

    // Step 1: Validate Stock and calculate backend totals
    for (const item of orderItems) {
      const productId = item.product_id || item.id;
      const [dbProducts] = await conn.query(
        'SELECT name, sku, price, discount_price, quantity FROM products WHERE id = ? FOR UPDATE',
        [productId]
      );
      const dbProduct = dbProducts[0];

      if (!dbProduct) throw new Error(`Product ID ${productId} not found.`);

      const requestedQty = parseInt(item.quantity || 1, 10);
      if (dbProduct.quantity < requestedQty) {
        throw new Error(`Insufficient stock for ${dbProduct.name}. Only ${dbProduct.quantity} left.`);
      }

      const isGift = item.is_gift === true || Number(item.is_gift) === 1;
      const unitPrice = isGift ? 0 : (dbProduct.discount_price && dbProduct.discount_price > 0) ? dbProduct.discount_price : dbProduct.price;
      backendSubtotal += (unitPrice * requestedQty);

      // Step 2: Deduct Inventory
      await conn.query('UPDATE products SET quantity = quantity - ? WHERE id = ?', [requestedQty, productId]);

      // Handle image
      let itemImage = item.image || (Array.isArray(item.images) ? item.images[0] : null);

      processedItems.push({
        product_id: productId,
        name: dbProduct.name,
        sku: dbProduct.sku,
        price: unitPrice,
        quantity: requestedQty,
        image: itemImage,
        is_gift: isGift ? 1 : 0
      });
    }

    // Step 3: Finalize Totals
    const safeDiscount = Math.min(backendSubtotal, Math.max(0, parseFloat(discount) || 0));
    const safeShippingCost = Math.max(0, parseFloat(shippingCost) || 0);
    const safeImpactAmount = Math.max(0, Math.min(500, Number(impactAmount) || 0));
    const safeLoyaltyPoints = Math.max(0, Math.trunc(Number(loyaltyPointsAwarded) || 0));
    const pointsPerRupee = Math.max(1, Math.trunc(Number(loyaltyPointsPerRupee) || 10));
    const pointsAvailable = Math.max(0, Math.trunc(Number(userRows?.[0]?.loyalty_points) || 0));
    const requestedPoints = Math.max(0, Math.trunc(Number(loyaltyPointsToRedeem) || 0));
    const maxAffordablePoints = Math.floor(Math.max(0, backendSubtotal - safeDiscount + safeShippingCost) * pointsPerRupee);
    const pointsRedeemed = Math.min(requestedPoints, pointsAvailable, maxAffordablePoints);
    const loyaltyDiscount = pointsRedeemed / pointsPerRupee;
    const backendTotal = Math.max(0, backendSubtotal - safeDiscount + safeShippingCost - loyaltyDiscount + safeImpactAmount);
    if (pointsRedeemed > 0) {
      await conn.query('UPDATE users SET loyalty_points = loyalty_points - ? WHERE id = ? AND loyalty_points >= ?', [pointsRedeemed, userId, pointsRedeemed]);
    }

    // Step 4: Insert the Order
    const [res] = await conn.query(
      `INSERT INTO orders (user_id, subtotal, discount, shipping_cost, impact_amount, impact_project, loyalty_points_awarded, loyalty_points_redeemed, total, coupon_code, address_snapshot, delivery_type, payment_mode, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        backendSubtotal,
        safeDiscount,
        safeShippingCost,
        safeImpactAmount,
        safeImpactAmount > 0 ? impactProject : null,
        safeLoyaltyPoints,
        pointsRedeemed,
        backendTotal,
        couponCode || null,
        typeof addressSnapshot === 'string' ? addressSnapshot : JSON.stringify(addressSnapshot),
        deliveryType || 'standard',
        paymentMode || 'COD',
        notes || null
      ]
    );

    const orderId = res.insertId;

    if (safeImpactAmount > 0) {
      await conn.query(
        `INSERT INTO impact_contributions (order_id, user_id, project_key, amount, status)
         VALUES (?, ?, ?, ?, 'pledged')`,
        [orderId, userId, impactProject, safeImpactAmount]
      );
    }

    // Step 5: Insert Order Items
    for (const pItem of processedItems) {
      await conn.query(
        `INSERT INTO order_items (order_id, product_id, name, sku, price, quantity, image, is_gift)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [orderId, pItem.product_id, pItem.name, pItem.sku, pItem.price, pItem.quantity, pItem.image, pItem.is_gift]
      );
    }

    if (lifecycleGiftProductId) {
      const [[orderCount]] = await conn.query('SELECT COUNT(*) AS order_count FROM orders WHERE user_id = ?', [userId]);
      if (Number(orderCount?.order_count) === 3) {
        await conn.query(
          'UPDATE users SET pending_lifecycle_gift_product_id = ? WHERE id = ? AND pending_lifecycle_gift_product_id IS NULL',
          [lifecycleGiftProductId, userId]
        );
      }
    }

    await conn.commit();
    return orderId;
  } catch (e) {
    await conn.rollback();
    console.error("createOrder Error:", e);
    throw e;
  } finally {
    conn.release();
  }
};

const parseOrder = (o) => {
  if (!o) return null;
  try {
    return {
      ...o,
      address_snapshot: typeof o.address_snapshot === 'string' 
        ? JSON.parse(o.address_snapshot) 
        : o.address_snapshot,
    };
  } catch (e) {
    console.error("Error parsing address_snapshot:", e);
    return o;
  }
};

const getOrdersByUser = async (userId) => {
  if (userId === null || userId === undefined || userId === '') return [];
  const [orders] = await pool.query('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC', [userId]);
  const safeOrders = Array.isArray(orders) ? orders.filter(order => order && typeof order === 'object') : [];
  for (const order of safeOrders) {
    const orderId = order.id ?? order.order_id;
    if (orderId === null || orderId === undefined) {
      order.items = [];
      continue;
    }
    const [items] = await pool.query(
      `SELECT oi.*,
        COALESCE(
          oi.image,
          (SELECT pi.file_path FROM product_images pi
           WHERE pi.product_id = oi.product_id AND pi.media_type = 'image'
           ORDER BY pi.sort_order ASC, pi.id ASC LIMIT 1)
        ) AS image
       FROM order_items oi
       WHERE oi.order_id = ?`,
      [orderId]
    );
    order.items = Array.isArray(items) ? items.filter(Boolean) : [];
  }
  return safeOrders.map(parseOrder);
};

const getAllOrders = async (filters = {}) => {
  let whereClauses = [];
  let params = [];

  if (filters.status && filters.status !== 'all') {
    whereClauses.push('o.status = ?');
    params.push(filters.status);
  }

  if (filters.search) {
    whereClauses.push('(u.name LIKE ? OR u.email LIKE ? OR o.id = ? OR o.courier LIKE ? OR o.tracking_number LIKE ?)');
    const searchVal = `%${filters.search}%`;
    params.push(searchVal, searchVal, isNaN(parseInt(filters.search)) ? 0 : parseInt(filters.search), searchVal, searchVal);
  }

  let whereSql = '';
  if (whereClauses.length > 0) {
    whereSql = ' WHERE ' + whereClauses.join(' AND ');
  }

  const countSql = `SELECT COUNT(*) as total FROM orders o LEFT JOIN users u ON o.user_id = u.id ${whereSql}`;
  const [[countRow]] = await pool.query(countSql, params);
  const total = countRow ? countRow.total : 0;
  const [[summaryRow]] = await pool.query(`
    SELECT COUNT(*) AS totalOrders,
           COALESCE(SUM(CASE WHEN status NOT IN ('cancelled', 'returned') THEN total ELSE 0 END), 0) AS grossRevenue,
           SUM(CASE WHEN status IN ('pending', 'confirmed', 'packed') THEN 1 ELSE 0 END) AS actionRequired,
           SUM(CASE WHEN status = 'shipped' THEN 1 ELSE 0 END) AS inTransit,
           SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS completed
    FROM orders
  `);

  const page = Math.max(1, parseInt(filters.page) || 1);
  const limit = Math.max(1, Math.min(200, parseInt(filters.limit) || 50));
  const offset = (page - 1) * limit;

  let orderSql = `SELECT o.*, u.name as user_name, u.email as user_email FROM orders o LEFT JOIN users u ON o.user_id = u.id ${whereSql} ORDER BY o.created_at DESC LIMIT ? OFFSET ?`;
  const queryParams = [...params, limit, offset];

  const [orders] = await pool.query(orderSql, queryParams);

  const orderIds = orders.map(o => o.id);
  let itemsMap = {};
  if (orderIds.length > 0) {
    const placeholders = orderIds.map(() => '?').join(',');
    const [allItems] = await pool.query(`SELECT * FROM order_items WHERE order_id IN (${placeholders})`, orderIds);
    for (const it of allItems) {
      if (!itemsMap[it.order_id]) itemsMap[it.order_id] = [];
      itemsMap[it.order_id].push(it);
    }
  }

  const parsed = orders.map(o => ({
    ...parseOrder(o),
    items: itemsMap[o.id] || []
  }));

  return {
    orders: parsed,
    summary: summaryRow,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit)
    }
  };
};

const getOrderById = async (orderId) => {
  const [orders] = await pool.query('SELECT o.*, u.name as user_name, u.email as user_email FROM orders o LEFT JOIN users u ON o.user_id = u.id WHERE o.id = ?', [orderId]);
  if (orders.length === 0) return null;
  const o = orders[0];
  const [items] = await pool.query('SELECT * FROM order_items WHERE order_id = ?', [o.id]);
  o.items = items;
  if (Number(o.impact_amount) > 0) {
    const [[impact]] = await pool.query(
      'SELECT project_key, amount, status FROM impact_contributions WHERE order_id = ?',
      [o.id]
    );
    if (impact) {
      o.impact_project = impact.project_key;
      o.impact_amount = impact.amount;
      o.impact_status = impact.status;
    }
  }
  return parseOrder(o);
};

const updateOrderStatus = async (orderId, status, cancelReason, metadata = {}) => {
  const validStatuses = ['pending', 'confirmed', 'packed', 'shipped', 'delivered', 'cancelled', 'returned', 'archived'];
  const statusRank = { pending: 0, confirmed: 1, packed: 2, shipped: 3, delivered: 4, cancelled: 5, returned: 5, archived: 6 };
  if (!validStatuses.includes(status)) throw { status: 400, message: 'Invalid order status.' };

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [orders] = await conn.query(
      'SELECT user_id, status, loyalty_points_awarded FROM orders WHERE id = ? FOR UPDATE',
      [orderId]
    );
    const order = orders?.[0];
    if (!order) {
      await conn.rollback();
      return false;
    }
    if (statusRank[status] < statusRank[order.status]) {
      await conn.rollback();
      throw { status: 400, message: `Order cannot move backward from ${order.status} to ${status}.` };
    }

    if (status === 'confirmed' && order.status === 'pending') {
      const points = Math.max(0, Math.trunc(Number(order.loyalty_points_awarded) || 0));
      if (points > 0) await conn.query('UPDATE users SET loyalty_points = loyalty_points + ? WHERE id = ?', [points, order.user_id]);
    }

    const alreadyRestocked = ['cancelled', 'returned'].includes(order.status);
    if (['cancelled', 'returned'].includes(status) && !alreadyRestocked) {
      const [items] = await conn.query('SELECT product_id, quantity FROM order_items WHERE order_id = ?', [orderId]);
      for (const item of items) {
        if (item.product_id) {
          await conn.query('UPDATE products SET quantity = quantity + ? WHERE id = ?', [item.quantity, item.product_id]);
        }
      }
      await conn.query(
        "UPDATE impact_contributions SET status = 'cancelled' WHERE order_id = ? AND status = 'pledged'",
        [orderId]
      );
    }

    await conn.query(
      `UPDATE orders SET status = ?, cancel_reason = COALESCE(?, cancel_reason),
       tracking_number = COALESCE(?, tracking_number), courier = COALESCE(?, courier) WHERE id = ?`,
      [status, cancelReason || null, metadata.trackingNumber || null, metadata.courier || null, orderId]
    );
    await conn.commit();
    return true;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
};

const updatePaymentStatus = async (orderId, paymentStatus, paymentId) => {
  await pool.query(
    'UPDATE orders SET payment_status=?, payment_id=? WHERE id=?',
    [paymentStatus, paymentId || null, orderId]
  );
};

module.exports = {
  createOrder,
  getOrdersByUser,
  getAllOrders,
  getOrderById,
  updateOrderStatus,
  updatePaymentStatus,
  createOrdersTables,
};
