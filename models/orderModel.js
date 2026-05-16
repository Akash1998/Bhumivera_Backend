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
        status ENUM('pending','confirmed','packed','shipped','delivered','cancelled','returned') DEFAULT 'pending',
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

    // [FIX]: Runtime ENUM Patch - Safely alters existing production tables to prevent 500 crash
    try {
      await pool.query("ALTER TABLE orders MODIFY COLUMN payment_mode ENUM('COD','online','WALLET') DEFAULT 'COD'");
    } catch (enumErr) {
      console.warn("Notice: ENUM payment_mode modifier skipped or already applied.", enumErr.message);
    }

    // 2. Robust Migration Logic
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

    // Add missing columns to orders
    await addCol('orders', 'subtotal', 'DECIMAL(10,2) DEFAULT 0');
    await addCol('orders', 'discount', 'DECIMAL(10,2) DEFAULT 0');
    await addCol('orders', 'total', 'DECIMAL(10,2) DEFAULT 0');
    await addCol('orders', 'coupon_code', 'VARCHAR(100)');
    await addCol('orders', 'payment_status', "ENUM('pending', 'paid', 'failed') DEFAULT 'pending'");
    await addCol('orders', 'payment_id', 'VARCHAR(255)');
    await addCol('orders', 'cancel_reason', 'TEXT');
    await addCol('orders', 'notes', 'TEXT');

    // Add missing columns to order_items
    await addCol('order_items', 'sku', 'VARCHAR(255)');
    await addCol('order_items', 'image', 'TEXT');

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
  notes
}) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    let backendSubtotal = 0;
    const processedItems = [];

    // Step 1: Validate Stock and calculate backend totals
    for (const item of items) {
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

      const unitPrice = (dbProduct.discount_price && dbProduct.discount_price > 0) ? dbProduct.discount_price : dbProduct.price;
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
        image: itemImage
      });
    }

    // Step 3: Finalize Totals
    const safeDiscount = parseFloat(discount || 0);
    const backendTotal = Math.max(0, backendSubtotal - safeDiscount);

    // Step 4: Insert the Order
    const [res] = await conn.query(
      `INSERT INTO orders (user_id, subtotal, discount, total, coupon_code, address_snapshot, delivery_type, payment_mode, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        backendSubtotal,
        safeDiscount,
        backendTotal,
        couponCode || null,
        typeof addressSnapshot === 'string' ? addressSnapshot : JSON.stringify(addressSnapshot),
        deliveryType || 'standard',
        paymentMode || 'COD',
        notes || null
      ]
    );

    const orderId = res.insertId;

    // Step 5: Insert Order Items
    for (const pItem of processedItems) {
      await conn.query(
        `INSERT INTO order_items (order_id, product_id, name, sku, price, quantity, image)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [orderId, pItem.product_id, pItem.name, pItem.sku, pItem.price, pItem.quantity, pItem.image]
      );
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
  const [orders] = await pool.query('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC', [userId]);
  for (const o of orders) {
    const [items] = await pool.query('SELECT * FROM order_items WHERE order_id = ?', [o.id]);
    o.items = items;
  }
  return orders.map(parseOrder);
};

const getAllOrders = async (filters = {}) => {
  let sql = 'SELECT o.*, u.name as user_name, u.email as user_email FROM orders o LEFT JOIN users u ON o.user_id = u.id';
  let params = [];
  
  if (filters.status) {
    sql += ' WHERE o.status = ?';
    params.push(filters.status);
  }
  
  sql += ' ORDER BY o.created_at DESC';
  
  const [orders] = await pool.query(sql, params);
  for (const o of orders) {
    const [items] = await pool.query('SELECT * FROM order_items WHERE order_id = ?', [o.id]);
    o.items = items;
  }
  return orders.map(parseOrder);
};

const getOrderById = async (orderId) => {
  const [orders] = await pool.query('SELECT o.*, u.name as user_name, u.email as user_email FROM orders o LEFT JOIN users u ON o.user_id = u.id WHERE o.id = ?', [orderId]);
  if (orders.length === 0) return null;
  const o = orders[0];
  const [items] = await pool.query('SELECT * FROM order_items WHERE order_id = ?', [o.id]);
  o.items = items;
  return parseOrder(o);
};

const updateOrderStatus = async (orderId, status, cancelReason) => {
  if (status === 'cancelled' || status === 'returned') {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      if (cancelReason) {
        await conn.query('UPDATE orders SET status=?, cancel_reason=? WHERE id=?', [status, cancelReason, orderId]);
      } else {
        await conn.query('UPDATE orders SET status=? WHERE id=?', [status, orderId]);
      }

      const [items] = await conn.query('SELECT product_id, quantity FROM order_items WHERE order_id = ?', [orderId]);
      for (const item of items) {
        if (item.product_id) {
          await conn.query('UPDATE products SET quantity = quantity + ? WHERE id = ?', [item.quantity, item.product_id]);
        }
      }

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } else {
    await pool.query('UPDATE orders SET status=? WHERE id=?', [status, orderId]);
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
